# GPU userland performance plan (Chlorophyll / Adreno 630)

Status: research and plan, 2026-11-12. Nothing here was built or run on a phone.

## Basis and limits

- Chlorophyll is an empty submodule here. The clone of
  `ry-diffusion/chlorophyll` was blocked in this session (the Bash tool
  refused the `git clone`), so no source tree was available. What follows
  about Chlorophyll comes from public pages read through WebFetch:
  `docs/FIXES.md` and `src/bgmtl.m` (first ~100 KB of ~109 KB) on
  raw.githubusercontent.com. Function names below are as those pages show
  them; line numbers are unknown. Re-verify every file/function claim
  against the real source before editing.
- `docs/METAL_ADRENO630.md`, `docs/GPU_EAGL.md`, `docs/GPU_KERNEL.md` do not
  exist in this worktree, and NOTES.md here has no GPU perf entries, so the
  `frames:`/`perf:` formats were not checked locally. The one logging
  mechanism confirmed from upstream docs is `bgmtl-bb.perf` (per-second
  encode time, GPU wait, commit gap) plus `bgmtl-bb.sync` and
  `bgmtl-bb.inorder` flag files. Map those to our `perf:` line.
- Other projects' numbers (hakios, ios-sweet, UniXNU) are one-phone,
  different SoCs (Adreno 740/618), different panels. Use them for direction,
  not for expected gains on A630.
- hakios-metal's `docs/reference/metal.md` and `metal-measurements.md` were
  read from oosexgang/hakios-xnu-kernel. The "PM4 emitted directly" claim
  is a one-line statement there with no detail.

## What Chlorophyll does today (from the public source)

- `BGMTLCommandBuffer` records every command as a `BGWork` object (an
  autoreleased ObjC object with retained references and fixed binding
  arrays) in an `NSMutableArray`. All execution happens at `commit`, on
  the committing thread, under the single recursive mutex `bg_ctx_mutex`
  around the shared Gallium context.
- `setBytes:` allocates a new `BGMTLBuffer` (wrapping an `rwa_buffer`, i.e.
  a GEM BO), copies the bytes, parks it in `_scratch` until commit.
- `bgRecordDraw` snapshots all state into a new `BGWork` per draw.
- `commit` walks the array calling `rwa_render_draw` / `rwa_dispatch_buffers`
  / `rwa_render_clear`, then `rwa_flush` returns a fence; a serial queue
  `chlorophyll.completion` waits on it (`bg_fence_wait`, 2 retries) and
  runs `bgCompleteFrom` (IOSurface flush, seed bump, present, handlers).
- Textures: a destroy-time pool (24 entries, 48 MB, 2 s, `RWA_TEX_POOL=0`
  disables); BO cache keeps freed buffers 15 s; BO cache lookup skips busy
  entries (`patches/fd-bo-cache-skip-busy.patch`). FIXES.md says a
  full-screen target costs ~18 ms to allocate. Async commits took a frame
  from ~120 ms to ~20 ms; the kernel GPU scan-out copy plus async got the
  swipe test from 20.8 to 28.4 fps; pool plus libdrm stand-in 30 to 41 fps.
- FIXES.md: about 2/3 of backboardd CPU is CoreAnimation itself; in
  libbgair the main cost is uploads. Batch reordering (default) matters:
  `inorder` raised encode from ~12 to 20-26 ms.

## Reading our measurements against this

| Observation (NOTES) | Likely reading (guess, to be tested) |
|---|---|
| 3.4-7.5 us/draw in tests, 100-200 us/draw in backboardd | The difference is per-draw allocation (BGWork + per-setBytes BO via GEM_NEW and mmap + retains) and constant uploads, not `rwa_render_draw` itself. |
| Texture pool hit rate 30-45% | Pool key is exact size/format; CA sizes offscreen targets to the moving layer extent, so keys rarely repeat. |
| Encode 18-30 ms per frame, 160-270 draws | Roughly equals 7 draws per ms; consistent with above. Encode is single-threaded under `bg_ctx_mutex`. |
| ~7 ms GPU wait | Not purely GPU time. It includes the fence wait path and scan-out copy; ios-sweet reports the same 7 ms plus 4-8 ms display copy. |
| QuartzCore ~40% of backboardd, SpringBoard main saturated, 8 CPUs busy | Chlorophyll can only reclaim its own share. Reducing encode CPU also frees cores for CA/UIKit, which matters at saturation. |

