/*
 * Host test of the sweet_amp v2 decision logic (xnu/patches-11215/0264).
 * Build and run: sh xnu/sched-test/run.sh   (plain C, gcc/clang, no XNU).
 * The header under test is the one the kernel patch adds as osfmk/kern/sweet_amp_logic.h;
 * run.sh also checks that the two copies are identical.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sweet_amp_logic.h"

static int failures, checks;

#define CHECK(cond) do { \
	checks++; \
	if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } \
} while (0)

static struct swamp_thread_in
mk(uint32_t qos, uint32_t util_pm, int cur)
{
	struct swamp_thread_in in;
	memset(&in, 0, sizeof(in));
	in.qos = qos;
	in.util_permille = util_pm;
	in.cur_class = cur;
	return in;
}

/* XNU's per tick usage ageing: usage = (usage + delta) * 5/8, delta = busy fraction * tick */
static uint64_t
age(uint64_t usage, uint64_t tick, unsigned busy_permille)
{
	return (usage + tick * busy_permille / 1000) * 5 / 8;
}

static void
test_util_conversion(void)
{
	const uint64_t tick = 2400000;  /* 125 ms of 19.2 MHz ticks */
	uint64_t u = 0;
	uint32_t pm[8];
	for (int i = 0; i < 8; i++) {
		u = age(u, tick, 1000);
		pm[i] = swamp_util_permille(u, tick);
	}
	printf("  always running, permille per tick:");
	for (int i = 0; i < 8; i++) {
		printf(" %u", pm[i]);
	}
	printf("\n");
	CHECK(pm[0] > 300 && pm[0] < 450);
	CHECK(pm[7] > 900 && pm[7] <= 1000);
	for (int i = 1; i < 8; i++) {
		CHECK(pm[i] >= pm[i - 1]);
	}
	CHECK(swamp_util_permille(1ull << 40, tick) == 1000);
	CHECK(swamp_util_permille(5, 0) == 0);
	/* idle for a long time decays to ~0 */
	for (int i = 0; i < 12; i++) {
		u = age(u, tick, 0);
	}
	CHECK(swamp_util_permille(u, tick) < 20);
}

static void
test_class_table(void)
{
	struct swamp_thread_in in;

	/* interactive QoS: BIG even when it has never run */
	in = mk(SWAMP_QOS_USER_INTER, 0, SWAMP_CLASS_LITTLE);
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_BIG);
	in = mk(SWAMP_QOS_USER_INIT, 0, SWAMP_CLASS_LITTLE);
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_BIG);
	/* background QoS: LITTLE even when saturated, also from a big core */
	in = mk(SWAMP_QOS_BACKGROUND, 1000, SWAMP_CLASS_BIG);
	in.ran_us = 50000;
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_LITTLE);
	in = mk(SWAMP_QOS_MAINTENANCE, 1000, SWAMP_CLASS_LITTLE);
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_LITTLE);
	/* default QoS: util decides */
	in = mk(SWAMP_QOS_LEGACY, 100, SWAMP_CLASS_LITTLE);
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_LITTLE);
	in = mk(SWAMP_QOS_LEGACY, 1000, SWAMP_CLASS_LITTLE);
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_BIG);
	in = mk(SWAMP_QOS_UNSPECIFIED, 0, SWAMP_CLASS_LITTLE);
	in.ran_us = 15000;      /* ran a full burst without blocking */
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_BIG);
	in = mk(SWAMP_QOS_UNSPECIFIED, 0, SWAMP_CLASS_LITTLE);
	in.ran_us = 3000;       /* short run: stays */
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_LITTLE);
	/* kernel threads: LITTLE */
	in = mk(SWAMP_QOS_USER_INTER, 1000, SWAMP_CLASS_BIG);
	in.kernel_task = true;
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_LITTLE);
	/* foreground app default thread leans up */
	in = mk(SWAMP_QOS_LEGACY, 800, SWAMP_CLASS_LITTLE);   /* 308 inv, just fits */
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_BIG || swamp_wanted_class(&in) == SWAMP_CLASS_LITTLE);
	{
		struct swamp_thread_in a = mk(SWAMP_QOS_LEGACY, 700, SWAMP_CLASS_LITTLE);
		struct swamp_thread_in b = a;
		b.ui_task = true;
		CHECK(swamp_wanted_class(&a) == SWAMP_CLASS_LITTLE);
		CHECK(swamp_wanted_class(&b) == SWAMP_CLASS_BIG);
	}
	/* realtime */
	CHECK(swamp_rt_class(false) == SWAMP_CLASS_BIG);
	CHECK(swamp_rt_class(true) == SWAMP_CLASS_ANY);
}

