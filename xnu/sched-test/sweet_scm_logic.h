/*
 * Pure logic of the OnePlus 6T crash-dump disarm (sweet_reboot.c): SCM fast-call encodings, the status
 * classification and the reset ordering. No kernel dependencies, so xnu/sched-test/test_crashdump.c can test it
 * on the host.
 *
 * Facts (Qualcomm SCM over SMCCC, public SMCCC encoding; cross-checked against the layout documented for
 * SDM845 in docs/reference-snippets/QCOM_CRASHDUMP.md; no code copied):
 *   fid  = fast(bit31) | SMC64(bit30) | owner SIP(2 << 24) | svc << 8 | cmd
 *   x1   = arginfo (number of plain-value args), x2..x5 = args, x6 = x7 = 0
 *   BOOT service 0x01: cmd 0x10 SET_DLOAD_MODE (args 0x10, 0 = off), cmd 0x09 SDI_CONFIG (args 1, 0 = off)
 */
#ifndef _SWEET_SCM_LOGIC_H_
#define _SWEET_SCM_LOGIC_H_

#include <stdint.h>
#include <stdbool.h>

#define SWEET_SCM_FAST64_SIP(svc, cmd) \
	(0xC2000000u | (((uint32_t)(svc) & 0xffu) << 8) | ((uint32_t)(cmd) & 0xffu))

#define SWEET_SCM_SVC_BOOT          0x01u
#define SWEET_SCM_BOOT_SDI_CONFIG   0x09u
#define SWEET_SCM_BOOT_SET_DLOAD    0x10u
#define SWEET_SCM_FID_DLOAD         SWEET_SCM_FAST64_SIP(SWEET_SCM_SVC_BOOT, SWEET_SCM_BOOT_SET_DLOAD)
#define SWEET_SCM_FID_SDI           SWEET_SCM_FAST64_SIP(SWEET_SCM_SVC_BOOT, SWEET_SCM_BOOT_SDI_CONFIG)

/* boot-arg sweetdload: 0 = never call SCM (old behaviour), 1 = at restart / poweroff / panic only (default), 2 = also at init */
enum { SWEET_DLOAD_OFF = 0, SWEET_DLOAD_RESET = 1, SWEET_DLOAD_INIT = 2 };

static inline int
sweet_dload_mode_parse(bool present, uint32_t value)
{
	if (!present) {
		return SWEET_DLOAD_RESET;
	}
	return value > (uint32_t)SWEET_DLOAD_INIT ? SWEET_DLOAD_RESET : (int)value;
}

/* The SCM status word is a signed 32-bit value in x0. */
static inline int
sweet_scm_status(uint64_t x0)
{
	return (int)(int32_t)(uint32_t)x0;
}

/* Where a reset step is allowed to run: the disarm is wanted at init only in mode 2, at reset time in modes 1 and 2. */
static inline bool
sweet_dload_at_init(int mode)
{
	return mode >= SWEET_DLOAD_INIT;
}

static inline bool
sweet_dload_at_reset(int mode)
{
	return mode >= SWEET_DLOAD_RESET;
}

/* Restart ordering. Default (psci_first == false) is the old order: PS_HOLD, then PSCI SYSTEM_RESET.
 * sweetresetpsci=1 swaps them (experiment, default OFF). */
enum { SWEET_RESET_PSHOLD = 1, SWEET_RESET_PSCI = 2 };

static inline void
sweet_reset_order(bool psci_first, int steps[2])
{
	steps[0] = psci_first ? SWEET_RESET_PSCI : SWEET_RESET_PSHOLD;
	steps[1] = psci_first ? SWEET_RESET_PSHOLD : SWEET_RESET_PSCI;
}

#endif /* _SWEET_SCM_LOGIC_H_ */
