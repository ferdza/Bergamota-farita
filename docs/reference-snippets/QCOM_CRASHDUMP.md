# QCOM crashdump / download mode / SDI: reference pack (SDM845, OnePlus 6T)

Status legend: OBSERVED = seen in a file/page fetched this session; INFERRED = deduced; UNVERIFIED = recalled or not checked.
Everything below from Linux or from the downstream msm-poweroff is **GPL-2.0: facts only**. The C sketch in section 6 is written from those
facts and is ours (APSL 2.0 compatible); do not paste Linux lines.

## 1. The calls (SCM over SMCCC, no buffer, registers only)

Source (OBSERVED, WebFetch of raw files, master as of 2026-11-12, licence GPL-2.0):
`torvalds/linux drivers/firmware/qcom/qcom_scm.c`, `qcom_scm.h`, `qcom_scm-smc.c`, `include/linux/arm-smccc.h`.
The fetch tool gave no line numbers; cite by function name: `__qcom_scm_set_dload_mode`, `qcom_scm_set_download_mode`, `qcom_scm_disable_sdi`,
`qcom_scm_shutdown`, `qcom_scm_io_readl/writel`, `__qcom_scm_is_call_available`, `__get_convention`, `scm_smc_call`/`__scm_smc_call`.

| Item | Value | Status |
|---|---|---|
| SCM service BOOT | 0x01 | OBSERVED (qcom_scm.h) |
| cmd SET_DLOAD_MODE | 0x10 | OBSERVED |
| cmd SDI_CONFIG | 0x09 | OBSERVED |
| service IO / cmd READ / WRITE | 0x05 / 0x01 / 0x02 | OBSERVED |
| service INFO / cmd IS_CALL_AVAIL | 0x06 / 0x01 | OBSERVED |
| `SCM_SMC_FNID(svc,cmd)` | `(svc & 0xff) << 8 \| (cmd & 0xff)` | OBSERVED |
| SMCCC fid | bit31 = fast call, bit30 = SMC64, bits 29:24 owner, 15:0 func; owner SIP = 2 (0x02000000) | OBSERVED (arm-smccc.h) |
| `QCOM_SCM_ARGS(n, types...)` (x1 value) | low 4 bits = number of args; arg i type in 2 bits at bit 4+2*(i-1); VAL=0, RO=1, RW=2, BUFVAL=3 | OBSERVED |
| Register args | x0 = fid, x1 = arginfo, x2..x5 = args 0..3 (more than 4: buffer, not needed here) | OBSERVED (qcom_scm-smc.c) |
| Return | x0 = status (0 ok, negative = error), x1..x3 = result[0..2] | OBSERVED |
| Status codes | 1 INTERRUPTED (resume, see 0251), 2 WAITQ_SLEEP, -1 ERROR, -2 EINVAL_ARG, -3 EINVAL_ADDR, -4 EOPNOTSUPP, -5 ENOMEM, -12 EBUSY | OBSERVED |
| Atomic variant | `qcom_scm_call_atomic` = FAST call, single smc, no waitq/EBUSY loop | OBSERVED |

### Exact x0/x1/x2/x3 for the two calls we need (SMC64 fast, SIP)
Base fid = `0x80000000 | 0x40000000 | 0x02000000 | (svc << 8) | cmd` = `0xC2000000 | svc<<8 | cmd`.

| Call | x0 | x1 (arginfo) | x2 | x3 | x4..x6 |
|---|---|---|---|---|---|
| SET_DLOAD_MODE disable | 0xC2000110 | 0x2 | 0x10 | 0 | 0 |
| SET_DLOAD_MODE enable (do NOT use) | 0xC2000110 | 0x2 | 0x10 | 0x10 | 0 |
| SDI_CONFIG disable | 0xC2000109 | 0x2 | 1 | 0 | 0 |
| IO read (arg: phys addr) | 0xC2000501 | 0x1 | addr | | |
| IO write | 0xC2000502 | 0x2 | addr | val | |
| IS_CALL_AVAIL for (svc,cmd) | 0xC2000601 | 0x1 | `0x02000000 \| svc<<8 \| cmd` (NO fast/SMC64 bits in the queried id) | | |

- SET_DLOAD_MODE args: args[0] = 0x10 always, args[1] = 0x10 to enable, 0 to disable (OBSERVED `__qcom_scm_set_dload_mode`). The downstream
  msm-poweroff passes (arg1, arg2) = (dload type, 0) with 0x10 = full dump (see 3); consistent.
- SDI_CONFIG: args (1, 0): "disable watchdog debug", "disable SDI" (OBSERVED `qcom_scm_disable_sdi`; the downstream `scm_disable_sdi()` uses
  svc BOOT, cmd 0x9, args (1, 0), same values).