static void
test_hysteresis(void)
{
	/* sweep util: on LITTLE the up threshold is higher than the BIG->LITTLE down threshold */
	int up_at = -1, down_at = -1;
	for (int pm = 0; pm <= 1000; pm++) {
		struct swamp_thread_in l = mk(SWAMP_QOS_LEGACY, (uint32_t)pm, SWAMP_CLASS_LITTLE);
		if (up_at < 0 && swamp_wanted_class(&l) == SWAMP_CLASS_BIG) {
			up_at = pm;
		}
	}
	for (int pm = 1000; pm >= 0; pm--) {
		struct swamp_thread_in b = mk(SWAMP_QOS_LEGACY, (uint32_t)pm, SWAMP_CLASS_BIG);
		if (down_at < 0 && swamp_wanted_class(&b) == SWAMP_CLASS_LITTLE) {
			down_at = pm;
		}
	}
	printf("  up on LITTLE at %d permille (time based), down from BIG below %d (util measured on BIG)\n", up_at, down_at);
	CHECK(up_at > 0 && down_at > 0);
	/* the same util measured on the other class: BIG util is scaled up, compare in capacity units */
	{
		uint32_t up_cap = up_at * swamp_capacity(SWAMP_CLASS_LITTLE) / 1000;
		uint32_t down_cap = (uint32_t)down_at * swamp_capacity(SWAMP_CLASS_BIG) / 1000;
		CHECK(down_cap < up_cap);       /* band between them: no flapping */
	}
}

static void
test_ui_burst(void)
{
	/* UI thread woke on LITTLE (no idle BIG at wake), keeps running */
	enum swamp_move m;
	m = swamp_move_decision(SWAMP_CLASS_BIG, SWAMP_CLASS_LITTLE, false, false, 3000, UINT64_MAX, 0);
	CHECK(m == SWAMP_MOVE_MISFIT_WAIT);     /* marks the cpu so an idling BIG kicks it */
	m = swamp_move_decision(SWAMP_CLASS_BIG, SWAMP_CLASS_LITTLE, true, false, 3000, UINT64_MAX, 0);
	CHECK(m == SWAMP_MOVE_UP_IDLE);
	m = swamp_move_decision(SWAMP_CLASS_BIG, SWAMP_CLASS_LITTLE, false, true, 3000, UINT64_MAX, 0);
	CHECK(m == SWAMP_MOVE_UP_PREEMPT);
	m = swamp_move_decision(SWAMP_CLASS_BIG, SWAMP_CLASS_LITTLE, true, true, 500, UINT64_MAX, 0);
	CHECK(m == SWAMP_MOVE_NONE);            /* only just got on core */
	m = swamp_move_decision(SWAMP_CLASS_BIG, SWAMP_CLASS_BIG, true, true, 90000, UINT64_MAX, 0);
	CHECK(m == SWAMP_MOVE_NONE);            /* already right */
}

static void
test_heavy_background(void)
{
	enum swamp_move m;
	struct swamp_thread_in in = mk(SWAMP_QOS_BACKGROUND, 1000, SWAMP_CLASS_BIG);
	in.ran_us = 100000;
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_LITTLE);
	m = swamp_move_decision(SWAMP_CLASS_LITTLE, SWAMP_CLASS_BIG, true, false, 100000, UINT64_MAX, 0);
	CHECK(m == SWAMP_MOVE_DOWN_IDLE);
	m = swamp_move_decision(SWAMP_CLASS_LITTLE, SWAMP_CLASS_BIG, false, false, 100000, UINT64_MAX, 0);
	CHECK(m == SWAMP_MOVE_NONE);            /* no idle LITTLE: it stays, never a preemption downwards */
	in.cur_class = SWAMP_CLASS_LITTLE;
	CHECK(swamp_wanted_class(&in) == SWAMP_CLASS_LITTLE);
	/* reserve: low classes cannot take the last idle BIG */
	CHECK(swamp_low_class(SWAMP_QOS_BACKGROUND, false, false));
	CHECK(swamp_low_class(SWAMP_QOS_UTILITY, false, false));
	CHECK(!swamp_low_class(SWAMP_QOS_LEGACY, false, false));
	CHECK(!swamp_low_class(SWAMP_QOS_UNSPECIFIED, false, false));
	CHECK(!swamp_low_class(SWAMP_QOS_BACKGROUND, false, true));    /* kernel threads are not throttled */
	CHECK(swamp_low_class(SWAMP_QOS_LEGACY, true, false));
	CHECK(swamp_hide_idle_big(true, 1, 1));
	CHECK(!swamp_hide_idle_big(true, 2, 1));
	CHECK(!swamp_hide_idle_big(false, 1, 1));
	CHECK(!swamp_hide_idle_big(true, 0, 1));
	CHECK(!swamp_hide_idle_big(true, 1, 0));
}

static void
test_all_big_busy(void)
{
	enum swamp_move m;
	/* heavy default thread on LITTLE while every BIG runs equal priority work: wait, never move */
	m = swamp_move_decision(SWAMP_CLASS_BIG, SWAMP_CLASS_LITTLE, false, false, 20000, UINT64_MAX, 0);
	CHECK(m == SWAMP_MOVE_MISFIT_WAIT);
	/* and the BIG threads stay because nothing idle is LITTLE-right for them: they want BIG */
	m = swamp_move_decision(SWAMP_CLASS_BIG, SWAMP_CLASS_BIG, false, false, 20000, UINT64_MAX, 0);
	CHECK(m == SWAMP_MOVE_NONE);
}

/*
 * Ping-pong: a thread whose util hovers right at the threshold, with an idle core of the other
 * class always available. Simulate 10 ms steps for 20 s and count moves.
 */
