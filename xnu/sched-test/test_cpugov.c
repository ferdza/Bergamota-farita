/*
 * Host test of the CPU governor v2 arithmetic (bsd/dev/sweet_cpugov.h, patch 0268). Plain C, no XNU.
 * Run through xnu/sched-test/run-cpugov-test.py (it extracts the header from the patch, so the test always
 * covers the text that ships). Nothing here talks to hardware: the "cores" are a work queue model.
 *
 * LUTs are the SDM845 OPP tables (Linux sdm845.dtsi / the phone's live DT, see docs/CPU_GOVERNOR.md).
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "bsd/dev/sweet_cpugov.h"

static int fails, checks;
#define CHECK(c) do { checks++; if (!(c)) { fails++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); } } while (0)

static const uint32_t A55[] = { 300000, 403200, 480000, 576000, 652800, 748800, 825600, 902400, 979200, 1056000,
	1132800, 1228800, 1324800, 1420800, 1516800, 1612800, 1689600, 1766400 };
static const uint32_t A75[] = { 300000, 403200, 480000, 576000, 652800, 748800, 825600, 902400, 979200, 1056000,
	1132800, 1209600, 1286400, 1363200, 1459200, 1536000, 1612800, 1689600, 1766400, 1843200, 1920000, 1996800,
	2092800, 2169600, 2246400, 2323200, 2400000, 2476800, 2553600, 2649600, 2745600, 2803200 };
#define NA55 (sizeof(A55) / sizeof(A55[0]))
#define NA75 (sizeof(A75) / sizeof(A75[0]))
#define MS 1000000ull

/* ---- unit checks ---- */
static void
test_busy(void)
{
	CHECK(cg_busy(1000, 1000) == 0);
	CHECK(cg_busy(1000, 1200) == 0);        /* idle read slightly after wall */
	CHECK(cg_busy(1000, 0) == CG_SCALE);
	CHECK(cg_busy(1000, 500) == 512);
	CHECK(cg_busy(0, 0) == 0);              /* empty window */
	CHECK(cg_busy(153600, 153600 / 4) == 768);
	CHECK(cg_busy(0xffffffffffull, 0) == CG_SCALE);   /* no overflow with long windows (~16 h of ticks / 1024 ok) */
}

static void
test_invariant(void)
{
	/* the same work: 100% busy at half the top clock == 50% busy at the top clock == 512 */
	uint32_t top = A75[NA75 - 1];
	CHECK(cg_inv_util(CG_SCALE, top / 2, top) == 512);
	CHECK(cg_inv_util(512, top, top) == 512);
	CHECK(cg_inv_util(CG_SCALE, top, top) == CG_SCALE);
	CHECK(cg_inv_util(CG_SCALE, top * 2, top) == CG_SCALE);   /* clamped */
	CHECK(cg_inv_util(0, top, top) == 0);
	CHECK(cg_inv_util(CG_SCALE, 300000, 0) == 0);             /* no LUT: no divide by zero */
	CHECK(cg_avg_khz(300000, 900000) == 600000);
	CHECK(cg_avg_khz(0xffffffffu, 0xffffffffu) == 0xffffffffu);
}