- IS_CALL_AVAIL result: x1 == 1 means available (OBSERVED). Linux probes the convention with the SMC64 fid and falls back to SMC32 (fid 0x82000601)
  then legacy. On SDM845 the mainline DT says `compatible = "qcom,scm-sdm845", "qcom,scm"` (OBSERVED sdm845.dtsi line 365), no special quirk:
  INFERRED the SMC64 convention is used (our own `0103` GPU zap code already issues SMC64 SIP calls on this SoC family with `x6 = 0, x7 = 0`).
- Variant choice on SDM845 (answer to question 1/4): use the **SCM BOOT call** (no TCSR address). The TCSR-RMW variant
  (`qcom,dload-mode = <&tcsr offset>`, mask GENMASK(5,4), via IO read/write) only exists when the DT carries that property; mainline `sdm845.dtsi`
  has none (grep "dload" = no hit, OBSERVED) and the OnePlus downstream tree has none either (OBSERVED below). Order in Linux when no address:
  SET_DLOAD_MODE if IS_CALL_AVAIL says yes, else nothing (logs "No available mechanism").
- Registers and clobbers: SMC clobbers x0..x3 (results) and, per our 0103 asm, x4..x17 may be changed; copy that clobber list. Set x6 = 0 (it is the
  waitq/continuation token, only meaningful on resume, see patch 0251). EBUSY (-12) and INTERRUPTED (1) never occur for a fast call in
  practice (UNVERIFIED); one retry on 1 using the 0251 rule is cheap.
- The probe in Linux order: download mode set at probe ("warm boot enters download mode unless a clean shutdown disables it"), SDI disabled
  at probe `if (qcom,sdi-enabled || download_mode == 0)`, and `qcom_scm_shutdown()` sets NODUMP. All OBSERVED.

## 2. Downstream (Android msm-4.9) flow, SDM845 / OnePlus 6T kernel

Source: LineageOS `android_kernel_oneplus_sdm845` branch `lineage-22.2`, `drivers/power/reset/msm-poweroff.c` and
`arch/arm64/boot/dts/qcom/sdm845.dtsi` (OBSERVED by WebFetch, GPL-2.0, Linux Foundation copyright; the dtsi was truncated at 100000 of
130174 chars, imem and restart nodes were inside the read part). I did NOT see the OnePlus-specific (`oneplus/` / `op_`) code that might add
cookies of its own (UNVERIFIED).

SDM845 DT (OBSERVED): `qcom,msm-imem@146bf000` reg 0x146bf000/0x1000, children `mem_dump_table@10` (8 B), **`dload_type@1c`** (4 B),
**`restart_reason@65c`** (4 B, = 0x146bf65c, the address our sweet_reboot.c already uses), `boot_stats@6b0`, `kaslr_offset@6d0`, `pil@94c`,
`diag_dload@c8`. **There is no `download_mode` and no `emergency_download_mode` node**, so on SDM845 the IMEM magic words 0xE47B337D /
0xCE14091A are never written by this kernel (the code is `if (dload_mode_addr)`): download mode is armed through SCM only.
`restart@10ac000 compatible "qcom,pshold"`, reg `0xC264000` ("pshold-base") and `0x1fd3000` ("tcsr-boot-misc-detect", fallback used only if
the SCM dload call is unsupported: it writes arg1 to that register); property `qcom,force-warm-reboot`.
Mainline cross-check (OBSERVED): `sram@14680000 size 0x40000` (covers 0x146bf000) with `pil-reloc@3f94c` = 0x146bf94c = downstream `pil@94c`;
so it is the same IMEM and the downstream offsets hold.
Mainline fajita `sdm845-oneplus-common.dtsi` has **no** dload/scm/imem restart nodes (OBSERVED).

Downstream constants (OBSERVED, facts): IMEM dload_mode words 0xE47B337D, 0xCE14091A (unused on SDM845); emergency magics 0x322A4F99, 0xC67E4350,
0x77777777 (EDL, **never write these**, they send the phone to Qualcomm 9008 EDL); `SCM_DLOAD_FULLDUMP 0x10`, `SCM_DLOAD_MINIDUMP 0x20`,
`SCM_DLOAD_BOTHDUMPS 0x30`, `SCM_EDLOAD_MODE 0x01`, `EMMC_DLOAD_TYPE 0x2` (written to dload_type@1c only via sysfs; leave alone).
Restart reasons written to restart_reason (OBSERVED): bootloader 0x77665500, recovery 0x77665502, rtc 0x77665503, dm-verity corrupted 0x77665508,
dm-verity enforcing 0x77665509, keys clear 0x7766550a, `oem-NN` 0x6f656d00 | NN, anything else with a command 0x77665501, no command: untouched/0.
(Our code uses bootloader/recovery values; consistent. 'BERG' 0x42455247 is ours.)

