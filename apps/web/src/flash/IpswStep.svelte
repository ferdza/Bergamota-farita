<script lang="ts">
  import { session } from "./session.svelte.ts";
  import FilePick from "./FilePick.svelte";
  import { PROFILES, profileForIpsw } from "../lib/profiles.ts";
  import { fmtBytes } from "../lib/flasher.ts";

  const found = $derived(session.ipsw ? profileForIpsw(session.ipsw.name) : null);
</script>

<section class="sheet" aria-labelledby="ipsw-title">
  <h2 id="ipsw-title">Start with Apple's IPSW for the iPhone.</h2>
  <p>Bergamota runs the iOS userland of a real iPhone. Apple ships one restore file (IPSW) per build, so grab the <b>exact</b> one below — any other version has no profile. It downloads straight from Apple, is read on this computer, and is never uploaded.</p>

  <div class="get">
    <span class="lead">Download the exact IPSW from Apple:</span>
    {#each PROFILES as p, i}
      <a class="ipsw-link" href={p.url} rel="noopener">
        <span class="name">{p.model} · iOS {p.version} <span class="build">({p.build})</span></span>
        <span class="meta">{p.device}_{p.version}_{p.build}_Restore.ipsw · {fmtBytes(p.size)}{#if i === 0} · recommended{/if}</span>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M10 3v10m0 0l-4-4m4 4l4-4M4 17h12" /></svg>
      </a>
    {/each}
    <small class="muted">These are Apple's own servers (<code>updates.cdn-apple.com</code>). Nothing is hosted here. Then drop the file below.</small>
  </div>

  <FilePick accept=".ipsw" label="IPSW file" has={!!session.ipsw} onfile={(f) => (session.ipsw = f)}>
    {#snippet children()}
      {#if session.ipsw}
        <b>{session.ipsw.name}</b>
        <small>
          {fmtBytes(session.ipsw.size)}
          {#if found?.profile} · iOS {found.profile.version} ({found.profile.build}) · {found.profile.model} · profile {found.profile.id}{/if}
        </small>
      {/if}
    {/snippet}
  </FilePick>

  {#if session.ipsw && !found?.profile}
    <p class="problem">
      {#if found?.device}This is iOS {found.version} ({found.build}) for {found.device}, which Renegade has no profile for.{:else}This does not look like an Apple restore IPSW (<code>Device_Version_Build_Restore.ipsw</code>).{/if}
      Supported: {#each PROFILES as p, i}{i ? " or " : ""}<b>{p.device}_{p.version}_{p.build}_Restore.ipsw</b>{/each}.
    </p>
  {/if}

  <p class="muted" style="margin-top: 20px">Patching needs free disk space for this browser: about 17 GB for iOS 18, 22 GB for iOS 26 (Chrome's limit follows the free space of the disk holding your browser profile). The finished root image stays in the browser's private storage until you flash it.</p>
  <div class="row">
    <button class="btn leaf" disabled={!found?.profile} onclick={() => session.go("Patch")}>Patch it</button>
  </div>
</section>

<style>
  .get { display: grid; gap: 8px; margin: 18px 0 6px; }
  .get .lead { font-weight: 700; font-size: 15px; }
  .ipsw-link {
    display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 2px 14px;
    padding: 14px 18px; background: var(--white); border: 2px solid var(--ink); border-radius: 6px;
    text-decoration: none; color: inherit; transition: background-color 140ms, transform 140ms;
  }
  .ipsw-link:hover { background: var(--ground); transform: translateY(-1px); }
  .ipsw-link .name { grid-column: 1; font-size: 17px; font-weight: 800; }
  .ipsw-link .build { font-weight: 600; color: var(--ink-soft); }
  .ipsw-link .meta { grid-column: 1; font: 400 12.5px var(--mono); color: var(--ink-soft); word-break: break-all; }
  .ipsw-link svg { grid-column: 2; grid-row: 1 / span 2; width: 22px; height: 22px; }
  .get small code { font-size: 12px; }
</style>
