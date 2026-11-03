<script lang="ts">
  import { session } from "./session.svelte.ts";
  import FilePick from "./FilePick.svelte";
  import type { Partition } from "../lib/fastboot.ts";
  import { fmtBytes, productName } from "../lib/flasher.ts";
  import { storedImages, removeStored, type StoredImage } from "../patcher/patcher.ts";

  const targets: { p: Partition; name: string; what: string; accept: string }[] = [
    { p: "userdata", name: "iOS root", what: "userdata · .simg", accept: ".simg,.img" },
    { p: "boot", name: "Enxerto", what: "boot · boot.img", accept: ".img" },
    { p: "logo", name: "Splash", what: "logo · logo.img", accept: ".img" },
  ];
  const accept = $derived(targets.find((t) => t.p === session.partition)!.accept);

  // images a patcher run left in this browser's private storage (OPFS)
  let stored = $state<StoredImage[]>([]);
  async function loadStored() {
    stored = await storedImages();
  }
  $effect(() => {
    // re-list whenever the chosen image changes (a delete clears it)
    session.picked;
    loadStored();
  });

  async function trash(s: StoredImage) {
    if (!confirm(`Delete "${s.name}" (${fmtBytes(s.size)}) from this browser's storage? The IPSW on your disk is untouched; you would patch again to recreate it.`)) return;
    await removeStored(s.name);
    if (session.picked?.from === "browser" && session.picked.name === s.name) session.forgetPicked();
    await loadStored();
  }

  const c = $derived(session.checked);
</script>

<section class="sheet" aria-labelledby="choose-title">
  {#if session.phone}
    <div class="chip"><i class="dot"></i><b>{productName(session.phone.product)} found</b><span>{session.phone.kind === "bergamota" ? "Bergamota fastboot" : "ABL fastboot"} · unlocked</span></div>
  {/if}
  <h2 id="choose-title">What do you want to write?</h2>

  <div class="targets" role="radiogroup" aria-label="Partition">
    {#each targets as t}
      <button role="radio" aria-checked={session.partition === t.p} class:on={session.partition === t.p} onclick={() => session.setPartition(t.p)}>
        <b>{t.name}</b><small>{t.what}</small>
      </button>
    {/each}
  </div>

  <FilePick {accept} label="Image file" has={!!session.picked} onfile={(f) => session.pick(f, f.name, "file")}>
    {#snippet children()}
      {#if session.picked}
        <b>{session.picked.name}</b>
        <small>
          {fmtBytes(session.picked.size)}
          {#if c}· {c.image.sparse ? "Android sparse" : "raw"} · expands to {fmtBytes(c.image.expandedBytes)}{/if}
          {#if session.checking}· reading…{/if}
        </small>
      {/if}
    {/snippet}
  </FilePick>

  {#if stored.length}
    <div class="stored">
      <span class="muted">In this browser:</span>
      {#each stored as s}
        <span class="pill" class:on={session.picked?.from === "browser" && session.picked.name === s.name}>
          <button class="use" onclick={() => session.pick(s.file, s.name, "browser")}>{s.name} · {fmtBytes(s.size)}</button>
          <button class="bin" title="Delete this image from the browser" aria-label={`Delete ${s.name} from the browser`} onclick={() => trash(s)}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2m-6 0 .7 9.3a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L15 6M8.5 9v4m3-4v4" /></svg>
          </button>
        </span>
      {/each}
    </div>
  {/if}

  {#if session.checkError}<p class="problem" role="alert">{session.checkError}</p>{/if}
  {#each c?.problems ?? [] as p}<p class="problem">{p}</p>{/each}

  <p class="muted" style="margin-top: 20px">The file stays on this computer. It is read in pieces while flashing, never uploaded.</p>
  <div class="row">
    <button class="btn" disabled={!c || c.problems.length > 0 || session.checking} onclick={() => session.go("Confirm")}>Continue</button>
  </div>
</section>

<style>
  .targets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 4px 0 20px; }
  .targets button { text-align: left; padding: 16px; border: 2px dashed var(--ink-faint); border-radius: 4px; background: transparent; cursor: pointer; transition: border-color 160ms, background-color 160ms; }
  .targets button:hover { border-color: var(--ink); }
  .targets button.on { border: 2px solid var(--ink); background: var(--white); }
  .targets b { display: block; font-size: 20px; font-weight: 850; }
  .targets small { font-size: 13px; color: var(--ink-soft); }
  .stored { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
  .pill { display: inline-flex; align-items: stretch; background: var(--white); border-radius: 999px; box-shadow: inset 0 0 0 1px var(--paper-line); overflow: hidden; }
  .pill.on { box-shadow: inset 0 0 0 2px var(--ink); }
  .pill .use { border: 0; background: transparent; padding: 8px 6px 8px 14px; font: 600 13px var(--mono); cursor: pointer; color: inherit; }
  .pill .bin { border: 0; background: transparent; padding: 0 12px 0 8px; cursor: pointer; color: var(--ink-soft); display: inline-flex; align-items: center; border-left: 1px solid var(--paper-line); }
  .pill .bin:hover { color: #b3261e; background: color-mix(in srgb, #b3261e 10%, transparent); }
  .pill .bin svg { width: 16px; height: 16px; }
  @media (max-width: 600px) { .targets { grid-template-columns: 1fr; } }
</style>