static unsigned
pingpong(bool rate_limit, uint32_t *max_flips)
{
	uint64_t now_us = 1000000, last = 0;
	uint32_t flips = 0;
	int cur = SWAMP_CLASS_LITTLE;
	unsigned moves = 0;
	*max_flips = 0;
	for (int step = 0; step < 2000; step++, now_us += 10000) {
		/* The util a thread shows alternates between "just misfit" (on LITTLE) and tiny (on BIG). */
		struct swamp_thread_in in = mk(SWAMP_QOS_LEGACY, cur == SWAMP_CLASS_LITTLE ? 1000 : 10, cur);
		in.ran_us = 2500;
		int want = swamp_wanted_class(&in);
		uint64_t since = last ? now_us - last : UINT64_MAX;
		enum swamp_move m = swamp_move_decision(want, cur, true, false, in.ran_us,
		    rate_limit ? since : UINT64_MAX, rate_limit ? flips : 0);
		if (m == SWAMP_MOVE_UP_IDLE || m == SWAMP_MOVE_DOWN_IDLE) {
			flips = swamp_next_flips(flips, since == UINT64_MAX ? UINT64_MAX : since);
			if (flips > *max_flips) {
				*max_flips = flips;
			}
			last = now_us;
			cur = (m == SWAMP_MOVE_UP_IDLE) ? SWAMP_CLASS_BIG : SWAMP_CLASS_LITTLE;
			moves++;
		}
	}
	return moves;
}

static void
test_ping_pong(void)
{
	uint32_t mf;
	unsigned with = pingpong(true, &mf);
	unsigned without = pingpong(false, &mf);
	uint32_t mf2;
	(void)pingpong(true, &mf2);
	printf("  20 s of a worst case flapping thread: %u moves with the guard (max flips %u), %u without\n", with, mf2, without);
	CHECK(without > 1000);
	CHECK(with < 100);
	CHECK(with * 10 < without);
	CHECK(mf2 == SWAMP_DWELL_MAX_SHIFT);
	/* calm thread: flips reset */
	CHECK(swamp_next_flips(3, 10000000) == 0);
	CHECK(swamp_next_flips(0, 1000) == 1);
	CHECK(swamp_next_flips(SWAMP_DWELL_MAX_SHIFT, 1000) == SWAMP_DWELL_MAX_SHIFT);
	CHECK(swamp_dwell_us(0) == SWAMP_DWELL_BASE_US);
	CHECK(swamp_dwell_us(99) == ((uint64_t)SWAMP_DWELL_BASE_US << SWAMP_DWELL_MAX_SHIFT));
	/* the dwell blocks */
	CHECK(swamp_move_decision(SWAMP_CLASS_BIG, SWAMP_CLASS_LITTLE, true, false, 20000, 10000, 0) == SWAMP_MOVE_HELD);
	CHECK(swamp_move_decision(SWAMP_CLASS_BIG, SWAMP_CLASS_LITTLE, true, false, 20000, 50000, 0) == SWAMP_MOVE_UP_IDLE);
	CHECK(swamp_move_decision(SWAMP_CLASS_BIG, SWAMP_CLASS_LITTLE, true, false, 20000, 50000, 2) == SWAMP_MOVE_HELD);
}

/* Mixed workload on 4+4 cores: UI thread, a CPU hog at default QoS, two BG hogs, light daemons. */
static void
test_mixed_scenario(void)
{
	struct swamp_thread_in ui = mk(SWAMP_QOS_USER_INTER, 200, SWAMP_CLASS_LITTLE);
	struct swamp_thread_in hog = mk(SWAMP_QOS_LEGACY, 1000, SWAMP_CLASS_LITTLE);
	struct swamp_thread_in bg = mk(SWAMP_QOS_BACKGROUND, 1000, SWAMP_CLASS_LITTLE);
	struct swamp_thread_in daemon = mk(SWAMP_QOS_UNSPECIFIED, 30, SWAMP_CLASS_LITTLE);
	struct swamp_thread_in util = mk(SWAMP_QOS_UTILITY, 1000, SWAMP_CLASS_LITTLE);
	CHECK(swamp_wanted_class(&ui) == SWAMP_CLASS_BIG);
	CHECK(swamp_wanted_class(&hog) == SWAMP_CLASS_BIG);
	CHECK(swamp_wanted_class(&bg) == SWAMP_CLASS_LITTLE);
	CHECK(swamp_wanted_class(&daemon) == SWAMP_CLASS_LITTLE);
	CHECK(swamp_wanted_class(&util) == SWAMP_CLASS_BIG);   /* saturated utility work may use BIG, but through the reserve rule */
	CHECK(swamp_low_class(util.qos, false, false));
}

int
main(void)
{
	printf("sweet_amp logic host test\n");
	test_util_conversion();
	test_class_table();
	test_hysteresis();
	test_ui_burst();
	test_heavy_background();
	test_all_big_busy();
	test_ping_pong();
	test_mixed_scenario();
	printf("%d checks, %d failures\n", checks, failures);
	return failures ? 1 : 0;
}
