# Each request compared with Linux and the sibling XNU ports (2026-11-12)

Rule from the user: every request is compared with Linux / other SDM845 XNU ports before it is coded. VERIFIED = read in a file fetched
today (Linux master via raw.githubusercontent.com, Mesa a6xx.xml via gitlab.freedesktop.org); RECALLED = from memory, not re-read.
Linux is GPL: ideas and register facts only, no code copied.

| Request / problem | Linux (or sibling) does | We did | Change |
|---|---|---|---|
| Total freeze, screen on, GPU boots (~460-580 s) | `a6xx_gmu_shutdown` (a6xx_gmu.c): dummy OOB handshake if needed, **`a6xx_gmu_wait_for_idle`**, **`bus_halt` = `a6xx_bus_clear_pending_transactions`** (a630 has VBIF: `VBIF_XIN_HALT_CTRL0 = 0xf`, poll `CTRL1` for 0xf, write 0), then notify slumber, poll `AO_GPU_CX_BUSY_STATUS`, `a6xx_hfi_stop`. VERIFIED (a6xx_gmu.c, a6xx_gpu.c:2085) | slumber without any bus halt (`gpu_suspend`: keepalive 0, OOB clear, slumber) | 0280: VBIF halt before GX off, also in recovery. Offsets 0x3080/0x3081 VERIFIED in Mesa a6xx.xml. Not done: GMU idle wait, post-slumber busy poll, HFI stop (they are open differences) |
| Same freeze: SMMU access while the GPU sleeps | `msm_iommu_tlb_flush_all/walk` (msm_iommu.c:460-488): `if (!pm_runtime_get_if_in_use(iommu_dev)) return;` i.e. no TLB invalidate while the GPU is suspended. VERIFIED | map/unmap/flush wrote and polled the GPU SMMU at any time | 0279: skipped while slumbered, one flush at the wake |
| Reboot ends in CrashDump, log stops at `unmount(0) /` | Linux `kernel_restart`: sync, `device_shutdown`, restart; the root is never unmounted (userspace remounts it read-only). RECALLED. Download-mode disarm: `qcom_scm_set_download_mode` (SCM). RECALLED. No sibling XNU port documents a clean reboot (edi194: Power+VolDown to fastboot) | unmounted `/` and hung | 0277 `sweetnoumount=1`: sync only (same as Linux). Hang cause still unknown |
| HFS journal | edi194 builds the root with `mkfs.hfsplus -J` and Apple's hfs replays after hard resets (their NOTES); Apple hfs source checked in docs/audit/HFS_JOURNAL_VERIFY.md | no journal | on by default (8 MiB) in renegade-rs; not booted yet |
| GEM handles / allocation refusals | msm_gem has no fixed handle table per client (idr, grows). RECALLED | 4096 slots, silent failure | 0275: 16384 + a log line |
| Brightness (6T) | OLED panel driver `panel-samsung-s6e3fc2x01`: DCS set_display_brightness (10 bit), no WLED (audit 6T_FACTS 4.3, AUDIT_KERNEL_DRIVERS F-02) | WLED code for the Poco F1 | not coded: needs a DSI DCS 0x51 write; the OnePlus 6 evidence in keyfan's notes did not yet show a luminance change |
| Wi-Fi / audio | Linux ath10k (qmi/snoc/wmi-tlv), `qcom_q6v5_mss`, qdsp6 (q6afe/q6asm/q6adm); sibling XNU: ios-topaz and HackiOS only (SM6225/SM7325), none on SDM845 | nothing on the 6T | plan in docs/audit/AUDIT_WIRELESS_AUDIO.md; the 6T carve-outs differ from the Poco F1's |
| IPA install silent after the transfer | no sibling port has an IPA path | no progress, no timeout | progress, step lines, 90 s sweetuicache timeout, 150 s stall report |

Open differences with Linux's GMU stop that I did not port: wait for GMU idle (`a6xx_gmu_wait_for_idle`), poll of
`GPU_GMU_AO_GPU_CX_BUSY_STATUS` after slumber, `a6xx_hfi_stop`, `a6xx_gmu_rpmh_off`.