## Ranked plan

Ranking is by (expected gain x confidence) / (risk x effort). Gains are
estimates for this stack; confidence is low-to-medium until measured.

### 1. Cheap buffer allocation per draw (area iii)  - do first

- Where: `BGMTLRenderEncoder setVertexBytes:/setFragmentBytes:` and the
  `_scratch` array in `src/bgmtl.m`; `rwa_buffer` creation in
  `air/air_metal.c`.
- Change: per-command-buffer (or per-queue ring) slab: allocate one
  1-4 MB `rwa_buffer`, mapped once, sub-allocate with 256 B alignment
  (Adreno UBO/constant alignment; match what `rwa` binds today) and bind
  `(slab, offset)`. `setBytes` becomes memcpy + bump pointer, no GEM_NEW, no
  `BGMTLBuffer` object, no `_scratch` retain. Retire slabs when the
  completion fence signals (recycle through a small free list of slabs, not
  the BO cache).
- Also: do not create a `BGMTLBuffer` object for the binding; store
  `{slab_handle, offset, length}` in `BGWork`. For constant data shared by
  successive draws (CA re-sets identical small structs), hash the bytes
  (<= 256 B) and reuse the previous offset (this is ios-sweet's
  "constant-upload caching").
- Expected: the largest single share of the 100-200 -> ~20-40 us/draw gap
  if setBytes is called 2-4 times per draw (likely for CA shaders). Could
  cut encode by 30-50%. Confidence medium.
- Risk: low-medium. Lifetime errors (slab recycled before GPU done) show as
  flicker/garbage; tie slab release strictly to the fence. Also keep
  honouring the existing 4 KB bound on unsized constant pointers.
- Measure: `perf:` encode ms/frame and draws/frame; add a counter of
  GEM_NEW per frame (expect hundreds -> ~1-3). `frames:` fps on the swipe
  test as before.
- Kernel ABI: none needed for the userland slab. A kernel-owned buffer
  option (ios-sweet) mainly saves GEM handle churn and the 4096-handle
  limit; defer.

### 2. Cheaper recording objects: replace BGWork objects with a plain struct arena (area i, prerequisite)

- Where: `BGWork` and `bgRecordDraw` / `bgRecord:` in `src/bgmtl.m`.
- Change: record into a per-command-buffer bump arena of POD structs (no
  ObjC alloc, no autorelease, no retain/release of every bound
  buffer/texture per draw). Retain only unique resources once per command
  buffer using a small open-addressed set; release at completion.
  Copy only the state that changed since the previous draw (delta
  encoding), since most CA draws share pipeline/attachments/scissor.
- Expected: 10-25% of encode CPU; it also makes (1)+(3) simpler.
  Confidence medium. Risk low-medium (reference-lifetime bugs).
- Measure: allocs per frame via Instruments-less counters
  (`malloc` stats) and `perf:` encode.

### 3. Deferred, threaded recording and execution (area i)

- Today `commit` replays the `BGWork` array synchronously under
  `bg_ctx_mutex` on the committing thread (backboardd's render thread,
  which is also CPU-starved by CA). hakios-metal reports `metal_defer=1`
  moving recording to a thread owned by the driver: 40 -> 5 us/draw on the
  caller side, and home-button 50 -> 89-92 fps (together with
  wallpaper_freeze; the gains are not separable in their data).
