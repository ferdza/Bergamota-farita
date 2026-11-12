# Idle CPU: quieting the installed root (2026-11-12)

Goal: a freshly installed root does not burn ~1.9 cores at idle on respawn/crash loops (NOTES.md, "CPU thieves",
2026-10-26). Userland only, no kernel change. Nothing here was run on a phone.

## What is done (by default in the root build)

`tweaks::idle()` (tools/renegade-rs/src/tweaks.rs), mirrored by `idle()` in tools/renegade/root_tweaks18.py.
Runs right after `launchd()`.

| Loop (measured in NOTES.md / ios-sweet) | Action |
|---|---|
| gamepolicyd, wifip2pd, fairplayd.H2, asd, SepUpdateTimer (seputil) | `true` in /private/var/db/com.apple.xpc.launchd/disabled.plist (same file `launchctl disable system/X` writes; worked on the phone 2026-10-26) |
| coreduetd (~0.9 core locked, ios-sweet NOTES.md 2026-11-09, same fix) | same |
| bluetoothd (crash loop, no BT) | same, unless the BlueTool stub is in the root (BT being brought up) |
| usernotificationsd, watchdogd + the old `quiet()` set (replicatord, appprotectiond, passd, findmydeviced, mobileactivationd, spaceattributiond, PerfPowerServices, webinspectord) | `ThrottleInterval` raised to 60 s in launchd.plist (never lowered; jobs kept) |
| SiriAUSP, MauiAUSP, MacinTalkAUSP, KonaSynthesizer, MessagesBlastDoorService (extension aborts, feed ReportCrash) | moved to /var/root/disabled-bin/ with a README, exactly like the web "Quiet crash loops" button (so its "Restore" works) |
| BTAudioHALPlugin (launchd getgrouplist loop) | already parked by `audio()` |

Idempotent (second run: `+0 ... raised on 0 ... parked 0`). Other keys of an existing disabled.plist are kept.
Not touched: backboardd, SpringBoard, dropbear, usbmuxd/lockdownd, configd, Chlorophyll/bgmtl, GPU files.

Switches: `renegade-rs root/root-ipsw --no-idle`; wasm build config `"idle": false`; `renegade-rs tweaks` is opt-in
`--idle` (the Python parity tests do not set it); Python `SWEET_IDLE=0`. The root carries /private/var/root/IDLE-CPU.txt.

## Undo

- Jobs: delete the keys from disabled.plist, or `launchctl enable system/LABEL`.
- Parked binaries: web Restore, or `mv DEST ORIG` per README line.
- Throttle: edit launchd.plist (ThrottleInterval) or rebuild with `--no-idle`.
- Cost: no Siri/speech synthesis extensions, no Messages BlastDoor, no CoreDuet predictions, no Wi-Fi P2P/AirDrop-style
  features, no FairPlay H2/asd.

## Not done / needs a phone

- ReportCrash (0.3 core) and ReportMemoryException: no safe off switch found; they should shrink as the loops above
  go away. Measure after a boot (`top` / CPU-s per 8 s).
- ~29 extension processes aborting at one site (unslid pc 0x1d3a641dc, docs/FAJITA.md): root cause still unsymbolicated;
  only the speech/BlastDoor ones are parked.
- **getgrouplist("mobile") in launchd over flat /etc/group: note only.** Pre-seeding or trimming /etc/group is not
  safe to do blind (names/gids are used by many daemons; the real cost was the BT HAL reconnect rate, now parked).
  If launchd still shows CPU after a boot, sample it; a candidate is a short /etc/group with only the system groups,
  tested on the phone first.
- watchdogd/usernotificationsd are only throttled; confirm the watchdog still behaves and notifications still arrive.
- Verify disabled.plist is honoured by the iOS 18 launchd with launchd_unsecure_cache (it was on the 2026-10-26 root).

## Verified here vs guessed

Verified: cargo test --test idle (8 tests: disable, merge, bluetooth gate, throttle up-only, park + restore loop,
idempotence, empty root, TreeFs); Python and Rust produce identical trees on the tweaks fixture (checked by hand, diff -r);
clippy clean for touched files; no new failures (tests/tweaks.rs x4 and hfswrite::root_build_from_a_folder fail
before and after: root owner records).
Guessed: that these jobs stay quiet on iOS 18.7.8 as measured on the 2026-10-26 root; side effects above.

## Other projects (reads of the shallow clones)

- LMasterPiec3/ios-sweet NOTES.md 2026-11-09: coreduetd busy loop measured ~0.9 core, fixed with disabled.plist; adopted.
- MakrSas/ios-topaz, UniXNU, hackios-xnu-kernel: no further userland idle-CPU recipe found beyond launchd.plist patching
  (tools/sweet-root-tweaks.py, same family as our quiet()).