static void
test_want_pick(void)
{
	uint32_t top = A75[NA75 - 1];
	/* inv 512 with 125% headroom: 0.64 x top */
	CHECK(cg_want_khz(512, top, 125) == (uint32_t)((uint64_t)512 * top * 125 / (100 * 1024)));
	CHECK(cg_want_khz(CG_SCALE, top, 125) > top);
	CHECK(cg_want_khz(0, top, 125) == 0);
	CHECK(cg_want_khz(CG_SCALE, 0xffffffffu, 200) == 0xffffffffu);   /* saturates, no wrap */
	/* LUT edges */
	CHECK(cg_pick_idx(A55, NA55, 0, NA55 - 1, 0) == 0);
	CHECK(cg_pick_idx(A55, NA55, 0, NA55 - 1, 300000) == 0);
	CHECK(cg_pick_idx(A55, NA55, 0, NA55 - 1, 300001) == 1);
	CHECK(cg_pick_idx(A55, NA55, 0, NA55 - 1, 1766400) == NA55 - 1);
	CHECK(cg_pick_idx(A55, NA55, 0, NA55 - 1, 9999999) == NA55 - 1);  /* above the top: top */
	CHECK(cg_pick_idx(A55, NA55, 0, 5, 9999999) == 5);               /* above the ceiling: ceiling */
	CHECK(cg_pick_idx(A55, NA55, 7, 9, 0) == 7);                     /* floor */
	CHECK(cg_pick_idx(A55, NA55, 9, 7, 0) == 7);                     /* lo > hi: hi wins */
	CHECK(cg_pick_idx(A55, NA55, 0, 999, 500000) == 3);              /* hi beyond the table is clamped */
	CHECK(cg_pick_idx(A55, 0, 0, 0, 500000) == 0);                   /* empty LUT */
	uint32_t one[] = { 300000 };
	CHECK(cg_pick_idx(one, 1, 0, 0, 999999) == 0);                   /* single entry */
	CHECK(cg_target_idx(one, 1, 0, 0, CG_SCALE, CG_SCALE, 125, 870, 0) == 0);
	CHECK(cg_target_idx(A55, 0, 0, 0, CG_SCALE, CG_SCALE, 125, 870, 0) == 0);
}

static void
test_target(void)
{
	uint32_t n = NA75, top = A75[n - 1];
	/* idle: lowest state */
	CHECK(cg_target_idx(A75, n, 0, n - 1, 0, 0, 125, 870, 14) == 0);
	/* one saturated sample at the lowest state: jumps to hispeed even though inv is tiny (300/2803 x 1.25) */
	uint32_t inv = cg_inv_util(CG_SCALE, 300000, top);
	uint32_t t = cg_target_idx(A75, n, 0, n - 1, CG_SCALE, inv, 125, 870, 14);
	CHECK(t == 14);
	/* saturated above hispeed: headroom step, strictly higher than the current state */
	inv = cg_inv_util(CG_SCALE, A75[14], top);
	t = cg_target_idx(A75, n, 0, n - 1, CG_SCALE, inv, 125, 870, 14);
	CHECK(t > 14);
	CHECK(A75[t] >= A75[14] * 5 / 4);
	/* hispeed above the ceiling is clamped to the ceiling */
	t = cg_target_idx(A75, n, 0, 6, CG_SCALE, 0, 125, 870, 14);
	CHECK(t == 6);
	/* floor wins over idle */
	CHECK(cg_target_idx(A75, n, 9, n - 1, 0, 0, 125, 870, 14) == 9);
	/* a steady 50% load at the top state (inv 512): 0.625 x top (1.75 GHz), the LUT rounding up */
	t = cg_target_idx(A75, n, 0, n - 1, 512, 512, 125, 870, 14);
	CHECK(A75[t] >= top * 625 / 1000 && A75[t] < top * 625 / 1000 + 100000);
	/* a single busy core is enough: busy_max drives it, an idle average does not lower it */
	t = cg_target_idx(A75, n, 0, n - 1, CG_SCALE, CG_SCALE, 125, 870, 14);
	CHECK(t == n - 1);
}

static void
test_step(void)
{
	uint64_t ge = 0;
	/* up is immediate */
	CHECK(cg_step(3, 10, 100 * MS, &ge, 0, 0, 48 * MS) == 10);
	CHECK(ge == 100 * MS);
	/* up_gap */
	CHECK(cg_step(3, 10, 100 * MS, &ge, 99 * MS, 4 * MS, 48 * MS) == 3);
	CHECK(cg_step(3, 10, 100 * MS, &ge, 95 * MS, 4 * MS, 48 * MS) == 10);
	/* down: held for 48 ms of uninterrupted lower demand */
	ge = 100 * MS;
	CHECK(cg_step(10, 2, 108 * MS, &ge, 100 * MS, 0, 48 * MS) == 10);
	CHECK(cg_step(10, 2, 147 * MS, &ge, 100 * MS, 0, 48 * MS) == 10);
	CHECK(cg_step(10, 2, 148 * MS, &ge, 100 * MS, 0, 48 * MS) == 2);
	/* equal demand refreshes the hold */
	ge = 100 * MS;
	CHECK(cg_step(10, 10, 140 * MS, &ge, 100 * MS, 0, 48 * MS) == 10);
	CHECK(ge == 140 * MS);
	CHECK(cg_step(10, 2, 180 * MS, &ge, 100 * MS, 0, 48 * MS) == 10);
	/* hold 0: down at once */
	ge = 0;
	CHECK(cg_step(10, 2, 5, &ge, 0, 0, 0) == 2);
}

