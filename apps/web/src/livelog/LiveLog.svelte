<script lang="ts">
  import { log, TAGS } from "./logsession.svelte.ts";
  import { UsbNet } from "../lib/usbnet.ts";
  import { HOST_IP, PHONE_IP, LOG_PORT } from "../lib/ethernet.ts";
  import { sshs } from "./sshsession.svelte.ts";
  import Terminal from "./Terminal.svelte";

  const base = import.meta.env.BASE_URL;
  const supported = log.supported;

  let viewEl: HTMLElement | undefined = $state();

  /** Keeps a box scrolled to its end as its text grows, unless the user scrolled up to read. */
  function follow(el: HTMLElement, _text: string) {
    let atEnd = true;
    el.addEventListener("scroll", () => (atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24));
    return {
      update() {
        if (atEnd) el.scrollTop = el.scrollHeight;
      },
    };
  }
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
  let zipFile = $state<File | null>(null);
  let ipaFile = $state<File | null>(null);
  let rmApp = $state("");
  let sideloadTab = $state<"ipa" | "tools" | "zip" | "file">("ipa");

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
        <p>Good news first: the phone answered on USB, so iOS is up.</p>
        <p><b>No commands at all:</b> boot an image made with <code>sweetusbraw=1</code> (the <code>-link</code> images). The phone then offers its own USB link instead of a USB network card: Android tablets, Linux and ChromeOS leave it alone and this page connects straight away. Your computer's own <code>ssh</code> to {PHONE_IP} does not work in that mode; this page's SSH does.</p>
        <p>Or, on Linux with the usual image, two commands hand the phone to this page:</p>
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
          <div class="dash-status">
            <div class="dash-meta">
              <span class="user-host">root@{PHONE_IP}</span>
              <span class="host-info">{sshs.server ?? "SSH"} · <code>{sshs.fingerprint?.slice(0, 16)}…</code></span>
            </div>
            <div class="dash-pills">
              {#if sshs.crashLoopsQuieted === true}
                <span class="pill pill-green" title="Services non essentiels (Siri, BlastDoor, BT) gelés">⚡ CPU apaisé (~5%)</span>
              {:else if sshs.crashLoopsQuieted === false}
                <span class="pill pill-warn" title="Services en crash loop continu (CPU saturé à 100%)">⚠️ Crash loops actifs (100% CPU)</span>
              {/if}

              {#if sshs.unportedDisabled === true}
                <span class="pill pill-green">🛡️ launchd nettoyé</span>
              {/if}

              {#if sshs.gpuOffState}
                <span class="pill pill-off">🛑 GPU Désactivé</span>
              {:else if sshs.gpuArmed}
                <span class="pill pill-green">🎮 Compositor GPU actif</span>
              {:else if sshs.gpuWired}
                <span class="pill pill-blue">🎮 backboardd linké</span>
              {:else if sshs.gpuWired === false}
                <span class="pill">Stock backboardd</span>
              {/if}

              <button class="pill pill-btn" onclick={() => sshs.refreshStatus()} title="Vérifier l'état actuel du téléphone" disabled={!!sshs.busy}>🔄 Vérifier</button>
            </div>
          </div>

          <div class="dash-grid">
            <!-- MODULE 1: OPTIMISATION CPU & STABILITÉ -->
            <div class="dash-card">
              <div class="dash-card-head">
                <h3>⚡ Optimisation CPU & Stabilité</h3>
                <span class="dash-sub">Élimine la surchauffe et la saturation CPU causées par les démons Apple en boucle.</span>
              </div>
              <div class="dash-card-body">
                <div class="dash-actions">
                  {#if !sshs.crashLoopsQuieted}
                    <button class="btn leaf" disabled={!!sshs.busy} onclick={() => confirm("Geler les démons en crash loop (Siri, Speech, BlastDoor) dans /var/root/disabled-bin et désactiver bluetoothd ?") && sshs.quietCrashLoops()}>
                      ⚡ Calmer les crash loops (Recommandé)
                    </button>
                  {:else}
                    <button class="btn ghost" disabled={!!sshs.busy} onclick={() => sshs.restoreCrashLoops()}>
                      ↩️ Restaurer les démons
                    </button>
                  {/if}

                  {#if !sshs.unportedDisabled}
                    <button class="btn" disabled={!!sshs.busy} onclick={() => confirm("Désactiver les jobs launchd des services non portés (bluetoothd, fairplayd, etc.) au prochain boot ?") && sshs.disableUnported()}>
                      🛡️ Nettoyer launchd
                    </button>
                  {:else}
                    <button class="btn ghost" disabled={!!sshs.busy} onclick={() => sshs.enableUnported()}>
                      ↩️ Restaurer launchd
                    </button>
                  {/if}

                  <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.topCpu()}>
                    📊 Top CPU (Processus)
                  </button>
                </div>
              </div>
            </div>

            <!-- MODULE 2: GPU ADRENO 630 & ÉCRAN 60 HZ -->
            <div class="dash-card">
              <div class="dash-card-head">
                <h3>🎮 GPU Adreno 630 & Écran 60 Hz</h3>
                <span class="dash-sub">Accélération matérielle Metal/Vulkan (Chlorophyll) en mode direct 60 Hz.</span>
              </div>
              <div class="dash-card-body">
                <div class="dash-actions">
                  {#if !sshs.gpuWired}
                    <button class="btn leaf" disabled={!!sshs.busy} onclick={() => confirm("Activer l'injection Chlorophyll dans backboardd ? (Prend effet au prochain boot)") && sshs.gpuWire()}>
                      🚀 Activer le compositeur GPU
                    </button>
                  {:else}
                    <button class="btn ghost" disabled={!!sshs.busy} onclick={() => sshs.gpuOff()}>
                      🛑 Kill switch (GPU off)
                    </button>
                    <button class="btn ghost" disabled={!!sshs.busy} onclick={() => confirm("Restaurer le backboardd d'origine ?") && sshs.gpuRestore()}>
                      ↩️ Restaurer backboardd
                    </button>
                  {/if}

                  <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.gpuStatus()}>
                    🔍 Statut Chlorophyll
                  </button>
                  <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.runStreamed("tu_smoke", "cd /var/root/turnip-test && ./tu_smoke")}>
                    🧪 Test 3D (tu_smoke)
                  </button>
                  <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.runStreamed("chl_test", "cd /var/root/chl-test && ./chl_test bg_kernels.metallib bg_render.metallib")}>
                    🔬 chl_test
                  </button>
                </div>
              </div>
            </div>

            <!-- MODULE 3: ALIMENTATION & CONSOLE -->
            <div class="dash-card">
              <div class="dash-card-head">
                <h3>🔄 Alimentation & Logs Système</h3>
                <span class="dash-sub">Redémarrage propre (évite toute corruption HFS+ causée par un hard reset).</span>
              </div>
              <div class="dash-card-body">
                <div class="dash-actions">
                  <button class="btn leaf" disabled={!!sshs.busy} onclick={() => sshs.reboot("fastboot")}>
                    🔄 Reboot vers Fastboot
                  </button>
                  <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.reboot("normal")}>
                    🔁 Reboot Normal
                  </button>
                  <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.bootConsole()}>
                    📜 Console de boot
                  </button>
                  <button class="btn" disabled={!!sshs.busy} onclick={() => sshs.fetchKernelLog()}>
                    📥 Journal noyau (sweetlog)
                  </button>
                  <button class="btn ghost" onclick={() => sshs.disconnect()}>
                    🔌 Déconnecter
                  </button>
                </div>
              </div>
            </div>

            <!-- MODULE 4: INSTALLATION & SIDELOAD -->
            <div class="dash-card">
              <div class="dash-card-head">
                <h3>📦 Sideload & Outils</h3>
                <span class="dash-sub">Installation d'applications .ipa, pack d'outils et transfert direct de fichiers.</span>
              </div>
              <div class="dash-card-body">
                <div class="sideload-tabs">
                  <button class:on={sideloadTab === "ipa"} onclick={() => sideloadTab = "ipa"}>📱 App (.ipa)</button>
                  <button class:on={sideloadTab === "tools"} onclick={() => sideloadTab = "tools"}>🧰 Outils</button>
                  <button class:on={sideloadTab === "zip"} onclick={() => sideloadTab = "zip"}>📦 Zip</button>
                  <button class:on={sideloadTab === "file"} onclick={() => sideloadTab = "file"}>📁 Fichier</button>
                </div>

                {#if sideloadTab === "ipa"}
                  <div class="sideload-pane">
                    <p class="muted">IPA déchiffré. Le navigateur re-signe automatiquement l'application pour le 6T et l'enregistre sur le SpringBoard.</p>
                    <div class="uprow">
                      <input type="file" accept=".ipa,application/octet-stream,application/zip" aria-label="IPA to install" onchange={(e) => (ipaFile = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
                      <button class="btn leaf" disabled={!ipaFile || !!sshs.busy} onclick={() => ipaFile && sshs.installIpa(ipaFile)}>Installer l'IPA</button>
                    </div>
                    <div class="uprow" style="margin-top: 10px;">
                      <input class="path" bind:value={rmApp} spellcheck="false" placeholder="Nom.app à désinstaller" aria-label="App to remove" />
                      <button class="btn" disabled={!rmApp.trim() || !!sshs.busy} onclick={() => confirm(`Supprimer /Applications/${rmApp.trim()} ?`) && sshs.removeApp(rmApp.trim())}>Désinstaller</button>
                    </div>
                  </div>
                {:else if sideloadTab === "tools"}
                  <div class="sideload-pane">
                    <p class="muted">Installe les outils indispensables dans <code>/usr/local/bin</code> (sweetlog, sweetuicache, tar, etc.).</p>
                    <button class="btn leaf" disabled={!!sshs.busy} onclick={() => sshs.installTools()}>🧰 Installer le pack d'outils</button>
                  </div>
                {:else if sideloadTab === "zip"}
                  <div class="sideload-pane">
                    <p class="muted">Extrait un pack zip (ex: <code>chlorophyll-ios18.zip</code>) dans <code>usr/local</code>, <code>var/root</code> et <code>var/mobile</code>.</p>
                    <div class="uprow">
                      <input type="file" accept=".zip,application/zip" aria-label="Zip to install" onchange={(e) => (zipFile = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
                      <button class="btn leaf" disabled={!zipFile || !!sshs.busy} onclick={() => zipFile && sshs.installZip(zipFile)}>Installer le .zip</button>
                    </div>
                  </div>
                {:else if sideloadTab === "file"}
                  <div class="sideload-pane">
                    <p class="muted">Transfère un binaire ou fichier directement sur le téléphone.</p>
                    <div class="uprow">
                      <input type="file" aria-label="File to send" onchange={(e) => { upFile = (e.currentTarget as HTMLInputElement).files?.[0] ?? null; if (upFile && upPath.endsWith("/")) upPath += upFile.name; }} />
                      <input class="path" bind:value={upPath} spellcheck="false" aria-label="Destination path on the phone" />
                      <input class="mode" bind:value={upMode} spellcheck="false" aria-label="File mode" />
                      <button class="btn leaf" disabled={!upFile || !!sshs.busy || upPath.endsWith("/")} onclick={() => upFile && sshs.uploadPicked(upFile, upPath, upMode)}>Envoyer</button>
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          </div>

          {#if sshs.busy}
            <div class="busy">
              <p class="muted">{sshs.busy}</p>
              {#if sshs.cancel}<button class="btn" onclick={() => sshs.stop()}>Stop</button>{/if}
            </div>
          {/if}
          {#if sshs.error}<p class="problem">{sshs.error}</p>{/if}
          {#if sshs.output}<pre class="out">{sshs.output}</pre>{/if}
          {#if sshs.klog || (sshs.cancel && sshs.klogHead)}
            <div class="klog">
              <div class="row">
                <span class="muted">{sshs.klogHead}</span>
                <button class="btn" disabled={!sshs.klog} onclick={() => sshs.saveKernelLog()}>Download .txt</button>
              </div>
              <pre class="out" use:follow={sshs.klog}>{sshs.klog || "(waiting for the first line…)"}</pre>
            </div>
          {/if}

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
        <button onclick={() => log.replay()} disabled={log.state !== "live"} title="The phone sends its log again from the first line of this boot">Log since boot</button>
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
  .klog .row { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin: 8px 0 6px; }
  .klog .row .muted { font-size: 12px; overflow-wrap: anywhere; }
  .busy { display: flex; gap: 12px; align-items: flex-start; }
  .busy p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; flex: 1; font-family: ui-monospace, monospace; font-size: 12px; }
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

  .dash-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 16px; background: color-mix(in srgb, var(--paper-line) 40%, transparent); border-radius: 8px; margin-bottom: 4px; }
  .dash-meta { display: flex; align-items: baseline; gap: 10px; font-size: 13px; }
  .user-host { font-weight: 700; font-family: var(--mono); color: var(--ink); }
  .host-info { color: var(--ink-soft); font-size: 12px; }
  .dash-pills { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pill { font: 600 11.5px/1 var(--mono); padding: 5px 10px; border-radius: 999px; background: var(--paper-line); color: var(--ink); display: inline-flex; align-items: center; gap: 4px; }
  .pill-green { background: #d7edd8; color: #144d25; border: 1px solid #b2dcba; }
  .pill-warn { background: #fff0d4; color: #8a5300; border: 1px solid #ffd899; }
  .pill-blue { background: #e0f0fd; color: #0a4f82; border: 1px solid #bce1fb; }
  .pill-off { background: #fae1dd; color: #7f1d1d; border: 1px solid #f5c2bb; }
  .pill-btn { border: 1px solid var(--ink); background: var(--paper); cursor: pointer; }
  .pill-btn:hover { background: var(--ink); color: var(--white); }

  .dash-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin: 4px 0 12px; }
  .dash-card { background: var(--paper); border: 1.5px solid var(--paper-line); border-radius: 8px; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .dash-card-head h3 { margin: 0; font-size: 16px; font-weight: 750; letter-spacing: -0.01em; }
  .dash-sub { font-size: 12px; color: var(--ink-soft); line-height: 1.4; display: block; margin-top: 3px; }
  .dash-card-body { display: flex; flex-direction: column; gap: 12px; height: 100%; justify-content: space-between; }
  .dash-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

  .sideload-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--paper-line); padding-bottom: 8px; }
  .sideload-tabs button { border: none; background: transparent; padding: 6px 12px; font: 600 12px var(--mono); border-radius: 6px; cursor: pointer; color: var(--ink-soft); }
  .sideload-tabs button.on { background: var(--ink); color: var(--white); }
  .sideload-pane { font-size: 13px; display: grid; gap: 8px; padding-top: 4px; }
  .sideload-pane p { margin: 0 0 6px; }

  .ok { color: var(--leaf); font-weight: 700; margin: 0; }
  .upsummary { cursor: pointer; font-weight: 700; font-size: 14px; }
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
