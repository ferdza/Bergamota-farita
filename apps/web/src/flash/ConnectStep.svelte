<script lang="ts">
  import { session } from "./session.svelte.ts";
  import { productName } from "../lib/flasher.ts";
  import { identityVerdict, OVERRIDE_PHRASE } from "../lib/guards.ts";

  const unverified = $derived(!!session.phone && identityVerdict({ product: session.phone.product, kind: session.phone.kind, slotCount: session.phone.slotCount, vars: session.phone.vars }).level === "unverified");

  const ok = $derived(!!session.phone && !session.phoneProblems.length);
  const udev = 'SUBSYSTEM=="usb", ATTR{idVendor}=="18d1", MODE="0660", TAG+="uaccess"';
</script>

<section class="sheet" aria-labelledby="connect-title">
  {#if session.phone}
    <div class="chip" class:bad={!ok}>
      <i class="dot"></i>
      <b>{ok ? `${productName(session.phone.product)} found` : "Phone found"}</b>
      <span>{session.phone.product ?? "unknown"} · {session.phone.kind === "bergamota" ? "Bergamota fastboot" : "ABL fastboot"}{session.phone.unlocked === "yes" ? " · unlocked" : ""}</span>
    </div>
  {/if}

  {#if ok}
    <h2 id="connect-title">Your phone is connected.</h2>
    <p>Nothing has been written. Next, {session.path === "patch" ? "confirm what goes on it" : "choose what to put on it"}.</p>
    <div class="row">
      <button class="btn leaf" onclick={() => session.go(session.path === "patch" ? "Confirm" : "Choose")}>Continue</button>
      <button class="btn ghost" onclick={() => session.connect()}>Use another phone</button>
    </div>
  {:else}
    <h2 id="connect-title">Put your phone in fastboot and plug it in.</h2>
    <p>Hold <b>Power + Volume down</b> until the fastboot screen appears, or boot Bergamota fastboot from Enxerto. Then let this page find it. Nothing is written yet.</p>
    {#each session.phoneProblems as p}
      <p class="problem">{p}</p>
    {/each}
    {#if unverified && session.phone}
      <table class="vars">
        <tbody>
          {#each session.phone.vars as [k, v]}<tr><td>{k}</td><td>{v}</td></tr>{/each}
        </tbody>
      </table>
      <label class="override">
        <span>Type <b>{OVERRIDE_PHRASE}</b> to confirm this is the phone you mean</span>
        <input bind:value={session.identityOverride} autocomplete="off" spellcheck="false" aria-label="Confirm the phone is a OnePlus 6T" />
      </label>
    {/if}
    {#if session.connectError}
      <p class="problem" role="alert">{session.connectError}</p>
    {/if}
    <div class="row">
      <button class="btn leaf" disabled={session.connecting} onclick={() => session.connect()}>{session.connecting ? "Talking to the phone…" : "Find my phone"}</button>
    </div>
  {/if}

  <div class="note">
    <div>
      <b>Linux</b>
      Chrome needs permission to open the fastboot device. Add this udev rule (for example in <code>/etc/udev/rules.d/51-android.rules</code>), run <code>sudo udevadm control --reload</code>, then replug:
      <pre>{udev}</pre>
    </div>
    <div>
      <b>Windows</b>
      The fastboot device must use the WinUSB driver. If the phone does not show up in the picker, install Google's USB driver, or bind WinUSB to "Android" with Zadig, then replug.
      <b style="margin-top: 14px">macOS, ChromeOS</b>
      No setup. Close <code>fastboot</code>, <code>adb</code> and the Bergamota app first: only one program can hold the phone.
    </div>
  </div>
</section>

<style>
  .vars { font: 13px var(--mono); border-collapse: collapse; margin: 0 0 14px; }
  .vars td { padding: 2px 14px 2px 0; vertical-align: top; word-break: break-all; }
  .override { display: grid; gap: 8px; font-size: 15px; margin: 0 0 14px; }
  .override input { font: 600 16px var(--mono); padding: 12px 14px; border: 2px solid var(--ink); border-radius: 4px; background: var(--white); max-width: 360px; }
</style>
