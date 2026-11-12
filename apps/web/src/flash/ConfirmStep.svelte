<script lang="ts">
  import { session } from "./session.svelte.ts";
  import { fmtBytes, fmtDuration, productName } from "../lib/flasher.ts";
  import { BACKUP_TEXT, confirmPhrase, normalizeSlot, writeProblems } from "../lib/guards.ts";

  let typed = $state("");
  const c = $derived(session.checked!);
  const phone = $derived(session.phone!);
  const total = $derived(c ? c.pieces.reduce((n, p) => n + p.bytes, 0) : 0);
  // ABL moved a 15 GB root in about 7 minutes (36 MB/s); used only for the estimate
  const eta = $derived(total / 36e6);
  const warn: Record<string, [string, string]> = {
    userdata: ["This replaces everything in userdata.", "Android's apps, photos and settings on this phone are erased. Nothing else on the phone is touched."],
    boot: ["This replaces the boot partition with Enxerto.", "The phone will start Bergamota's bootloader instead of Android's kernel. Nothing else is touched."],
    logo: ["This replaces the boot splash.", "Only the logo partition is written."],
  };
  const phrase = $derived(confirmPhrase(session.partition, phone));
  const gate = $derived(writeProblems(session.partition, phone, session.backupAck));
  const needsBackup = $derived(session.partition === "boot" || session.partition === "userdata");
  const slot = $derived(normalizeSlot(phone.currentSlot));
  const ready = $derived(typed.trim() === phrase && !gate.length && !!c && !c.problems.length && !session.phoneProblems.length && !!session.fb);
  // Booting a boot image writes nothing, so it needs no typed confirmation — just a valid image on a connected phone.
  const canBoot = $derived(session.partition === "boot" && !!c && !c.problems.length && !session.phoneProblems.length && !!session.fb);
</script>

<section class="sheet" aria-labelledby="confirm-title">
  <div class="warn">
    <b id="confirm-title">{warn[session.partition][0]}</b>
    {warn[session.partition][1]}
  </div>
  <table class="summary">
    <tbody>
      <tr><td>Phone</td><td>{productName(phone.product)} ({phone.product}), {phone.kind === "bergamota" ? `Bergamota fastboot ${phone.bootloader}` : "ABL fastboot"}</td></tr>
      <tr><td>Partition</td><td>{session.partition === "boot" && slot ? `boot (the active slot: ${phrase})` : session.partition}{phone.partitionSize[session.partition] ? ` · ${fmtBytes(phone.partitionSize[session.partition]!)}` : ""}</td></tr>
      <tr><td>Image</td><td>{session.picked?.name} · {fmtBytes(session.picked?.size ?? 0)}{c.image.sparse ? " sparse" : ""}</td></tr>
      <tr><td>Sent as</td><td>{c.pieces.length === 1 ? "one piece" : `${c.pieces.length} pieces of up to ${fmtBytes(Math.max(...c.pieces.map((p) => p.bytes)))}`}</td></tr>
      <tr><td>Estimated time</td><td>about {fmtDuration(eta)} at 36 MB/s</td></tr>
      <tr><td>Afterwards</td><td>{session.rebootWhenDone ? "the phone restarts" : "the phone stays in fastboot"}</td></tr>
    </tbody>
  </table>
  {#if session.partition === "boot"}
    <div class="test">
      <div class="test-txt">
        <b>Just testing?</b>
        <span>Boot this image once <b>without writing anything</b> (<code>fastboot boot</code>). The phone runs it now; the next restart returns to normal. The safe way to try an Enxerto or kernel build.</span>
      </div>
      <button class="btn leaf" disabled={!canBoot} onclick={() => session.startBoot()}>Boot once (test)</button>
    </div>
  {/if}

  {#if needsBackup}
    <label class="backup">
      <input type="checkbox" bind:checked={session.backupAck} />
      <span>{BACKUP_TEXT}</span>
    </label>
  {/if}
  {#each gate.filter((g) => !/backup box/.test(g)) as g}<p class="problem">{g}</p>{/each}

  <label class="type">
    <span>{session.partition === "boot" ? "Or write it for good — type" : "Type"} <b>{phrase}</b> to confirm</span>
    <span class="confirm-row">
      <input bind:value={typed} autocomplete="off" spellcheck="false" aria-label={`Type ${phrase} to confirm`} />
      <button class="btn danger" disabled={!ready} onclick={() => session.startFlash()}>Flash {session.partition}</button>
    </span>
  </label>
  {#if !session.fb}<p class="problem">The phone is not connected any more. Go back to Connect.</p>{/if}
</section>

<style>
  .warn { background: var(--warn); color: var(--white); padding: 22px 24px; border-radius: 4px; margin: 0 0 22px; }
  .warn b { font-size: 24px; font-weight: 850; display: block; margin-bottom: 4px; }
  .test { display: flex; align-items: center; justify-content: space-between; gap: 18px; flex-wrap: wrap; background: var(--paper); border: 2px solid var(--leaf); border-radius: 8px; padding: 18px 20px; margin: 0 0 20px; }
  .test-txt { display: grid; gap: 4px; max-width: 46ch; }
  .test-txt b { font-size: 17px; }
  .test-txt span { font-size: 14px; color: var(--ink-soft); }
  .test .btn { white-space: nowrap; }
  .backup { display: flex; gap: 12px; align-items: flex-start; margin: 0 0 16px; font-size: 15px; }
  .backup input { flex: none; min-width: 0; width: 20px; height: 20px; margin-top: 2px; padding: 0; }
  .type { display: grid; gap: 8px; font-size: 15px; }
  .confirm-row { display: flex; gap: 14px; flex-wrap: wrap; }
  input { flex: 1; min-width: 180px; font: 600 16px var(--mono); padding: 14px 16px; border: 2px solid var(--ink); border-radius: 4px; background: var(--white); }
</style>
