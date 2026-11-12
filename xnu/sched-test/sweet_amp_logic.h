/*
 * sweet_amp v2: pure decision logic for the SDM845 big.LITTLE placement
 * (4x Cortex-A55 "LITTLE" = CPU0-3, 4x Cortex-A75 "BIG" = CPU4-7).
 *
 * Nothing here depends on XNU: only <stdint.h>/<stdbool.h>, so tools/sweet-amp-test.c
 * (host gcc) runs the very same code that osfmk/kern/sched_prim.c includes. All state
 * lives in the caller; every function is a pure function of its arguments.
 *
 * Concepts (re-implemented from understanding, no code taken from other kernels):
 *  - capacity: how much work a core class does relative to the fastest, 1024 = A75 at
 *    its top frequency. A55 is about 385/1024 (DMIPS/MHz 611 vs 1024 at 1.77 vs 2.80 GHz).
 *  - utilisation: busy fraction of the thread, scaled by the capacity of the core it ran
 *    on, so "100% busy on an A55" means 385, not 1024 (capacity invariance).
 *  - "fits": a thread fits a core class when its utilisation plus a 25% margin is below
 *    the class capacity. A thread that does not fit LITTLE is a misfit and wants BIG.
 *  - per-QoS floor/ceiling (utilisation clamps): interactive QoS never counts as small,
 *    background QoS never counts as big.
 *  - hysteresis: a thread already on BIG only goes back to LITTLE when it is clearly
 *    small (x1.6 margin instead of x1.25).
 *  - active migration is rate limited per thread with an exponentially growing dwell
 *    time (ping-pong guard).
 *
 * Units: utilisation in 0..1024 capacity units, time in microseconds.
 */
#ifndef _KERN_SWEET_AMP_LOGIC_H_
#define _KERN_SWEET_AMP_LOGIC_H_

#include <stdint.h>
#include <stdbool.h>

#define SWAMP_CLASS_ANY         0
#define SWAMP_CLASS_LITTLE      1
#define SWAMP_CLASS_BIG         2

/* Effective QoS values, as THREAD_QOS_* in mach/thread_policy.h. */
#define SWAMP_QOS_UNSPECIFIED   0
#define SWAMP_QOS_MAINTENANCE   1
#define SWAMP_QOS_BACKGROUND    2
#define SWAMP_QOS_UTILITY       3
#define SWAMP_QOS_LEGACY        4       /* "default" */
#define SWAMP_QOS_USER_INIT     5
#define SWAMP_QOS_USER_INTER    6

#define SWAMP_CAP_LITTLE        385u
#define SWAMP_CAP_BIG           1024u

#define SWAMP_FLOOR_USER_INTER  600u    /* > little capacity: always a misfit on LITTLE */
#define SWAMP_FLOOR_USER_INIT   500u
#define SWAMP_CEIL_LITTLE_ONLY  230u    /* x1.6 = 368 < 385: fits LITTLE even with the BIG->LITTLE hysteresis */

#define SWAMP_BURST_US          12000u  /* on-core this long without blocking = saturated */
#define SWAMP_MIN_RUN_US        2000u   /* do not move a thread that only just got on core */
#define SWAMP_DWELL_BASE_US     40000u
#define SWAMP_DWELL_MAX_SHIFT   4u      /* 40 ms .. 640 ms */
#define SWAMP_VICTIM_MARGIN     8       /* sched_pri points a big-core thread must be below */

enum swamp_move {
	SWAMP_MOVE_NONE = 0,
	SWAMP_MOVE_HELD,        /* wants to move, rate limit says not yet */
	SWAMP_MOVE_UP_IDLE,     /* LITTLE -> BIG, an idle BIG core exists */
	SWAMP_MOVE_UP_PREEMPT,  /* LITTLE -> BIG, a much lower priority thread runs on a BIG core */
	SWAMP_MOVE_DOWN_IDLE,   /* BIG -> LITTLE, an idle LITTLE core exists */
	SWAMP_MOVE_MISFIT_WAIT  /* wants BIG, no BIG core available right now */
};