- Change in two steps:
  a. Make `commit` return after enqueueing the command buffer to a
     dedicated "chlorophyll.encode" thread (high QoS, pinned to a big
     core with `thread_policy`/QoS), which does the replay and
     `rwa_flush`. The committing thread only pays the recording cost
     (cheap after items 1-2). `scheduled` handlers fire on enqueue (existing
     `BGMTL_DEFER_SCHEDULED` semantic), completion stays on
     `chlorophyll.completion`. Ordering: one serial encode queue per
     `BGMTLCommandQueue` is enough; keep the single context mutex.
  b. Later, if profiles show replay is still > 8 ms: split replay of
     independent render passes. This conflicts with the single Gallium
     context; Turnip/freedreno batches are not thread-safe per context.
     Do not attempt without a measured need.
- Required care: `waitUntilCompleted`, `waitUntilScheduled`, drawable
  `present` ordering, and CPU-visible results from compute/blit that
  Chlorophyll currently satisfies with `rwa_finish` plus CPU copy: those
  must flush the encode queue first. Keep `bgmtl-bb.sync` as the escape
  hatch that disables the thread.
- Expected: moves 18-30 ms of encode off the compositor's critical thread;
  best case frame period becomes max(record, replay, GPU) instead of the
  sum. On a CPU-saturated 8-core system the gain is smaller than on
  hakios (their device was not saturated). Estimate +20-40% fps,
  confidence low-medium. Risk medium (ordering/latency bugs).
- Measure: `perf:` should report record ms (caller thread) and replay ms
  (encode thread) separately; `frames:` for fps and p95 frame gap.

### 4. Texture size bucketing and a better pool (area ii)

- Where: texture pool in `air/air_metal.c`/`rwa_*` (FIXES: 24 entries,
  48 MB, 2 s); texture creation in `BGMTLDevice newTextureWithDescriptor:`.
