<script lang="ts">
  import { log, TAGS } from "./logsession.svelte.ts";
  import { UsbNet } from "../lib/usbnet.ts";
  import { HOST_IP, PHONE_IP, LOG_PORT } from "../lib/ethernet.ts";
  import { sshs } from "./sshsession.svelte.ts";
  import Terminal from "./Terminal.svelte";

  const base = import.meta.env.BASE_URL;
  const supported = log.supported;

  let viewEl: HTMLElement | undefined = $state();
  // follow the tail unless the user turned it off or paused
  $effect(() => {
    log.visible.length;
    if (viewEl && log.follow && !log.paused) viewEl.scrollTop = viewEl.scrollHeight;
  });

  // reconnect a device this origin already knows (no picker), if one is plugged in
  $effect(() => {
    if (!supported) return;
    UsbNet.known().then((d) => {
      if (d[0] && log.state === "idle") log.connect(d[0]);
    });
  });

  const udevCmd =
    `echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="1209", ATTR{idProduct}=="0001", MODE="0660", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/51-bergamota-net.rules\nsudo udevadm control --reload && sudo udevadm trigger`;
  // the phone's interface is the one with the host MAC the phone advertises (02:00:5e:77:ee:01)
  const unbindCmd =
    `D=$(basename "$(readlink -f /sys/class/net/$(ip -br link | awk 'tolower($3)=="02:00:5e:77:ee:01"{print $1}')/device)")\necho -n "$D" | sudo tee /sys/bus/usb/drivers/cdc_ether/unbind`;

  // send any file to the phone (firmware, test tools)
  let upFile = $state<File | null>(null);
  let upPath = $state("/var/root/");
  let upMode = $state("755");

  const klass = (tags: number) => (tags & (1 << 4) ? "crash" : tags & 0b1111 ? "sweet" : "");
</script>