static void
test_floor(void)
{
	uint64_t until = 1000 * MS, decay = 16 * MS;
	CHECK(cg_floor_idx(14, 0, 5 * MS, decay) == 0);             /* never boosted */
	CHECK(cg_floor_idx(14, until, 500 * MS, decay) == 14);      /* holding */
	CHECK(cg_floor_idx(14, until, 999 * MS, decay) == 14);
	CHECK(cg_floor_idx(14, until, 1000 * MS, decay) == 14);     /* 0 steps yet */
	CHECK(cg_floor_idx(14, until, 1016 * MS, decay) == 13);
	CHECK(cg_floor_idx(14, until, 1000 * MS + 5 * 16 * MS, decay) == 9);
	CHECK(cg_floor_idx(14, until, 1000 * MS + 14 * 16 * MS, decay) == 0);
	CHECK(cg_floor_idx(14, until, 1000 * MS + 999 * 16 * MS, decay) == 0);
	CHECK(cg_floor_idx(14, until, 1001 * MS, 0) == 0);          /* decay 0: drops at once */
	CHECK(cg_floor_idx(0, until, 1001 * MS, decay) == 0);
	/* monotonic non-increasing after the hold */
	uint32_t prev = 99;
	for (uint64_t t = until; t < until + 400 * MS; t += MS) {
		uint32_t f = cg_floor_idx(14, until, t, decay);
		CHECK(f <= prev);
		prev = f;
	}
}

static void
test_lift(void)
{
	struct cg_lift s = { 0, 0, 0 };
	uint64_t dt = 8 * MS;
	/* saturated at the ceiling, no hint: waits sat_need (100 ms = 13 windows of 8 ms) */
	for (int i = 0; i < 12; i++) {
		CHECK(cg_lift_update(&s, CG_SCALE, 1, 0, dt, 920, 100 * MS, 512, 250 * MS) == 0);
	}
	CHECK(cg_lift_update(&s, CG_SCALE, 1, 0, dt, 920, 100 * MS, 512, 250 * MS) == 1);
	/* stays lifted while busy; calm drops it after 250 ms */
	for (int i = 0; i < 30; i++) {
		CHECK(cg_lift_update(&s, 200, 0, 0, dt, 920, 100 * MS, 512, 250 * MS) == 1);
	}
	/* 30 windows of 8 ms = 240 ms: still lifted; the 31st (248 ms) too; the 32nd (256 ms) drops it */
	CHECK(cg_lift_update(&s, 200, 0, 0, dt, 920, 100 * MS, 512, 250 * MS) == 1);
	CHECK(cg_lift_update(&s, 200, 0, 0, dt, 920, 100 * MS, 512, 250 * MS) == 0);
	/* with a hint a saturated cluster is lifted at once */
	struct cg_lift h = { 0, 0, 0 };
	CHECK(cg_lift_update(&h, CG_SCALE, 1, 1, dt, 920, 100 * MS, 512, 250 * MS) == 1);
	/* not at its ceiling: no lift, whatever the busy value */
	struct cg_lift c = { 0, 0, 0 };
	CHECK(cg_lift_update(&c, CG_SCALE, 0, 1, dt, 920, 100 * MS, 512, 250 * MS) == 0);
	/* a hint keeps a lifted cluster lifted even when calm */
	struct cg_lift k = { 1, 0, 0 };
	for (int i = 0; i < 100; i++) {
		CHECK(cg_lift_update(&k, 0, 0, 1, dt, 920, 100 * MS, 512, 250 * MS) == 1);
	}
}

/* ---- closed loop: a work queue model of one cluster, the real step functions ---- */
struct sim {
	const uint32_t *khz;
	uint32_t n, cap, hispeed, idx, start_idx;
	uint64_t now, last_ge, last_change;
	uint32_t prev_inv, headroom, go_busy;
	uint64_t up_gap, down_hold;
	double backlog;                 /* cycles not yet executed */
	uint32_t changes;
	uint32_t floor_i;               /* constant floor for the boost scenarios */
};