- Change (no semantic change to the app):
  - Allocate with padded dimensions rounded up to a bucket (e.g. width
    and height to multiples of 64 up to 512, then to 128 / 256, or next
    1.25x geometric step) while reporting the requested size to Metal;
    sample/viewport with the logical size. Requires that the logical
    size is respected for `rwa` texture state, any `get width/height`,
    blit/copy extents and IOSurface-backed textures (leave those exact).
    Only apply to non-imported, non-IOSurface render targets/textures
    (CA's offscreen groups, masks, blur inputs).
  - Pool keyed on (format, usage, bucketed w, bucketed h, sample count),
    not exact size. Raise limits: 96-128 MB and 2 s -> ~6-10 s for
    screen-sized render targets; evict LRU large first on memory pressure
    (jetsam level, and GEM_NEW failure path that already purges).
  - On reuse, the contents are undefined, matching Metal's semantics for
    private render targets (loadAction clear/dontCare). For shared
    textures the app may rely on zero-init: do not reuse those, or clear.
- Expected: hit rate 30-45% -> likely 70-90% for CA offscreen targets;
  each miss costs up to ~18 ms (full-screen) per FIXES.md, so this is a
  big win on animation frames that allocate. Confidence medium-high for
  hit rate, medium for fps.
- Risk: medium. Bugs show as sampling beyond the logical edge (edge
  bleed with bilinear): clamp UVs, or clear the padding on first use.
  Memory growth: bound by the pool cap.
- Measure: add `texpool:` hit/miss/alloc-bytes per second to the `perf:`
  line; target hit rate and number of full-screen allocs per frame.
  A synthetic check: animate a layer with a moving shadow and watch
  misses stay near zero.

### 5. Render at lower scale and scale at scan-out (area iv)

- hakios: `fbscale=2` (750x1624 -> 1125x2436 panel, 2.25x fewer pixels):
  scroll 90 -> 118-120, swipe ~100 -> 107-118, home 90 -> 95-111;
  softer image. Scan-out via CPU stretch with 6 threads.
- For us: fewer pixels helps only if the GPU or the fragment-bound
  fill is a bottleneck. Our reported split (7 ms GPU wait vs 18-30 ms
  encode) says encode dominates, so this is a lower-ranked item here and
  gives less than on hakios. It still reduces GPU wait, texture sizes
  (cheaper allocation misses, item 4) and bandwidth.
- Where: it must be done by backboardd's framebuffer/IOSurface size
  (display mode reported to CA), not inside Chlorophyll, otherwise
  drawable sizes mismatch UIKit's coordinate assumptions. Option:
  report a smaller render size to CA with the display `scale` kept and
  let the kernel's scan-out stretch it.
- Interaction with `sweetfb_scancopy` / direct mode (check against the
  kernel source; not read here): scancopy currently copies (and
  presumably 1:1) the IOSurface into the panel framebuffer. Adding a
  nearest/bilinear 2x upscale in that copy is the natural place. It
  costs CPU unless the display controller can scale (check DPU scaler
  support in `docs/DISPLAY_HW.md`; if the DPU can scale a plane,
  direct mode with a scaled plane is the cheapest, if not, NEON copy
  with 2x2 nearest/bilinear on several cores like hakios `fb_threads`).
  Direct (zero-copy) mode and software upscale are mutually exclusive
  unless the hardware scaler is used.
- Risk: medium (touch coordinates, text sharpness, screenshots). Make
  it a boot/env switch, default off, measure first.
- Measure: `frames:` fps and `perf:` GPU wait at scale 1 vs 2 on the
  swipe test; if GPU wait barely moves, drop the idea.

### 6. Fence and wait latency (area v)

- Today: serial `chlorophyll.completion` queue does the fence wait, then
  `bgCompleteFrom` does IOSurface flush/seed bump and present.
- Ideas, cheapest first:
  a. Run `chlorophyll.completion` at the same high QoS as the encode
     thread, otherwise it competes with CA on the saturated cores.
  b. Report `scheduled` immediately (already default) and avoid
     `rwa_finish` in the commit path for blit/copy: use GPU copies
     (already done where possible).
  c. If the fence wait is a kernel ioctl that blocks, ensure it is
     interruptible by a single completion port rather than polled; verify
     the kernel's wake-up path (`GPU_KERNEL.md` was not available to
     read). If the answer comes from polling, move to an interrupt
     driven wait (GMU/CP IRQ -> semaphore).
  d. Overlap: do not make the next frame's encode wait for the previous
     fence unless the swapchain (drawable pool) is exhausted; allow 3
     drawables so encode of frame N+1 overlaps GPU of N.
  e. Drop the double flush of IOSurfaces: do it only for surfaces CA/
     the display will read (kernel scan-out ones).
- Expected: shaves part of the ~7 ms wait from the critical path; real
  value is latency/jank, not average fps. Confidence low.
- Measure: `perf:` commit gap and GPU wait distribution (p50/p95, not
  only the average); add fence-signal-to-handler latency.

### 7. Things in other projects we lack (area vi)

- Pipeline/shader disk cache (UniXNU: Turnip IR3 output cached under the
  user cache dir; pipeline records replayed in the background at low
  priority). Cost for us today is first use of each AIR->NIR->ir3 compile.
  Cheap to add: key = hash(AIR bitcode, specialization constants, Mesa
  build id); store ir3 binary or NIR. Gains first-use stutter after boot,
  not steady-state.
- Per-pass GMEM vs sysmem choice and concurrent binning (UniXNU,
  Turnip). Chlorophyll runs Gallium freedreno: `FD_DBG_SYSMEM` is used
  for fb-fetch draws; consider heuristics in the Mesa fd6 gmem/sysmem
  decision for CA's many tiny passes (sysmem avoids tile load/store for
  < N draws). Needs experiments: set `FD_DBG` per pass sizes.
- Wallpaper freeze (hakios `wallpaper_freeze=1`): home button 50 -> 92
  fps there. In our case the wallpaper is a CA layer tree; freezing it
  to a single opaque bitmap view removes a blur/many-layer composite.
  It is an SpringBoard/backboardd-side hack, hackish but measurable
  quickly. Downsides: static wallpaper, lock screen shares image.