struct swamp_thread_in {
	uint32_t qos;           /* effective QoS 0..6 */
	bool     kernel_task;   /* thread of kernel_task */
	bool     ui_task;       /* task role foreground / control (SpringBoard) / graphics server (backboardd) */
	bool     bg_task;       /* task role background / throttle / darwinbg */
	uint32_t util_permille; /* time based busy fraction, 0..1000 (see swamp_util_permille) */
	uint32_t ran_us;        /* continuous on-core time right now, 0 when the thread is waking */
	int      cur_class;     /* class of the core it ran on / runs on (LITTLE or BIG) */
};

/* Read-only counters (sysctl kern.sweet_amp). Updated with relaxed atomics by the scheduler. */
struct swamp_stats {
	uint64_t place[2][2];   /* [wanted BIG][placed on BIG] at thread_setrun */
	uint64_t rt_big, rt_little;
	uint64_t victim;        /* wake preempted a lower priority thread on a BIG core */
	uint64_t hidden;        /* idle BIG cores hidden from a low class thread (reserve) */
	uint64_t mig_up_idle, mig_up_preempt, mig_down, mig_held;
	uint64_t misfit_marks, kicks;
};

static inline uint32_t
swamp_capacity(int cls)
{
	return cls == SWAMP_CLASS_BIG ? SWAMP_CAP_BIG : SWAMP_CAP_LITTLE;
}

/*
 * Busy fraction (permille) from XNU's thread->cpu_usage. cpu_usage is the run time of the
 * thread aged by 5/8 every scheduler tick (sched_tick_interval mach ticks, 125 ms), i.e. a
 * geometric moving average with a half life of 1.5 ticks; a thread that is always running
 * converges to 5/3 tick intervals, which is the 3/5 correction thread_info() also applies.
 */
static inline uint32_t
swamp_util_permille(uint64_t cpu_usage, uint64_t tick_interval)
{
	uint64_t u;
	if (tick_interval == 0) {
		return 0;
	}
	u = (cpu_usage * 1000u / tick_interval) * 3u / 5u;
	return u > 1000u ? 1000u : (uint32_t)u;
}

/* Fits with a 25% margin: util * 1.25 < cap. */
static inline bool
swamp_fits(uint32_t util, uint32_t cap)
{
	return (uint64_t)util * 5u < (uint64_t)cap * 4u;
}

/* Hysteresis for leaving BIG: util * 1.6 < cap. */
static inline bool
swamp_fits_down(uint32_t util, uint32_t cap)
{
	return (uint64_t)util * 8u < (uint64_t)cap * 5u;
}

static inline uint32_t
swamp_qos_floor(uint32_t qos)
{
	if (qos == SWAMP_QOS_USER_INTER) {
		return SWAMP_FLOOR_USER_INTER;
	}
	if (qos == SWAMP_QOS_USER_INIT) {
		return SWAMP_FLOOR_USER_INIT;
	}
	return 0;
}

static inline uint32_t
swamp_qos_ceiling(uint32_t qos, bool bg_task)
{
	if (bg_task || (qos >= SWAMP_QOS_MAINTENANCE && qos <= SWAMP_QOS_BACKGROUND)) {
		return SWAMP_CEIL_LITTLE_ONLY;
	}
	return SWAMP_CAP_BIG;
}

/* Capacity invariant, clamped utilisation estimate (0..1024). */
static inline uint32_t
swamp_effective_util(const struct swamp_thread_in *in)
{
	uint32_t cap = swamp_capacity(in->cur_class);
	uint32_t util = (uint32_t)(((uint64_t)in->util_permille * cap) / 1000u);
	uint32_t floor_u, ceil_u;

	if (in->ran_us != 0) {
		/* Running without blocking: that is saturation right now, whatever the average says. */
		uint32_t burst = in->ran_us >= SWAMP_BURST_US ? cap :
		    (uint32_t)(((uint64_t)in->ran_us * cap) / SWAMP_BURST_US);
		if (burst > util) {
			util = burst;
		}
	}
	if (in->ui_task && !in->bg_task && in->qos != SWAMP_QOS_BACKGROUND && in->qos != SWAMP_QOS_MAINTENANCE) {
		util += util / 4;       /* foreground app / SpringBoard / backboardd: lean towards BIG */
	}
	floor_u = swamp_qos_floor(in->qos);
	ceil_u = swamp_qos_ceiling(in->qos, in->bg_task);
	if (util < floor_u) {
		util = floor_u;
	}
	if (util > ceil_u) {
		util = ceil_u;
	}
	return util > SWAMP_CAP_BIG ? SWAMP_CAP_BIG : util;
}

