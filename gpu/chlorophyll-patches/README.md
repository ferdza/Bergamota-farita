# Chlorophyll performance patches (gpu/metal pin d3cb665, branch ios26)

Six `git format-patch` files against Chlorophyll `d3cb665` (the pin of `gpu/metal`). The submodule here is empty and was not
touched. Written 2026-11-12 from a read-only clone; none of it has run on a phone, and the Mesa/Vulkan and Objective-C parts
were not compiled (details at the end).

Apply, in a Chlorophyll checkout at the pin:

    git -C gpu/metal checkout d3cb665
    git -C gpu/metal am ../chlorophyll-patches/*.patch      # applies cleanly on d3cb665 (checked with git am)

Then rebuild libbgair/the inject the usual way (build-ios.sh, `pacstrip --sign`, install via temp + `mv`; see NOTES gotchas).

## What the source actually looks like (this corrects docs/GPU_PERF_PLAN.md)

The pin is the **Turnip/Vulkan runtime**, not the Gallium one the plan and the 100-200 us/draw figure describe:

- `src/bgmtl.m` has **no `BGWork` objects and no `NSMutableArray` of commands**. Every encoder call goes straight to
  `air/chl_vk.c` / `air/chl_render.c.inc`, which record into a `VkCommandBuffer` (`chl_draw` -> `draw_prologue` ->
  `flush_bindings` -> `vkCmdDraw`). A "deferred recording" layer does not exist and would be a rewrite of that path, so patch (4)
  of the task (deferred-recording prototype) was **not done**: it is neither small nor clearly safe here.
- `setBytes`/`setVertexBytes`/`setFragmentBytes` are **already** slices of a per-command-buffer upload ring (`ring_alloc`, slabs
  recycled by the device): no BO per call. `flush_bindings` already pushes only changed descriptors/constants, and `air_metal.c`
  (Gallium) is the old path the plan was reading; its `tex_pool`/state shadow are not used by `chl_vk.c`.
- So the 100-200 us/draw was measured on **Gallium**; NOTES has Turnip at 3.4-7.5 us/draw in tests and no production number yet.
  The first thing to do with these patches is read `perf2:` (below) on Turnip: it splits "our code" from "CoreAnimation".

## Patches

| # | Title | Expected gain | Risk |
|---|-------|---------------|------|
| 0001 | seed check once per command buffer, hold each object once | small, CPU only: removes an NSNumber box + global lock + dictionary lookup per bind of an IOSurface-backed texture, and the repeated retain/append of re-bound objects (`cb_hold` only deduplicated the last one) | low; one behaviour change (below) |
| 0002 | `chl_get_stats`: GEM allocs, bytes, frees, images | none (counters) | none |
| 0003 | size-bucketed texture **memory** pool (`CHL_MEMPOOL_MB`, off by default) | the main one: texture hit rate from ~30-45 % (exact shape) towards the share of targets within 25 % of a pooled block; each hit skips a GEM BO alloc (FIXES.md: ~18 ms for a full-screen target; NOTES: ~20 % of backboardd samples allocating/freeing per frame) | medium until seen on the phone (UBWC, below) |
| 0004 | texpool: 128 slots, `BGMTL_TEXPOOL_AGE_MS`, idle trim calls `chl_trim()` | small; longer expiry is only a knob | low |
| 0005 | `perf2:` line (record vs encode vs submit, frame gap p50/p95, GEM allocs per command buffer, mempool hit/miss) | none (measurement) | none; two clock reads per call only with `bgmtl.perf` |
| 0006 | inject flag files `chl.mempool[.<MB>]`, `chl.texpool.age` (backboardd) | none (switches) | none; absent files = old behaviour |

### 0001 detail and the behaviour change
`chlTextureFor:` re-checked `IOSurfaceGetSeed` on every bind; it now does so once per command buffer per texture (the rule
`_linSeq` already used). A CPU write that lands between two draws of one command buffer is seen by the next command buffer; the
cache clean could only reach the GPU at that granularity anyway, but this is a semantic change: if icons/backing stores show
one-frame-late content, revert this patch first. `cb_hold` stamps each object with the generation of the recording that held it
(unique per `chl_cmdbuf_create`); a stale stamp can only cause an extra hold, never a missed one.

### 0003 detail: why memory, not whole textures
The existing bgmtl.m pool (`BGMTL_TEXPOOL_MB=192`) keeps whole textures under an exact descriptor key. Bucketing *textures*
is not possible: a texture reports its own width/height to CoreAnimation and the sampler normalises against the image size, so
a larger image cannot stand in for a smaller one. What is expensive is the kernel BO, not the VkImage/view, so 0003 pools the
`VkDeviceMemory`: blocks are allocated rounded to eighths of a power of two (min 64 KB step), a new image binds the smallest
pooled block that fits (up to 25 % + 64 KB over) at offset 0. The exact-shape texpool still sits above it (a hit there is
cheaper still). Imported IOSurface textures, views and buffers are not pooled. `chl_trim()` and `chl_device_close` drain it.
Host-tested logic: `test/chl_mempool_test.c`.
Main risk (guess): Turnip's UBWC flag data inside a reused block is stale when the new image binds. The Vulkan spec allows
aliasing in UNDEFINED layout and `transition_new_image` records that, but only a swipe test on the A630 will show whether
blur targets corrupt. Off unless `CHL_MEMPOOL_MB` is set (or the flag file, 0006).

## Measuring on the phone (all need a boot of the image; backboardd reads flags at start)

1. Baseline with the patches applied and every new switch off: `touch /private/var/tmp/bgmtl.perf`, restart backboardd, swipe
   the home screen for ~10 s, read `bgmtl.log`:
   - `perf:` (existing): cbuf/s, draws/cbuf, encode/submit/gpu-wait per second.
   - `perf2:` (new): `record` ms vs `encode` ms (record = time inside this library; the rest of encode is CoreAnimation between
     calls), `us/draw`, `submit` ms, `frame gap p50/p95`, GEM allocs/MB/frees/images per command buffer.
   - Decision rule: if `record` is a small part of `encode`, no change in this library can fix the 100-200 us/draw (CoreAnimation
     or the draw call in Turnip is the cost); if the GEM allocs per cbuf are well above 1-2, the memory pool is the lever.
2. A/B 0003: `touch /private/var/tmp/chl.mempool` (192 MB; `chl.mempool.96` etc. for other caps), restart backboardd, repeat.
   Compare `mempool H hits M misses`, GEM allocs per cbuf, `texpool:` hit rate, `frames:` fps and `frame gap p95`. Look at the
   screen for corrupted blur/glass. Remove the file to go back.
3. A/B 0004: put `20000` in `/private/var/tmp/chl.texpool.age` (texture expiry 20 s) and compare `texpool:` hits/MB held.
4. A/B 0001: only by reverting the patch (no switch); compare `perf2:` `bind` ms.
5. Memory check: iconservicesagent has a 160 MB jetsam limit; the pool is off there unless `CHL_MEMPOOL_MB` is in its
   environment, and the idle trim frees it.

## Verified vs guessed

Verified (host, Linux):
- `air/chl_mempool.h` compiles with `gcc -Wall -Wextra` and `test/chl_mempool_test.c` passes (bucket rounding and waste bound,
  owner separation, smallest fit, 25 % over-size rule, cap eviction, expiry, slot bound, drain).
- `src/bg_perfstat.h` percentile helper compiles; `test/bg_perfstat_test.c` passes.
- The open-addressing seed table of 0001 was compiled and exercised standalone (copy of the function with stub lock types).
- `git am` of all six patches onto a fresh `d3cb665` succeeds.

Not compiled (no Mesa headers, no iOS SDK, no Objective-C runtime here): all of `air/chl_vk.c`, `src/bgmtl.m`,
`inject/bgmtl_inject.m` changes. They were read against the surrounding code carefully, but expect a possible typo-level build
fix. `git am` + build-ios.sh is the first check.

Guessed (nothing measured): the size of every gain above; that a meaningful share of CoreAnimation's offscreen targets fall
within 25 % of a pooled block (the 30-45 % exact hit rate says shapes drift, not by how much); UBWC safety of reused memory;
that the per-bind seed/lock/NSNumber cost is visible at all next to CoreAnimation's own work (`perf2:` answers that).

## Not done, and why

- Deferred recording on its own thread (hakios `metal_defer`): this runtime has no command list to defer (see top); it would be
  a record-and-replay layer over every `chl_*` call. Decide after `perf2:` shows `record` is a large share of `encode`.
- Lower render scale, async-commit A/B (`bgmtl-bb.sync` exists), per-draw GPU-side work: outside "above the driver" scope.
- Reference reading was shallow: from `oosexgang/hackios-xnu-kernel` only its CHANGELOG line (`metal_defer=1` records the window
  server's command buffers on a thread of its own, "a draw costs its render thread ~5 us instead of ~40") and the boot-arg check in
  `userland/src/HakiosMetalCA.m` were looked at, not its design. The bucket rule is from memory of freedreno's BO cache
  (power-of-two eighths). LMasterPiec3/UniXNU/Topaz were not read for this work. No code was copied; the pool and counters are
  new userland code, GPL-2.0-only SPDX where a header was added (user decision: GPL v2 acceptable for new userland code).