- `makeAliasable` and heap-based allocation, working-set cap
  (RAM/4 up to 2 GiB), deferred physical release/background free thread
  (UniXNU): moves BO free (munmap + GEM_CLOSE, which FIXES quantifies
  indirectly) off the render thread. We could do the same: release
  textures/buffers on a low-priority "chlorophyll.free" queue.
- Kernel-owned GPU buffers and UBO bound analysis (ios-sweet): NIR range
  analysis for constant pointers is partly present (FIXES, 4 KB bound);
  extend it so more CA shaders get a bounded upload instead of 4 KB
  default.
- Fb scan-out beam sync (hakios `fb_beam=1`): rows written behind scan
  line; fixes tearing at no fps cost. Relevant to our scancopy (kernel
  side), not to Chlorophyll.
- Measurement discipline: gpu timeline from CP timestamps and a
  records-over-8/16/33/100 ms histogram (UniXNU). We should add a
  per-pass GPU duration to `perf:`, otherwise "7 ms GPU wait" cannot be
  split into GPU work versus wait overhead.

## Suggested order and acceptance

1. Add measurement first (1 day): per-second `perf:` fields for GEM_NEW
   count, setBytes count, bytes uploaded, texpool hit/miss/bytes,
   record ms vs replay ms, p95 frame gap. Baseline on the same swipe/
   home-button script. Without it no item can be validated.
2. Items 1+2 (slab + POD recording). Accept if encode ms/frame drops
   >= 25% and no visual diff.
3. Item 4 (bucketed pool). Accept if full-screen allocs/frame -> ~0 in
   the swipe test.
4. Item 3 (encode thread), behind a flag defaulting off, then on.
5. Item 6 (QoS, drawable count), item 7 (shader cache, free thread).
6. Item 5 only if GPU wait stays > ~25% of frame after the above.

## Licensing

- Our decision (2026-11-12): NEW userland code may be GPL v2. Where that
  helps: copying/adapting Linux `drivers/gpu/drm/msm` logic (GEM/BO
  cache and submit paths, fence handling, userptr-style design) and the
  GPL-compatible Mesa pieces (Mesa itself is MIT, so no problem; Linux
  kernel headers are GPL-2.0 WITH syscall-note). A GPL v2 slab
  allocator or fence-wait design can lean on msm's `msm_gem_*`/
  `drm_sched` ideas directly.
- Chlorophyll's own code is MIT (`LICENSE.hackios-userland`, NOTICE.md
  mention provenance of the AIR frontend from hackios userland). Check
  those two files before merging patches; MIT code is GPL v2 compatible
  in the one direction (MIT may be included in a GPLv2 combination), but
  upstream patches must stay MIT to be upstreamable. If we want to
  upstream, keep new Chlorophyll patches MIT-licensed and use GPL only
  for code that lives in this repo's kernel-side/new modules.
- Still constrained: XNU kernel code is APSL 2.0 (not GPL
  compatible for combining into one work: APSL requires source
  availability of modifications and has patent/termination clauses that
  GPL v2 does not allow). So GPL code must not be linked into or pasted
  into the XNU kernel binary; kernel-side ABI additions in `xnu/`
  stay APSL. Userland loaded into Apple processes (injection into
  backboardd) is a separate work; GPL code there is fine for our
  distribution but must not be mixed into Apple's closed-source binaries
  (we only inject, no copying). Apple private headers/artifacts stay out
  of git (AGENTS.md).
- Not legal advice; ask before shipping binaries combining APSL and GPL.

## Not done / needs a phone

- No Chlorophyll source was obtained, so no patches were written
  (`gpu/chlorophyll-patches/` is intentionally absent).
- Every gain estimate above is unmeasured on the A630 phone. The user
  must run the baseline (step 1) and each item's measurement with
  `frames:`/`perf:`.
