<script lang="ts">
  import { session, PATCH_STAGES } from "./session.svelte.ts";
  import { patcherSupported, neededBytes, sshKeyProblem } from "../patcher/patcher.ts";
  import { profileForIpsw } from "../lib/profiles.ts";

  const need = $derived(Math.round(neededBytes(session.ipsw ? profileForIpsw(session.ipsw.name).profile?.id : null) / 2 ** 30));
  import { fmtBytes, fmtDuration } from "../lib/flasher.ts";

  const supported = patcherSupported();
  let now = $state(performance.now());
  // something to read during the long wait: a rotating line, nothing functional
  const FUN = [
    "Peeling pointer authentication off every binary, one by one…",
    "Teaching an iPhone XR that it lives in a OnePlus now…",
    "Convincing dyld that the shared cache is a perfectly normal Tuesday…",
    "Folding sixteen kilobytes of page into four: origami for kernels…",
    "Polishing the Adreno 630 so it shines in Metal…",
    "Signing everything ad hoc, with a very steady hand…",
    "Counting to 15 GiB, in HFS+…",
    "Making the little cores feel included…",
  ];
  let funAt = $state(0);
  $effect(() => {
    if (session.patchState !== "running") return;
    const t = setInterval(() => (funAt = (funAt + 1) % FUN.length), 7000);
    return () => clearInterval(t);
  });
  $effect(() => {
    if (session.patchState !== "running") return;
    const t = setInterval(() => (now = performance.now()), 500);
    return () => clearInterval(t);
  });
  const at = $derived(PATCH_STAGES.findIndex(([k]) => k === session.patchStage));
  const elapsed = $derived((now - session.patchStartedAt) / 1000);
  const keyProblem = $derived(sshKeyProblem(session.sshKey));
  const frac = $derived(session.patchBytes.total ? session.patchBytes.done / session.patchBytes.total : 0);
</script>

