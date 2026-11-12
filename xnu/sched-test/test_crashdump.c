/*
 * Host test of the fajita crash-dump disarm logic (xnu/patches-11215/0272, bsd/dev/sweet_scm_logic.h).
 * Run: sh xnu/sched-test/run-crashdump-test.sh
 */
#include <stdio.h>
#include "sweet_scm_logic.h"

static int failures, checks;
#define CHECK(cond) do { \
	checks++; \
	if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } \
} while (0)

int
main(void)
{
	/* encodings from docs/reference-snippets/QCOM_CRASHDUMP.md */
	CHECK(SWEET_SCM_FID_DLOAD == 0xC2000110u);
	CHECK(SWEET_SCM_FID_SDI == 0xC2000109u);
	CHECK(SWEET_SCM_FAST64_SIP(0x05, 0x01) == 0xC2000501u);   /* IO read, for reference */
	CHECK(SWEET_SCM_FAST64_SIP(0x1ff, 0x1ff) == 0xC200ffffu); /* fields are masked to 8 bits */

	/* status: x0 is a signed 32-bit value, upper bits are ignored */
	CHECK(sweet_scm_status(0) == 0);
	CHECK(sweet_scm_status(1) == 1);
	CHECK(sweet_scm_status(0xfffffff4u) == -12);
	CHECK(sweet_scm_status(0xffffffff00000000ull | 0xfffffffcu) == -4);
	CHECK(sweet_scm_status(0x100000000ull) == 0);

	/* boot-arg: absent or out of range = the default (reset-time only); 0 = old behaviour */
	CHECK(sweet_dload_mode_parse(false, 0) == SWEET_DLOAD_RESET);
	CHECK(sweet_dload_mode_parse(true, 0) == SWEET_DLOAD_OFF);
	CHECK(sweet_dload_mode_parse(true, 1) == SWEET_DLOAD_RESET);
	CHECK(sweet_dload_mode_parse(true, 2) == SWEET_DLOAD_INIT);
	CHECK(sweet_dload_mode_parse(true, 3) == SWEET_DLOAD_RESET);
	CHECK(sweet_dload_mode_parse(true, 0xffffffffu) == SWEET_DLOAD_RESET);
	for (int m = 0; m <= 2; m++) {
		CHECK(sweet_dload_at_reset(m) == (m >= 1));
		CHECK(sweet_dload_at_init(m) == (m == 2));
	}

	/* ordering: default = PS_HOLD then PSCI (the old behaviour); the experiment swaps them */
	int st[2];
	sweet_reset_order(false, st);
	CHECK(st[0] == SWEET_RESET_PSHOLD && st[1] == SWEET_RESET_PSCI);
	sweet_reset_order(true, st);
	CHECK(st[0] == SWEET_RESET_PSCI && st[1] == SWEET_RESET_PSHOLD);

	printf("%d checks, %d failures\n", checks, failures);
	return failures ? 1 : 0;
}