static void
sim_init(struct sim *s, const uint32_t *khz, uint32_t n, uint32_t cap)
{
	memset(s, 0, sizeof(*s));
	s->khz = khz; s->n = n; s->cap = cap; s->hispeed = cap < n / 2 ? cap : n / 2;
	s->headroom = 125; s->go_busy = 870; s->down_hold = 48 * MS;
}

/* One window of period_ms with `cycles_per_ms` of demand on the busiest core; returns the busy fraction. */
static uint32_t
sim_window(struct sim *s, unsigned period_ms, double cycles_per_ms)
{
	double cap_cycles = (double)s->khz[s->idx] * period_ms;       /* kHz x ms = cycles */
	double work = s->backlog + cycles_per_ms * period_ms;
	double done = work < cap_cycles ? work : cap_cycles;
	s->backlog = work - done;
	uint64_t wall = 1000000, idle = (uint64_t)((1.0 - done / cap_cycles) * wall);
	uint32_t busy = cg_busy(wall, idle);
	uint32_t start = s->khz[s->idx], end = start;
	uint32_t inv = cg_inv_util(busy, cg_avg_khz(start, end), s->khz[s->n - 1]);
	uint32_t eff = inv > s->prev_inv ? inv : s->prev_inv;
	s->prev_inv = inv;
	s->now += (uint64_t)period_ms * MS;
	uint32_t tgt = cg_target_idx(s->khz, s->n, s->floor_i, s->cap, busy, eff, s->headroom, s->go_busy, s->hispeed);
	uint32_t next = cg_step(s->idx, tgt, s->now, &s->last_ge, s->last_change, s->up_gap, s->down_hold);
	if (next != s->idx) {
		s->idx = next;
		s->last_change = s->now;
		s->changes++;
	}
	return busy;
}

static void
test_idle_loop(void)
{
	struct sim s;
	sim_init(&s, A75, NA75, NA75 - 1);
	s.idx = NA75 - 1; s.last_ge = 0;
	/* idle from the top: lowest state after the hold, then it stays */
	unsigned t = 0;
	while (s.idx != 0 && t < 200) {
		sim_window(&s, 8, 0);
		t++;
	}
	CHECK(s.idx == 0);
	CHECK(t * 8 >= 48 && t * 8 <= 64);
	uint32_t ch = s.changes;
	for (int i = 0; i < 1000; i++) {
		sim_window(&s, 8, 0);
	}
	CHECK(s.changes == ch);
}

static void
test_single_busy_core_ramp(void)
{
	struct sim s;
	sim_init(&s, A75, NA75, NA75 - 1);
	/* a saturating thread (demand far above the top state): reaches hispeed in ONE window, top within 4 */
	uint32_t seq[8];
	for (int i = 0; i < 8; i++) {
		sim_window(&s, 8, 1e7);
		seq[i] = s.idx;
	}
	CHECK(seq[0] >= s.hispeed);
	CHECK(seq[0] == s.hispeed);
	CHECK(seq[3] == NA75 - 1);
	/* strictly rising until the top */
	for (int i = 1; i < 8; i++) {
		CHECK(seq[i] >= seq[i - 1]);
	}
}

static void
test_step_load(void)
{
	struct sim s;
	sim_init(&s, A75, NA75, NA75 - 1);
	/* 1.2 Gcycles/s (1200000 cycles per ms... i.e. a 1.2 GHz equivalent): settles with 25% headroom, quietly */
	double demand = 1200000.0 / 1.0;
	for (int i = 0; i < 40; i++) {
		sim_window(&s, 8, demand);
	}
	uint32_t ch = s.changes, idx = s.idx;
	for (int i = 0; i < 125; i++) {          /* one more second */
		sim_window(&s, 8, demand);
	}
	CHECK(A75[s.idx] >= 1200000);
	CHECK(A75[s.idx] <= 1200000 * 125 / 100 + 150000);      /* about 1.5 GHz, not the top */
	CHECK(s.changes - ch <= 2);                             /* settled: no hunting */
	(void)idx;
	CHECK(s.backlog < 1.0);
	/* step down to 0.3 GHz-equivalent: follows after the hold, no backlog accumulates on the way */
	for (int i = 0; i < 20; i++) {
		sim_window(&s, 8, 300000.0);
	}
	CHECK(A75[s.idx] < 1000000);
	CHECK(s.backlog < 1.0);
}