<div class="page">
  <header class="top">
    <a class="mark" href={base}><img src="{base}favicon.svg" alt="" width="32" height="32" /> Bergamota <span>Live log</span></a>
    <nav><a href={base}>Home</a><a href="{base}flash/">Flash</a></nav>
  </header>

  {#if !supported}
    <section class="sheet">
      <h2>This browser can't read the phone's log.</h2>
      <p>The live log uses WebUSB, which Chrome and Edge have on desktop computers. Open this page there.</p>
    </section>
  {:else}
    <section class="bar" class:live={log.state === "live"}>
      {#if log.state === "live"}
        <div class="who">
          <i class="dot"></i>
          <div>
            <b>{log.deviceName}</b>
            <small>{PHONE_IP} → {HOST_IP}:{LOG_PORT} · link {log.linkUp === null ? "?" : log.linkUp ? "up" : "DOWN"}</small>
            <small class="diag">frames {log.stats.frames} · ARP in {log.stats.arpRequests}/out {log.arpReplies} · IPv4 {log.stats.ipv4} · log {log.stats.logDatagrams} · other UDP {log.stats.otherUdp}{log.stats.otherUdp ? ` (last :${log.stats.lastUdpPort})` : ""} · non-IP {log.stats.otherEth}{log.stats.last ? ` · last ${log.stats.last}` : ""}</small>
          </div>
        </div>
        <div class="stats">
          <span><b>{log.total.toLocaleString()}</b> lines</span>
          <span><b>{log.linesPerSec}</b>/s</span>
          <button class="btn ghost" onclick={() => log.disconnect()}>Disconnect</button>
        </div>
      {:else}
        <div class="who">
          <i class="dot off"></i>
          <div>
            <b>Not connected</b>
            <small>Boot the phone into iOS with USB networking, then connect.</small>
          </div>
        </div>
        <button class="btn leaf" disabled={log.state === "connecting"} onclick={() => log.connect()}>{log.state === "connecting" ? "Connecting…" : "Connect the phone"}</button>
      {/if}
    </section>

    {#if log.error}<p class="problem" role="alert">{log.error}</p>{/if}
    {#if log.setup}
      <section class="sheet osnet">
        <h2>{log.setup === "access" ? "Your computer doesn't let the browser open the phone yet." : "Your computer's own network driver holds the phone."}</h2>
        <p>Good news first: the phone answered on USB, so iOS is up. On Linux, two commands hand it to this page.</p>
        <p><b>1. Once:</b> let your user open the phone's USB network device (<code>1209:0001</code>), like the fastboot rule:</p>
        <pre>{udevCmd}</pre>
        <p><b>2. Each time the phone boots iOS:</b> take the interface away from <code>cdc_ether</code> (the system's driver), then press Connect:</p>
        <pre>{unbindCmd}</pre>
        <p class="muted">While this page holds it, your computer's own <code>ping</code>/<code>ssh</code> to {PHONE_IP} stop; to give it back, replug the cable or run the same line with <code>bind</code> instead of <code>unbind</code>.</p>
        <div class="row"><button class="btn leaf" onclick={() => log.connect()}>Connect again</button></div>
        {#if log.rawError}<p class="muted">Browser said: <code>{log.rawError}</code></p>{/if}
      </section>
    {:else if log.rawError}
      <p class="muted raw">Browser said: <code>{log.rawError}</code></p>
    {/if}

    {#if log.state === "live"}
      <section class="sheet ssh" aria-labelledby="ssh-title">
        <div class="ssh-head">
          <h2 id="ssh-title">SSH</h2>
          <span class="tag" class:on={sshs.state === "ready"}>{sshs.state === "ready" ? "connected" : sshs.state === "connecting" ? "connecting…" : "not connected"}</span>
        </div>
        {#if sshs.state !== "ready"}
          {#if sshs.rebooting}<p class="ok">The phone is rebooting ({sshs.rebooting}). Reconnect it when it is back.</p>{/if}
          <label class="key">
            <span>Your SSH <b>private</b> key (<code>~/.ssh/id_ed25519</code>). It stays in this tab: never stored, never sent anywhere.</span>
            <textarea bind:value={sshs.keyText} oninput={() => sshs.checkKey()} rows="4" spellcheck="false" autocomplete="off" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
          </label>
          {#if sshs.keyError}<p class="problem">{sshs.keyError}</p>{/if}
          {#if sshs.pub}<p class="muted">Its public half, which must be the one you gave when patching: <code class="pub">{sshs.pub}</code></p>{/if}
          <div class="row"><button class="btn leaf" disabled={sshs.state === "connecting" || !sshs.keyText.trim()} onclick={() => sshs.connect()}>{sshs.state === "connecting" ? "Connecting…" : "Connect SSH"}</button></div>
          {#if sshs.error}<p class="problem" role="alert">{sshs.error}</p>{/if}
        {:else}
          <p class="muted">root@{PHONE_IP} · {sshs.server} · host key <code>{sshs.fingerprint}</code></p>
          <div class="row acts2">
            <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.fetchKernelLog()}>Full kernel log (dmesg)</button>
            <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.topCpu()}>Top CPU</button>
            <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.installTools()}>Install tools (sweetlog…)</button>
            <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.reboot("fastboot")}>Reboot to fastboot</button>
            <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.reboot("normal")}>Reboot</button>
            <button class="btn ghost" onclick={() => sshs.disconnect()}>Disconnect</button>
          </div>
          {#if sshs.busy}<p class="muted">{sshs.busy}</p>{/if}
          {#if sshs.error}<p class="problem">{sshs.error}</p>{/if}
          {#if sshs.output}<pre class="out">{sshs.output}</pre>{/if}
          <details class="up">
            <summary>Send a file to the phone</summary>
            <div class="uprow">
              <input type="file" aria-label="File to send" onchange={(e) => { upFile = (e.currentTarget as HTMLInputElement).files?.[0] ?? null; if (upFile && upPath.endsWith("/")) upPath += upFile.name; }} />
              <input class="path" bind:value={upPath} spellcheck="false" aria-label="Destination path on the phone" />
              <input class="mode" bind:value={upMode} spellcheck="false" aria-label="File mode" />
              <button class="btn" disabled={!upFile || !!sshs.busy || upPath.endsWith("/")} onclick={() => upFile && sshs.uploadPicked(upFile, upPath, upMode)}>Send</button>
            </div>
          </details>
          <p class="muted">Leave iOS with these buttons, not a hard reset: they flush the disk first.</p>
          <Terminal />
        {/if}
      </section>
    {/if}

    <section class="controls">
      <input class="search" placeholder="Filter text…" bind:value={log.search} autocomplete="off" spellcheck="false" aria-label="Filter log text" />
      <div class="tags" role="group" aria-label="Tags">
        {#each TAGS as t}
          <button class:on={log.activeTags.has(t)} onclick={() => log.toggleTag(t)}>{t}</button>
        {/each}
      </div>
      <div class="acts">
        <button class:on={log.paused} onclick={() => (log.paused = !log.paused)} aria-pressed={log.paused}>{log.paused ? "Paused" : "Pause"}</button>
        <button class:on={log.follow} onclick={() => (log.follow = !log.follow)} aria-pressed={log.follow}>Follow</button>
        <button onclick={() => log.clear()}>Clear</button>
        <button onclick={() => log.save()} disabled={!log.lines.length}>Save .txt</button>
      </div>
    </section>

    <section class="view" bind:this={viewEl} aria-label="Kernel log" aria-live="off">
      {#each log.visible as l (l.id)}
        <div class={klass(l.tags)}>{l.text}</div>
      {:else}
        <div class="empty"># {log.state === "live" ? "waiting for the phone to log…" : "connect the phone to see its kernel log here"}</div>
      {/each}
    </section>

    <p class="note">
      <b>Experimental.</b> The log travels as UDP/{LOG_PORT} over the phone's CDC-ECM USB networking, exactly as the Mac app reads it; here the page answers the phone's ARP and parses the frames itself. Needs the phone booted into iOS with USB networking up. On Linux, your user must be allowed to open the USB device (udev), as for fastboot.
    </p>
  {/if}
</div>

<style>
  .page { max-width: 1180px; margin: 0 auto; padding: 0 clamp(16px, 3.4vw, 48px) 48px; display: grid; gap: 16px; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 26px 0 8px; flex-wrap: wrap; }
  .mark { display: inline-flex; align-items: center; gap: 12px; font-weight: 900; font-size: 24px; font-stretch: 112%; letter-spacing: -0.02em; text-decoration: none; }
  .mark img { border-radius: 8px; }
  .mark span { font-weight: 600; font-stretch: 100%; }
  nav { display: flex; gap: 20px; font-weight: 650; }
  nav a { text-decoration: none; }
  nav a:hover { text-decoration: underline; }

  .sheet { background: var(--paper); padding: 30px 32px; box-shadow: var(--lift); }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; background: var(--paper); padding: 16px 20px; border-radius: 8px; box-shadow: var(--lift); }
  .who { display: flex; align-items: center; gap: 14px; }
  .who div { display: grid; }
  .who b { font-size: 17px; }
  .who small { color: var(--ink-soft); font: 400 12.5px var(--mono); }
  .who small.diag { font-size: 11.5px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--leaf); box-shadow: 0 0 0 4px color-mix(in srgb, var(--leaf) 30%, transparent); }
  .dot.off { background: var(--ink-faint); box-shadow: none; }
  .live .dot { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.4; } }
  .stats { display: flex; align-items: center; gap: 18px; font-size: 15px; }
  .stats b { font-variant-numeric: tabular-nums; }

  .controls { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .search { flex: 1; min-width: 180px; font: 500 14px var(--mono); padding: 10px 14px; border: 2px solid var(--ink); border-radius: 6px; background: var(--white); }
  .tags, .acts { display: flex; gap: 6px; flex-wrap: wrap; }
  .tags button, .acts button { border: 1px solid var(--paper-line); background: var(--paper); border-radius: 999px; padding: 8px 14px; font: 600 12.5px var(--mono); cursor: pointer; }
  .tags button.on { background: var(--ink); color: var(--white); border-color: var(--ink); }
  .acts button.on { background: var(--leaf); color: var(--white); border-color: var(--leaf); }

  .view { background: var(--ink); color: #e8e6dc; font: 400 12.5px/1.55 var(--mono); padding: 16px 20px; border-radius: 8px; height: min(62vh, 640px); overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .view .sweet { color: #c6e06b; }
  .view .crash { color: #ff8a6a; font-weight: 700; }
  .view .empty { color: #9a988c; }

  .osnet pre { background: var(--ink); color: #e8e6dc; font: 400 12.5px/1.6 var(--mono); padding: 14px 16px; border-radius: 6px; overflow-x: auto; white-space: pre; }
  .osnet h2 { font-size: 22px; margin: 0 0 10px; }
  .osnet .muted, .raw { color: var(--ink-soft); font-size: 13px; }
  .osnet .row { margin-top: 12px; }
  .ssh { display: grid; gap: 12px; }
  .ssh-head { display: flex; align-items: center; gap: 12px; }
  .ssh-head h2 { margin: 0; font-size: 24px; }
  .tag { font: 600 12px var(--mono); padding: 4px 10px; border-radius: 999px; background: var(--paper-line); }
  .tag.on { background: var(--leaf); color: var(--white); }
  .key { display: grid; gap: 6px; font-size: 14px; }
  .key textarea { font: 500 12.5px var(--mono); padding: 10px 12px; border: 2px solid var(--ink); border-radius: 6px; background: var(--white); resize: vertical; }
  .pub { word-break: break-all; font-size: 11.5px; }
  .acts2 { display: flex; gap: 10px; flex-wrap: wrap; }
  .ok { color: var(--leaf); font-weight: 700; margin: 0; }
  .up summary { cursor: pointer; font-weight: 700; font-size: 14px; }
  .uprow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
  .uprow .path { flex: 1; min-width: 220px; font: 500 13px var(--mono); padding: 8px 10px; border: 2px solid var(--ink); border-radius: 6px; }
  .uprow .mode { width: 64px; font: 500 13px var(--mono); padding: 8px 10px; border: 2px solid var(--ink); border-radius: 6px; }
  .out { background: var(--ink); color: #e8e6dc; font: 400 12px/1.5 var(--mono); padding: 12px 14px; border-radius: 6px; overflow-x: auto; margin: 0; max-height: 40vh; }
  .note { font-size: 13px; color: var(--ink-soft); margin: 0; }
  .problem { background: #fdecea; color: #6b1d0c; padding: 12px 16px; border-radius: 6px; margin: 0; }

  @media (max-width: 720px) {
    .controls { flex-direction: column; align-items: stretch; }
  }
</style>