/* Core class this (non realtime) thread should run on. */
static inline int
swamp_wanted_class(const struct swamp_thread_in *in)
{
	uint32_t util;
	if (in->kernel_task) {
		return SWAMP_CLASS_LITTLE;
	}
	util = swamp_effective_util(in);
	if (in->cur_class == SWAMP_CLASS_BIG) {
		return swamp_fits_down(util, SWAMP_CAP_LITTLE) ? SWAMP_CLASS_LITTLE : SWAMP_CLASS_BIG;
	}
	return swamp_fits(util, SWAMP_CAP_LITTLE) ? SWAMP_CLASS_LITTLE : SWAMP_CLASS_BIG;
}

/* Realtime user threads (render server, audio, ...) prefer BIG, kernel ones have no preference. */
static inline int
swamp_rt_class(bool kernel_task)
{
	return kernel_task ? SWAMP_CLASS_ANY : SWAMP_CLASS_BIG;
}

/* Low classes may not take the last `reserve` idle BIG cores (kept free for UI bursts). */
static inline bool
swamp_low_class(uint32_t qos, bool bg_task, bool kernel_task)
{
	if (kernel_task) {
		return false;
	}
	return bg_task || (qos >= SWAMP_QOS_MAINTENANCE && qos <= SWAMP_QOS_UTILITY);
}

static inline bool
swamp_hide_idle_big(bool low_class, uint32_t idle_big, uint32_t reserve)
{
	return low_class && idle_big != 0 && idle_big <= reserve;
}

static inline uint64_t
swamp_dwell_us(uint32_t flips)
{
	if (flips > SWAMP_DWELL_MAX_SHIFT) {
		flips = SWAMP_DWELL_MAX_SHIFT;
	}
	return (uint64_t)SWAMP_DWELL_BASE_US << flips;
}

/* Flip counter after a move: grows while moves come in quick succession, resets when calm. */
static inline uint32_t
swamp_next_flips(uint32_t flips, uint64_t since_last_us)
{
	if (since_last_us < 4u * swamp_dwell_us(flips)) {
		return flips < SWAMP_DWELL_MAX_SHIFT ? flips + 1 : flips;
	}
	return 0;
}

/*
 * Should the running thread leave the core it is on? since_last_us is the time since its
 * previous move (use UINT64_MAX if it never moved).
 */
static inline enum swamp_move
swamp_move_decision(int wanted, int cur, bool idle_right, bool victim_right,
    uint32_t ran_us, uint64_t since_last_us, uint32_t flips)
{
	if (wanted == SWAMP_CLASS_ANY || wanted == cur) {
		return SWAMP_MOVE_NONE;
	}
	if (ran_us < SWAMP_MIN_RUN_US) {
		return SWAMP_MOVE_NONE;
	}
	if (since_last_us < swamp_dwell_us(flips)) {
		return SWAMP_MOVE_HELD;
	}
	if (cur == SWAMP_CLASS_LITTLE) {
		if (idle_right) {
			return SWAMP_MOVE_UP_IDLE;
		}
		if (victim_right) {
			return SWAMP_MOVE_UP_PREEMPT;
		}
		return SWAMP_MOVE_MISFIT_WAIT;
	}
	return idle_right ? SWAMP_MOVE_DOWN_IDLE : SWAMP_MOVE_NONE;
}

#endif /* _KERN_SWEET_AMP_LOGIC_H_ */