## 3. Ordering downstream (answer to question 3)

- `msm_restart_prepare(cmd)`: `set_dload_mode(download_mode && (in_panic || restart_mode == RESTART_DLOAD))` first, i.e. download mode is turned **on only
  for a panic or an explicit dload restart; otherwise explicitly set to 0 (cookie words 0 + SCM SET_DLOAD_MODE (0,0))** on every restart. Then pick warm vs
  hard reset (warm if a command is given or dload is on, unless `qcom,force-warm-reboot`) through the PON driver, then the reason into IMEM, then flush caches.
- `do_msm_restart`: prepare, optional wdog bite on panic, then `scm_disable_sdi()` (BOOT 0x9 args 1,0, unconditional), then
  `halt_spmi_pmic_arbiter()` (SCM svc PWR cmd 1, arg 0, if supported), then `deassert_ps_hold()` (SCM svc PWR cmd 2 arg 0 if supported, then write 0 to
  PS_HOLD 0xC264000), `msleep(10000)`. (SVC_PWR numeric value: UNVERIFIED, recalled 0x9; do not use these two PWR calls, PS_HOLD write is enough.)
- `do_msm_poweroff`: `set_dload_mode(0)`, `scm_disable_sdi()`, PON `SHUTDOWN` type, halt arbiter, deassert PS_HOLD, `msleep(10000)`.
- Panic keeps download mode ON downstream (that is the purpose: the dump). We do not want that on the 6T; keep it OFF so a panic is never a CrashDump.
- Probe: `set_dload_mode(download_mode)` (default 1) and `scm_disable_sdi()` only if download_mode is 0. So Android arms download mode at boot and clears
  it on every clean reboot. **INFERRED**: the 6T keeps the armed state across reset because XBL/TZ default it on; since nothing in XNU ever
  clears it, every reset lands in CrashDump (FAJITA.md OBSERVED symptom, cause INFERRED). Whether the OnePlus ABL (not Android) arms it by itself
  is UNVERIFIED; the clear call is idempotent, so it costs nothing to send either way.

## 4. Our current code (OBSERVED)

`bsd/dev/sweet_reboot.c` is created by `xnu/patches-11215/0137-beryllium-reboot-mode.patch` (+0140 'BERG' mode, +0260 poweroff); lines refer to the
patch file after applying nothing, i.e. the `+` lines in each patch.
- Restart (`sweet_reboot_restart`, 0137): `sweet_spmi_atomic()`, PON_SOFT_RB_SPARE RMW (SID 0, 0x88f, GENMASK(7,1)), IMEM `sr_imem[0x65c/4] = magic` for non-normal
  modes only, `*sr_pshold = 0` (0x0c264000), wait 2 s, PSCI SYSTEM_RESET (0x84000009), wait 2 s, return -1. No SCM call anywhere.
- Poweroff (0260): UFS final flush, PON reason 0, `sr_imem[SR_IMEM_RESTART / 4] = 0`, PSCI SYSTEM_OFF 0x84000008, PS_HOLD fallback, wfi loop.
- **Correction to AUDIT_KERNEL_DRIVERS F-08**: the audit says `sr_imem[0] = 0` (offset 0, "stray write"). The real index is `SR_IMEM_RESTART / 4`, i.e. offset
  0x65c, the restart_reason word. It is a correct, intended clear, not a stray write (OBSERVED 0260). So the IMEM zero clear is fine; what is missing is
  only the SCM clear (section 1).
- Panic (`SweetPlatformExpert::haltRestart`): `kPEPanicRestartCPU` calls `sweet_reboot_restart(1)` which returns -1 (no reset) unless `sweetreboot=bootloader`.
- SCM helper style already in tree: `0103-beryllium-gpu-a630-bringup.patch` (the `+` lines from `#define SCM_SIP 0x02000000u`, about patch lines 2418-2480):
  `scm_smccc()` register asm, `scm_invoke()` with INTERRUPTED/BUSY handling, 0251 adds the continuation token. Own code, APSL: reuse by moving
  into a shared `sweet_scm.c`/header instead of a third copy.

## 5. Where to call (suggested)

1. `sweet_reboot_init()` (thread context, boot): `sweet_scm_dload_off()` = SET_DLOAD_MODE(0) then SDI disable. Mirrors Linux probe with download_mode=0
   and also protects against a surprise watchdog/hard reset later. Log both statuses (`SWEET REBOOT: SCM dload off st=%d sdi st=%d`).
2. Start of `sweet_reboot_restart()` and `sweet_reboot_poweroff()` (before PS_HOLD/PSCI, after the PON/IMEM writes): repeat the same two calls (atomic-safe, fast
   call, no locks, no malloc). A failure must only log, never block the reset.