<section class="sheet" aria-labelledby="patch-title">
  {#if !supported}
    <h2 id="patch-title">This browser can't patch here.</h2>
    <p>Patching needs a Web Worker with the browser's private file storage (OPFS), as Chrome and Edge have. Open this page in one of those, or build the root with Renegade on a computer and flash it with <b>Flash an image</b>.</p>
    <div class="row"><button class="btn leaf" onclick={() => session.setPath("image")}>Flash an image I built</button></div>
  {:else if session.patchState === "idle"}
    <h2 id="patch-title">Patch the IPSW in this page.</h2>
    <p>The IPSW is read from your disk, decrypted, rewritten for the Snapdragon 845 (a processor without pointer authentication) and written as a root image into this browser's private storage (about {need} GB). Nothing leaves your computer; the only download is Apple's decryption key (on a static host like GitHub Pages you fetch it yourself with one click when asked).</p>
    <ol class="stages">
      {#each PATCH_STAGES as [, text]}<li>{text}</li>{/each}
    </ol>
    <label class="key">
      <span><b>Your SSH public key</b> (optional, recommended)</span>
      <input bind:value={session.sshKey} placeholder="ssh-ed25519 AAAA… you@computer" autocomplete="off" spellcheck="false" aria-invalid={!!keyProblem} />
      <small class:problem={!!keyProblem}>{keyProblem ?? "The phone runs an SSH server (over the USB cable) that only this key can open. Without a key there is no SSH. Paste the contents of ~/.ssh/id_ed25519.pub, never the private key."}</small>
    </label>
    <p class="gpu-note"><b>GPU 3D is included.</b> The root gets the Chlorophyll graphics driver and backboardd is wired to it, so there is nothing to switch on afterwards. It only goes live when the boot image you boot carries the GPU arguments (<code>tools/install/build-boot.sh</code>, see INSTALL.md); otherwise the phone draws on the CPU, as before.</p>
    <p class="muted">It takes a while: tens of minutes on a laptop. Keep this tab open and the computer awake.</p>
    <div class="row">
      <button class="btn leaf" disabled={!!keyProblem} onclick={() => session.startPatch()}>Start patching</button>
      <button class="btn ghost" onclick={() => session.setPath("image")}>Flash an image I built</button>
    </div>
  {:else if session.patchState === "running" && session.keysNeeded.length}
    <h2 id="patch-title">One click needed: Apple's decryption key.</h2>
    <p>iOS 18's disk images are encrypted with a key Apple publishes. This site is static (GitHub Pages), so it can't fetch it for you: your browser can. Open each link — Chrome downloads (or shows) a small key file from Apple — then drop that file below, or paste its text. Nothing is uploaded.</p>
    <ol class="keys">
      {#each session.keysNeeded as url, i}
        <li class:ok={!!session.keysGot[url]}>
          <a class="btn ghost" href={url} target="_blank" rel="noopener">Open key {i + 1} from Apple</a>
          {#if session.keysGot[url]}
            <span class="got">✓ key {i + 1} received</span>
          {:else}
            <input type="file" aria-label={`Key file ${i + 1}`} onchange={async (e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f) session.provideKey(url, await f.text()); }} />
            <textarea rows="2" placeholder="…or paste -----BEGIN PRIVATE KEY----- …" aria-label={`Paste key ${i + 1}`} onchange={(e) => session.provideKey(url, (e.currentTarget as HTMLTextAreaElement).value)}></textarea>
          {/if}
          <small class="url">{url}</small>
        </li>
      {/each}
    </ol>
    {#if session.keyError}<p class="problem" role="alert">{session.keyError}</p>{/if}
    <div class="row"><button class="btn ghost" onclick={() => session.cancelPatch()}>Cancel</button></div>
  {:else if session.patchState === "running"}
    <h2 id="patch-title">Patching…</h2>
    <ol class="stages live">
      {#each PATCH_STAGES as [, text], i}
        <li class:done={i < at} class:now={i === at}>{text}{#if i === at && session.patchStage === "seal" && frac > 0} <b>{Math.floor(frac * 100)}%</b>{/if}</li>
      {/each}
    </ol>
    <div class="bar" role="progressbar" aria-label="Patch progress" aria-valuenow={Math.floor((at + frac) * 100 / PATCH_STAGES.length)} aria-valuemin={0} aria-valuemax={100}>
      <i style="width: {Math.min(100, ((Math.max(at, 0) + (session.patchStage === 'seal' ? frac : 0)) / PATCH_STAGES.length) * 100)}%"></i>
    </div>
    <p class="muted note" aria-live="off">{session.patchNote}</p>
    <p class="fun" aria-hidden="true">{FUN[funAt]}</p>
    <div class="meta"><span>{session.patchBytes.total ? `${fmtBytes(session.patchBytes.done)} of ${fmtBytes(session.patchBytes.total)}` : "working"}</span><span>{fmtDuration(elapsed)}</span></div>
    <div class="row"><button class="btn ghost" onclick={() => session.cancelPatch()}>Cancel</button></div>
  {:else if session.patchState === "done"}
    <h2 id="patch-title">The root is ready. Fresh out of the oven.</h2>
    <p>
      {session.patchInfo ? `iOS ${session.patchInfo.version} (${session.patchInfo.build}) for ${session.patchInfo.device}` : "The root"} is in this browser as <code>{session.picked?.name}</code>{#if session.picked} ({fmtBytes(session.picked.size)}){/if}. Next, connect the phone.
    </p>
    {#if session.patchGpu?.ok}
      <p class="gpu ok" role="status"><b>GPU 3D: included.</b> Chlorophyll is in the root and backboardd is wired to it (armed). It starts on the GPU when the boot image has the GPU arguments; the kill switch and the recovery boot-arg are in INSTALL.md.</p>
    {:else}
      <p class="gpu no" role="status"><b>GPU 3D: not in this root.</b> {session.patchGpu?.text ?? "The build did not report Chlorophyll."} The phone will draw on the CPU. Run the Chlorophyll workflow, republish this site and patch again to get it.</p>
    {/if}
    <div class="row"><button class="btn leaf" onclick={() => session.go("Connect")}>Connect the phone</button></div>
  {:else}
    <h2 id="patch-title">Patching stopped.</h2>
    <p class="problem" role="alert">{session.patchError}</p>
    <div class="row">
      <button class="btn leaf" onclick={() => session.startPatch()}>Try again</button>
      {#if session.roomShort && !session.ignoreRoom}
        <button class="btn ghost" onclick={() => { session.ignoreRoom = true; session.startPatch(); }}>Patch anyway (my disk has the room)</button>
      {/if}
      <button class="btn ghost" onclick={() => session.go("IPSW")}>Choose another IPSW</button>
    </div>
  {/if}
</section>

<style>
  .gpu-note { margin: 0 0 14px; }
  .gpu { margin: 12px 0 16px; padding: 10px 14px; border: 2px solid var(--ink); border-radius: 4px; }
  .gpu.ok { border-color: var(--leaf); }
  .gpu.no { border-color: #b3261e; color: #6b1d0c; }
  .key { display: grid; gap: 6px; margin: 4px 0 18px; font-size: 15px; }
  .key input { font: 500 14px var(--mono); padding: 12px 14px; border: 2px solid var(--ink); border-radius: 4px; background: var(--white); min-width: 0; }
  .key input[aria-invalid="true"] { border-color: #b3261e; }
  .key small { color: var(--ink-soft); }
  .key small.problem { color: #6b1d0c; }
  .keys { margin: 8px 0 16px; padding-left: 22px; display: grid; gap: 14px; }
  .keys li { display: grid; gap: 8px; }
  .keys li.ok { color: var(--ink-soft); }
  .keys .btn { justify-self: start; }
  .keys textarea { font: 500 12.5px var(--mono); padding: 8px 10px; border: 2px solid var(--ink); border-radius: 4px; background: var(--white); resize: vertical; }
  .keys .got { font-weight: 800; color: var(--leaf); }
  .keys .url { font: 400 11.5px var(--mono); color: var(--ink-soft); overflow-wrap: anywhere; }
  .stages { margin: 6px 0 18px; padding-left: 22px; display: grid; gap: 4px; color: var(--ink-soft); }
  .live li.done { color: var(--ink); text-decoration: line-through; text-decoration-thickness: 2px; }
  .live li.now { color: var(--ink); font-weight: 800; }
  .bar { height: 14px; background: #dddbd0; border-radius: 999px; overflow: hidden; margin: 22px 0 14px; }
  .bar i { display: block; height: 100%; background: var(--leaf); border-radius: 999px; transition: width 400ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  .fun { margin: 0 0 10px; font-style: italic; color: var(--ink-soft); min-height: 1.4em; }
  .note { margin: 0 0 10px; font: 400 13px var(--mono); overflow-wrap: anywhere; }
  .meta { display: flex; justify-content: space-between; font: 400 14px var(--mono); color: var(--ink-soft); font-variant-numeric: tabular-nums; }
</style>
