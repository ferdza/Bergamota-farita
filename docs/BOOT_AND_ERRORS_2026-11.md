# 6T boot and error catalogue (logs of 2026-11-12)

Observations come from the user's logs; "guess" marks anything not verified.

## Boot path that works
1. `fastboot flash boot_a boot-*.img` (header v0, stock DTB of OOS 11.1.2.2, payload SWEETXNU in the ramdisk), `fastboot --set-active=a`.
   `fastboot boot` is limited by this ABL (one per bootloader session, "Load Error"); the A/B slot-retry trap applies (docs/INSTALL.md).
2. Enxerto starts, shows the 5 s menu (Power = iOS, nothing = Bergamota fastboot, `bergamota.menu=0` disables).
3. Heartwood (xnu-11215) mounts the HFS+ root from `userdata` (`rd=ufsroot0`), launchd starts, GPU thread waits for the firmware
   (`/usr/standalone/firmware/sweet/` or `/usr/local/share/firmware/`), then brings the A630 up (stage 8), backboardd loads Chlorophyll
   (`bgmtl-bb.arm/.direct` flags) when the kernel GPU is ready, else the stock CPU renderer.

## Errors seen, cause, status
| Symptom | Evidence | Cause | Status |
|---|---|---|---|
| Settings icons/text missing, backboardd restarts ("respring") | thousands of `Turnip ... would not allocate or map`, VkResult -2, then SIGSEGV / "Metal failed to build render pipeline" | GEM handle table (4096) full, every later GEM_NEW fails, even 3 KiB; no kernel-side VA/map error was logged (guess, not proven: a BO leak in backboardd may only delay it) | 0275: 16384 handles + `GEM_NEW ... refused` log lines |
| GPU never ready, `GPU state -1: stock`, CPU renderer, search artefacts | diag 22:01: `a630_zap.mdt missing or invalid`, `zap load failed`, `stage 8 self-test did not pass` | firmware files appear one by one in the running root (mtime 16:01 of the boot); the wait loop started on a630_gmu.bin alone | 0276: wait for gmu + sqe + zap.mdt, then 4 s for the .bNN |
| GPU SMMU fault, FAR 0x2300000000, FSR 0x402 | log 21:02, recovery 1/3, "submissions up to N void" | address outside the 2 GiB window (0x80000000-0xffffffff); unknown source (guess: stale/garbage descriptor after the failed allocations) | open |
| Qualcomm CrashDump on reboot | after launchd teardown | IMEM at boot: [0x1c]=0xffffffff [0x20]=0xffffffff [0xc8]=0x2016b822 [0x65c]=0xdf4e7ebf (0274 evidence); 0xffffffff in both dload words looks like "unmapped/not initialised", unverified | open; `sweetdload_imem=1` writes zeroes, result pending |
| MobileSafari aborts at launch (sig 6, ns 2 code 6) twice | crash lines, no reason string | unknown | open, needs the .ips header from the diag export |
| bluetoothd crash loop (ns 18 code 2, reason 1201) | many CRASH lines | no Bluetooth hardware support | known |
| HFS `BlockMarkFreeInternal ... unallocated blocks` at boot | kernel log | unjournaled root after a hard reset | `--journal` available, default off |
| cluster0 load 100% at 1.77 GHz constant | SWEET CPUFREQ lines | something busy on the little cluster; not identified | perf work to do |

## Not ported
Wi-Fi, Bluetooth, audio, modem, camera.