3. Panic path: call it in `sweet_reboot_note_panic()` (kPEPanicBegin) once, so a hung panic that later gets a watchdog reset does not enter CrashDump. Fast call,
   safe at panic time (UNVERIFIED on hardware).
4. Never write IMEM word 0 / 0x1c or the EDL words. Do not touch SVC_PWR calls.
5. Enxerto (EL1 shim before XNU): same two calls before its own `PSCI SYSTEM_RESET`/`SYSTEM_OFF` (audit F-24).

## 6. Clean C sketch (ours, APSL 2.0; derived from the facts above)

```c
/* sweet_scm.c: Qualcomm SCM fast calls over SMCCC (SMC64, owner SIP, no buffers).
 * Encoding per the public SMCCC spec and the facts in docs/reference-snippets/QCOM_CRASHDUMP.md. */
#define SCM_SIP_FAST64(svc, cmd) (0xC2000000u | ((uint32_t)(svc) << 8) | (cmd))
#define SCM_BOOT 0x01u
#define SCM_BOOT_SDI_CONFIG 0x09u
#define SCM_BOOT_SET_DLOAD 0x10u

/* returns x0 (status, 0 = ok); x1 result via *res1 if non-NULL */
static int64_t
sweet_scm_fast(uint32_t fid, uint64_t arginfo, uint64_t a0, uint64_t a1, uint64_t *res1)
{
	register uint64_t x0 __asm__("x0") = fid;
	register uint64_t x1 __asm__("x1") = arginfo;
	register uint64_t x2 __asm__("x2") = a0;
	register uint64_t x3 __asm__("x3") = a1;
	register uint64_t x4 __asm__("x4") = 0, x5 __asm__("x5") = 0;
	register uint64_t x6 __asm__("x6") = 0, x7 __asm__("x7") = 0;
	__asm__ volatile ("smc #0"
	    : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x3), "+r"(x4), "+r"(x5), "+r"(x6), "+r"(x7)
	    : : "x8", "x9", "x10", "x11", "x12", "x13", "x14", "x15", "x16", "x17", "cc", "memory");
	if (res1) { *res1 = x1; }
	return (int64_t)(int32_t)x0;
}

/* Disarm the crash/download path; safe to call repeatedly and at reset time. */
void
sweet_scm_crashdump_off(int *dload_st, int *sdi_st)
{
	/* download mode off: args (0x10, 0), 2 plain-value args => arginfo 2 */
	int s1 = (int)sweet_scm_fast(SCM_SIP_FAST64(SCM_BOOT, SCM_BOOT_SET_DLOAD), 2, SCM_BOOT_SET_DLOAD, 0, NULL);
	/* SDI off: args (1, 0) */
	int s2 = (int)sweet_scm_fast(SCM_SIP_FAST64(SCM_BOOT, SCM_BOOT_SDI_CONFIG), 2, 1, 0, NULL);
	if (dload_st) { *dload_st = s1; }
	if (sdi_st) { *sdi_st = s2; }
}
```
Optional availability probe at init (Linux does this): `sweet_scm_fast(0xC2000601, 1, 0x02000110, 0, &avail)` => `avail == 1`. If it answers -4/!1,
retry once with SMC32 fids (0x82000xxx; the 32-bit register ABI is the same) before giving up, and log the result; never loop.

## 7. Test plan (hardware, INFERRED expectations)

Boot with `sweetreboot=normal`, check `SWEET REBOOT: SCM dload off st=0 sdi st=0` in the persistent log; `reboot` should then land in ABL/Android boot instead of
CrashDump. If st is -4 (not supported) or the phone still hits CrashDump, then try IO write TCSR route only after finding the address (not in any
tree seen here: UNVERIFIED; candidates to read: `TCSR_BOOT_MISC_DETECT` 0x1fd3000 which the downstream pshold node names; do not write without a datasheet
or an Android dump of the register).

## 8. Where I looked and could not find
- A `download_mode` / `qcom,dload-mode` entry for SDM845/OnePlus 6T in mainline or in the Lineage oneplus_sdm845 dtsi: none (grep and node list).
- A solution already in the reference clones: `grep -ril dload|SDI_CONFIG|download_mode` over hackios, UniXNU, ios-sweet, ios-topaz, ios-switch, Chlorophyll: only unrelated hits
  (a GPU test, a NOTES mention). Nobody there solved CrashDump.
- Not fetched: msm-4.9 `qcom,scm` conventions in `drivers/soc/qcom/scm.c` (`SCM_SIP_FNID`, `scm_call2_atomic` ids); the register layout above is from mainline and matches
  the arm64 SMCCC path that the downstream also uses (INFERRED).