static void
test_burst_then_idle(void)
{
	struct sim s;
	sim_init(&s, A75, NA75, NA75 - 1);
	/* a 16 ms frame: 8 ms of heavy work (saturating), 8 ms idle; repeated 5 times (swipe) then idle */
	uint32_t peak = 0;
	for (int f = 0; f < 5; f++) {
		sim_window(&s, 8, 3e6);
		if (s.idx > peak) { peak = s.idx; }
		sim_window(&s, 8, 0);
		/* hold-down: the idle half frame must not drop the clock */
		CHECK(s.idx >= peak);
	}
	CHECK(peak >= s.hispeed);
	/* then idle: back to the bottom within hold + a window or two */
	unsigned t = 0;
	while (s.idx != 0 && t < 100) {
		sim_window(&s, 8, 0);
		t++;
	}
	CHECK(s.idx == 0);
	CHECK(t <= 10);
}

static void
test_boost_floor_decay(void)
{
	struct sim s;
	sim_init(&s, A75, NA75, NA75 - 1);
	/* touch at t=0: floor 14 held until 200 ms, decays one state per 16 ms; idle workload throughout */
	uint64_t until = 200 * MS, decay = 16 * MS;
	s.floor_i = 14; s.idx = 14;
	uint32_t prev = 99;
	int reached_zero = 0;
	for (int i = 0; i < 120; i++) {
		s.floor_i = cg_floor_idx(14, until, s.now, decay);
		sim_window(&s, 8, 0);
		CHECK(s.idx >= s.floor_i);
		if (s.now < until) {
			CHECK(s.idx == 14);
		}
		CHECK(s.idx <= prev || prev == 99);     /* never rises with no load */
		prev = s.idx;
		if (s.idx == 0) { reached_zero = 1; }
	}
	CHECK(reached_zero);
	/* a new event while decaying brings the floor back to 14 at once */
	CHECK(cg_floor_idx(14, 400 * MS + 200 * MS, 450 * MS, decay) == 14);
}

static void
test_little_cap_loop(void)
{
	struct sim s;
	sim_init(&s, A55, NA55, 7);     /* capped at 902.4 MHz */
	struct cg_lift l = { 0, 0, 0 };
	uint32_t ceil_i = 7;
	/* a background thread wanting 1.5 GHz: capped, backlog grows; saturation for 100 ms lifts the ceiling */
	int lifted_at = -1;
	for (int i = 0; i < 60; i++) {
		s.cap = ceil_i;
		uint32_t busy = sim_window(&s, 8, 1500000.0);
		uint32_t lf = cg_lift_update(&l, busy, s.idx >= ceil_i, 0, 8 * MS, 920, 100 * MS, 512, 250 * MS);
		if (lf && ceil_i == 7) {
			ceil_i = NA55 - 1;
			lifted_at = i;
		}
	}
	CHECK(lifted_at >= 12 && lifted_at <= 14);      /* ~100 ms, not 1 s */
	CHECK(A55[s.idx] >= 1500000);
	/* with the hint (A75 loaded) the lift is immediate */
	struct sim s2; struct cg_lift l2 = { 0, 0, 0 };
	sim_init(&s2, A55, NA55, 7);
	s2.cap = 7;
	uint32_t busy = sim_window(&s2, 8, 1500000.0);
	CHECK(cg_lift_update(&l2, busy, s2.idx >= 7, 1, 8 * MS, 920, 100 * MS, 512, 250 * MS) == 1);
}

int
main(void)
{
	test_busy();
	test_invariant();
	test_want_pick();
	test_target();
	test_step();
	test_floor();
	test_lift();
	test_idle_loop();
	test_single_busy_core_ramp();
	test_step_load();
	test_burst_then_idle();
	test_boost_floor_decay();
	test_little_cap_loop();
	printf("%d checks, %d failures\n", checks, fails);
	return fails ? 1 : 0;
}
