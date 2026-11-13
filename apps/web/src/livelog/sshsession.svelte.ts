// SSH to the phone from the page, over the CDC-ECM link the live log already holds (logsession.stack).
// The private key is kept in memory only: never written to storage, gone when the tab closes.

import { log } from "./logsession.svelte.ts";
import { SshClient, SshError, type SshChannel } from "../lib/ssh.ts";
import { planZip } from "../lib/zipinstall.ts";
import { installUserScript, appNameProblem, bundleIdProblem, installScript, removeScript } from "../lib/guards.ts";
import wasmUrl from "../patcher/renegade.wasm?url";
import { Renegade } from "../patcher/wasm.ts";
import { decodeConsoleRing, READ_RING_CMD, RING_BLOCKS } from "../lib/consolering.ts";
import { parseOpenSshKey, publicLine, SshKeyError, type Ed25519Key } from "../lib/sshkey.ts";

export type RebootMode = "fastboot" | "bergamota" | "recovery" | "normal" | "poweroff";

class SshSession {
  keyText = $state("");
  keyError = $state<string | null>(null);
  pub = $state<string | null>(null);
  state = $state<"idle" | "connecting" | "ready" | "error">("idle");
  error = $state<string | null>(null);
  fingerprint = $state<string | null>(null);
  server = $state<string | null>(null);
  busy = $state<string | null>(null);
  /** Set when the phone was asked to reboot: the link goes away on purpose. */
  rebooting = $state<RebootMode | null>(null);

  /** Detected system states (updated automatically by refreshStatus) */
  crashLoopsQuieted = $state<boolean | null>(null);
  btAudioDisabled = $state<boolean | null>(null);
  gpuWired = $state<boolean | null>(null);
  gpuArmed = $state<boolean | null>(null);
  gpuOffState = $state<boolean | null>(null);
  unportedDisabled = $state<boolean | null>(null);

  client: SshClient | null = null;
  private key: Ed25519Key | null = null;

  /** Validates the pasted key (shows its public line, to compare with what was patched in). */
  checkKey() {
    this.keyError = null;
    this.pub = null;
    this.key = null;
    if (!this.keyText.trim()) return;
    try {
      this.key = parseOpenSshKey(this.keyText);
      this.pub = publicLine(this.key);
    } catch (e) {
      this.keyError = e instanceof SshKeyError ? e.message : String(e);
    }
  }

  async connect() {
    if (this.state === "connecting" || this.state === "ready") return;
    this.checkKey();
    if (!this.key) {
      this.keyError ??= "Paste your SSH private key first.";
      return;
    }
    if (!log.stack || log.state !== "live") {
      this.error = "Connect the phone first (the live log link carries SSH).";
      this.state = "error";
      return;
    }
    this.state = "connecting";
    this.error = null;
    this.rebooting = null;
    try {
      const tcp = await log.stack.connect(22);
      log.note("SSH: TCP connected to port 22");
      const ssh = new SshClient((b) => tcp.write(b), { key: this.key, log: (m) => log.note(m) });
      tcp.ondata = (b) => ssh.feed(b);
      tcp.onclose = (e) => ssh.transportClosed(e);
      ssh.onclose = (e) => {
        if (this.client !== ssh) return;
        this.client = null;
        if (this.rebooting) {
          this.state = "idle";
          return;
        }
        this.state = "error";
        this.error = e?.message ?? "SSH closed";
      };
      await ssh.connect();
      this.client = ssh;
      this.fingerprint = ssh.hostFingerprint;
      this.server = ssh.serverId;
      this.state = "ready";
      void this.refreshStatus();
    } catch (e) {
      this.state = "error";
      this.error = explain(e as Error);
    }
  }

  disconnect() {
    const c = this.client;
    this.client = null;
    c?.disconnect();
    this.state = "idle";
    this.crashLoopsQuieted = null;
    this.gpuWired = null;
    this.gpuArmed = null;
    this.gpuOffState = null;
    this.unportedDisabled = null;
  }

  /** Checks device status in background and updates reactive state flags. */
  async refreshStatus() {
    if (!this.client || this.busy) return;
    try {
      const r = await this.run(
        "[ -s /var/root/disabled-bin/README ] && echo QUIET_OK; " +
        "[ -d /Library/Audio/Plug-Ins/HAL.disabled/BTAudioHALPlugin.driver -o -d /System/Library/Audio/Plug-Ins/HAL.disabled/BTAudioHALPlugin.driver ] && echo BTAUDIO_DIS; " +
        "[ -s /usr/libexec/backboardd.orig ] && echo GPU_WIRED; " +
        "[ -f /private/var/tmp/bgmtl-bb.arm ] && echo GPU_ARMED; " +
        "[ -f /private/var/tmp/bgmtl-bb.off ] && echo GPU_OFF; " +
        "[ -s /var/root/launchd.plist.orig ] && echo UNPORTED_DIS"
      );
      this.crashLoopsQuieted = /QUIET_OK/.test(r.text);
      this.btAudioDisabled = /BTAUDIO_DIS/.test(r.text);
      this.gpuWired = /GPU_WIRED/.test(r.text);
      this.gpuArmed = /GPU_ARMED/.test(r.text);
      this.gpuOffState = /GPU_OFF/.test(r.text);
      this.unportedDisabled = /UNPORTED_DIS/.test(r.text);
    } catch {
      // ignore
    }
  }

  /** One command; stdout as text (stderr appended), throws if SSH is not up. */
  async run(
    command: string,
    onData?: (b: Uint8Array) => void,
    pty = false,
  ): Promise<{ text: string; code: number | null; signal: string | null; stopped: boolean }> {
    if (!this.client) throw new SshError("SSH is not connected");
    this.cancel = new AbortController();
    try {
      const r = await this.client.run(command, undefined, { onData, signal: this.cancel.signal, pty });
      const dec = new TextDecoder();
      let text = dec.decode(r.stdout) + (r.stderr.length ? dec.decode(r.stderr) : "");
      if (pty) text = text.replace(/\r\n/g, "\n");
      return { text, code: r.code, signal: r.signal, stopped: r.stopped };
    } finally {
      this.cancel = null;
    }
  }

  /** Set while a command runs: the Stop button aborts it (the phone side is closed, what came is kept). */
  cancel = $state<AbortController | null>(null);

  stop() {
    this.cancel?.abort();
  }

  /** Seconds since the phone booted: the age of launchd (pid 1), from ps; null if ps is missing. */
  async uptime(): Promise<number | null> {
    const { text } = await this.run("ps -o etime= -p 1 2>/dev/null");
    return parseEtime(text.trim());
  }

  /** Writes a file on the phone: streamed over SSH stdin to a temporary name, then renamed (atomic). */
  async upload(path: string, data: Uint8Array, mode = "755") {
    if (!/^\/[A-Za-z0-9._/+-]+$/.test(path) || !/^[0-7]{3,4}$/.test(mode)) throw new SshError(`refusing odd path or mode: ${path} ${mode}`);
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const r = await this.client!.run(
      `export PATH=$PATH:/usr/local/bin:/usr/sbin:/sbin; mkdir -p '${dir}' && cat > '${path}.part' && chmod ${mode} '${path}.part' && mv -f '${path}.part' '${path}' && wc -c < '${path}'`,
      data,
    );
    const got = parseInt(new TextDecoder().decode(r.stdout).trim(), 10);
    if (r.code !== 0 || got !== data.length) throw new SshError(`upload of ${path} failed (${got} of ${data.length} bytes, code ${r.code})`);
  }

  /** The berga-tools the web-patched root leaves out (sweetlog: the unified log, kernel lines since boot). */
  async installTools() {
    if (!this.client) return;
    this.busy = "Fetching the tools bundle…";
    try {
      const r = await fetch(import.meta.env.BASE_URL + "tools/berga-tools.zip");
      if (!r.ok) throw new SshError(`this site has no tools bundle (${r.status})`);
      const { unzipSync } = await import("fflate");
      const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
      const names = ["sweetlog", "sweetmetrics", "sweetshot", "sweetsample", "sweettouch", "sweetprefs", "sweetuicache"];
      const done: string[] = [];
      for (const n of names) {
        const data = files[`sweetnet/ios18/${n}`];
        if (!data) continue;
        this.busy = `Installing ${n} (${Math.round(data.length / 1024)} KB)…`;
        await this.upload(`/usr/local/bin/${n}`, data);
        done.push(n);
      }
      this.output = `installed in /usr/local/bin: ${done.join(", ") || "nothing"}`;
    } catch (e) {
      this.error = explain(e as Error);
    } finally {
      this.busy = null;
    }
  }

  /**
   * A .zip laid out as phone paths (e.g. chlorophyll-ios18.zip from the Chlorophyll CI): every file under usr/local, var/root or
   * var/mobile is written there (Mach-O 755, else 644), one atomic upload each; anything else in the zip is skipped and listed.
   */
  async installZip(file: File) {
    if (!this.client) return;
    this.busy = `Unpacking ${file.name}…`;
    this.output = null;
    this.cancel = new AbortController();
    const done: string[] = [];
    try {
      const { unzipSync } = await import("fflate");
      const plan = planZip(unzipSync(new Uint8Array(await file.arrayBuffer())));
      if (!plan.install.length) throw new SshError(`nothing to install in ${file.name} (skipped: ${plan.skipped.join(", ") || "empty zip"})`);
      const total = plan.install.reduce((n, f) => n + f.data.length, 0);
      let sent = 0;
      for (const [i, f] of plan.install.entries()) {
        if (this.cancel.signal.aborted) throw new SshError(`stopped after ${done.length} of ${plan.install.length} files`);
        this.busy = `Installing ${i + 1}/${plan.install.length}: ${f.path} (${Math.round(f.data.length / 1024)} KB), ${Math.round((sent / total) * 100)} % done`;
        await this.upload(f.path, f.data, f.mode);
        sent += f.data.length;
        done.push(`${f.mode} ${f.path}`);
      }
      this.output =
        `${file.name}: ${done.length} files installed (${(total / 1048576).toFixed(1)} MB)\n` +
        done.join("\n") +
        (plan.skipped.length ? `\nskipped (not under ${["usr/local", "var/root", "var/mobile"].join(", ")}): ${plan.skipped.join(", ")}` : "");
    } catch (e) {
      this.error = explain(e as Error);
      if (done.length) this.output = `installed before the error:\n${done.join("\n")}`;
    } finally {
      this.cancel = null;
      this.busy = null;
    }
  }

  /** Raw stdout of one command (a binary read with cat); throws on a non-zero exit. */
  private async fetchBytes(cmd: string): Promise<Uint8Array> {
    if (!this.client) throw new SshError("SSH is not connected");
    const r = await this.client.run(cmd);
    if (r.code !== 0) throw new SshError(`${cmd}: ${new TextDecoder().decode(r.stderr).trim() || `exit ${r.code}`}`);
    return r.stdout;
  }

  private renegade: Promise<Renegade> | null = null;

  /**
   * Chlorophyll as the compositor, the way the iOS 26 branch runs it ("direct mode"): backboardd gets the inject as a WEAK
   * load command (re-signed ad hoc in this page, identifier and entitlements kept; the original stays as backboardd.orig),
   * and bgmtl-bb.arm + bgmtl-bb.direct switch it on. The inject still checks, at every start: bgmtl-bb.off (kill switch, also
   * written by its own dead-man), the kernel's GPU state (sweetgpu=8), and that it can make the device; otherwise backboardd
   * runs stock. Takes effect at the next boot. Recovery without SSH: boot-arg sweetdenypath=/usr/local/lib/bgmtl/bgmtl-inject.dylib.
   */
  async gpuWire() {
    if (!this.client) return;
    const BB = "/usr/libexec/backboardd", INJ = "/usr/local/lib/bgmtl/bgmtl-inject.dylib";
    this.output = null;
    try {
      this.busy = "Checking Chlorophyll's files on the phone…";
      const have = await this.run(`for f in ${INJ} /usr/local/lib/bgmtl/libchlorophyll.dylib /usr/local/lib/bgmtl/libdrm.2.dylib; do [ -s $f ] || echo "missing $f"; done; [ -e ${BB}.orig ] && echo HAVE_ORIG`);
      if (/missing/.test(have.text)) throw new SshError(`${have.text.split("\n").filter((l) => l.startsWith("missing")).join(", ")}: install chlorophyll-ios18.zip first`);
      const fromOrig = /HAVE_ORIG/.test(have.text);
      this.busy = `Reading ${fromOrig ? BB + ".orig" : BB}…`;
      const bin = await this.fetchBytes(`cat ${fromOrig ? BB + ".orig" : BB}`);
      this.busy = "Linking the inject and re-signing (in this page)…";
      // iOS 26 kept a short name for binaries with little header slack: /usr/local/bgi.dylib, a symlink to the inject
      let lib = INJ;
      let signed: Uint8Array;
      try {
        signed = (await this.wasm()).linkDylib(bin, INJ, true);
      } catch (e) {
        if (!/no slack/.test((e as Error).message)) throw e;
        lib = "/usr/local/bgi.dylib";
        signed = (await this.wasm()).linkDylib(bin, lib, true);
        const l = await this.run(`ln -sf ${INJ} ${lib} && ls -l ${lib}`);
        if (l.code !== 0) throw new SshError(`could not make ${lib}: ${l.text.trim()}`);
      }
      if (!fromOrig) {
        this.busy = "Keeping the original as backboardd.orig…";
        const r = await this.run(`cp -p ${BB} ${BB}.orig && [ "$(wc -c < ${BB})" = "$(wc -c < ${BB}.orig)" ] && echo SAVED`);
        if (!/SAVED/.test(r.text)) throw new SshError(`could not save ${BB}.orig: ${r.text.trim()}`);
      }
      this.busy = `Writing the new backboardd (${Math.round(signed.length / 1024)} KB)…`;
      await this.upload(BB, signed, "755");
      const f = await this.run(
        "cd /private/var/tmp && rm -f bgmtl-bb.off bgmtl-bb.state && echo 'armed from the web page' > bgmtl-bb.arm && : > bgmtl-bb.direct && ls -l bgmtl-bb.*",
      );
      this.output =
        `backboardd now links ${lib}${lib !== INJ ? ` (-> ${INJ})` : ""} (weak; original in ${BB}.orig, ${bin.length} -> ${signed.length} bytes)\n${f.text.trim()}\n` +
        "Takes effect at the next boot (do not kill backboardd: launchd counts it as a crash). It stays stock unless the kernel's GPU is up (sweetgpu=8).\n" +
        `If it ever loops: boot with sweetdenypath=${lib}, then "GPU off" or "Restore backboardd".`;
    } catch (e) {
      this.error = explain(e as Error);
    } finally {
      this.busy = null;
      void this.refreshStatus();
    }
  }

  /** The kill switch (what the inject's dead-man writes): backboardd starts stock from its next start, wiring kept. */
  async gpuOff() {
    await this.runStreamed("GPU off", "cd /private/var/tmp && echo 'off from the web page' > bgmtl-bb.off && ls -l bgmtl-bb.*");
  }

  /**
   * "Restart the GUI with the GPU": clears the dead-man's kill switch (bgmtl-bb.off) and state, makes sure the arm/direct flags
   * are there, then stops backboardd so launchd starts it again (SpringBoard follows): the inject runs at that start and
   * takes the GPU if the kernel reports it ready. The screen goes black for a few seconds. Needs the wiring (gpuWire) done.
   */
  async gpuRestartGui() {
    await this.runStreamed(
      "Restart the GUI with the GPU",
      [
        "export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "cd /private/var/tmp || exit 1",
        "[ -s /usr/libexec/backboardd.orig ] || { echo 'backboardd is not wired (no backboardd.orig): use \"Repair / wire the GPU\" first'; exit 1; }",
        "echo '--- before:'; ls -l bgmtl-bb.* 2>&1; tail -n 3 bgmtl.log 2>/dev/null",
        "rm -f bgmtl-bb.off bgmtl-bb.state",
        "[ -e bgmtl-bb.arm ] || echo 'armed from the web page' > bgmtl-bb.arm",
        "[ -e bgmtl-bb.direct ] || : > bgmtl-bb.direct",
        "echo '--- flags now:'; ls -l bgmtl-bb.*",
        "sync",
        "echo 'stopping backboardd (launchd restarts it and SpringBoard; the screen blinks)'",
        // this root has no killall, pkill or awk: find the pid with ps and a plain sh loop, TERM first (the inject's handler logs and exits), KILL if it stays
        "P=$(ps ax | while read pid rest; do case \"$rest\" in */usr/libexec/backboardd) echo $pid;; esac; done); echo \"backboardd pid: ${P:-none}\"; [ -n \"$P\" ] || exit 1",
        "kill $P 2>&1; sleep 3; if kill -0 $P 2>/dev/null; then echo 'still running: kill -9'; kill -9 $P 2>&1; fi",
        "N=$(ps ax | while read pid rest; do case \"$rest\" in */usr/libexec/backboardd) echo $pid;; esac; done); echo \"new backboardd pid: ${N:-none} (was $P)\"",
        "sleep 8",
        "echo '--- after 8 s:'; ps ax | grep -E 'backboardd|SpringBoard' | grep -v grep | head -4",
        "tail -n 6 bgmtl.log 2>/dev/null",
      ].join("\n"),
    );
  }

  /** Back to Apple's backboardd (from backboardd.orig) and the flags removed. */
  async gpuRestore() {
    await this.runStreamed(
      "Restore backboardd",
      "B=/usr/libexec/backboardd; [ -s $B.orig ] || { echo \"no $B.orig: backboardd was never wired\"; exit 1; }; " +
        "cp -p $B.orig $B.part && mv -f $B.part $B && [ \"$(wc -c < $B)\" = \"$(wc -c < $B.orig)\" ] && echo \"restored $B\" && rm -f /private/var/tmp/bgmtl-bb.arm /private/var/tmp/bgmtl-bb.direct; ls -l /private/var/tmp/bgmtl* 2>/dev/null",
    );
  }

  /** Flags, what backboardd links, and the inject's own log. */
  async gpuStatus() {
    await this.runStreamed(
      "Chlorophyll status",
      "B=/usr/libexec/backboardd; ls -l $B $B.orig /usr/local/lib/bgmtl/ 2>&1; echo; ls -l /private/var/tmp/bgmtl* 2>&1; echo; " +
        "for f in /private/var/tmp/bgmtl-bb.state /private/var/tmp/bgmtl-bb.off; do [ -e $f ] && { echo \"== $f\"; cat $f; }; done; " +
        "echo '== bgmtl.log (last 60 lines)'; tail -n 60 /private/var/tmp/bgmtl.log 2>/dev/null || echo '(no log yet: the inject has not run)'",
    );
  }

  private wasm(): Promise<Renegade> {
    this.renegade ??= fetch(wasmUrl).then((r) => r.arrayBuffer()).then((b) => Renegade.standalone(b));
    return this.renegade;
  }

  /**
   * Sideload an .ipa (tools/sweet-install-ipa.sh, without a Mac): the page unzips it, PAC-strips and re-signs every
   * Mach-O ad hoc and re-seals the bundles (WASM), streams the result as a tar into /Applications over SSH and registers
   * it with sweetuicache (LaunchServices). Decrypted IPAs only: App Store downloads are FairPlay-encrypted.
   */
  async installIpa(file: File) {
    if (!this.client) return;
    this.output = null;
    try {
      this.busy = `Preparing ${file.name} in this page (re-signing every binary)…`;
      const { tar, meta } = (await this.wasm()).prepareIpa(new Uint8Array(await file.arrayBuffer()));
      const bad = appNameProblem(meta.app) ?? bundleIdProblem(meta.bundleId);
      if (bad) throw new SshError(bad);
      this.busy = "Checking the phone (tar, sweetuicache)…";
      const probe = "export PATH=$PATH:/usr/local/bin:/usr/bin:/bin; command -v tar >/dev/null && echo HAVE_TAR; [ -x /usr/local/bin/sweetuicache ] && echo HAVE_UIC; /usr/local/bin/sweetuicache -V 2>&1 | grep -q user-containers && echo UIC_USER";
      let chk = await this.run(probe);
      if (!/HAVE_TAR/.test(chk.text)) throw new SshError("this root has no tar (re-patch it with the tools bundle)");
      if (!/UIC_USER/.test(chk.text)) {
        // missing, or an older sweetuicache without the normal-app mode: take the one of the tools bundle
        this.busy = "Installing sweetuicache from the tools bundle…";
        const r = await fetch(import.meta.env.BASE_URL + "tools/berga-tools.zip");
        if (!r.ok) throw new SshError(`this site has no tools bundle (${r.status})`);
        const { unzipSync } = await import("fflate");
        const uic = unzipSync(new Uint8Array(await r.arrayBuffer()))["sweetnet/ios18/sweetuicache"];
        if (!uic) throw new SshError("the tools bundle has no sweetuicache");
        await this.upload("/usr/local/bin/sweetuicache", uic);
        chk = await this.run(probe);
      }
      // a normal app (bundle container + data container) when sweetuicache can do it; else the old system-app install
      const asUser = /UIC_USER/.test(chk.text);
      const uuid = () => crypto.randomUUID().toUpperCase();
      const script = asUser ? installUserScript(meta.app, meta.bundleId, uuid(), uuid()) : installScript(meta.app);
      const modeNote = asUser ? "installed as a normal app (own bundle and data container)\n" : "installed as a system app in /Applications (this phone's sweetuicache is the old one: no data container, some apps crash for that)\n";
      this.busy = `Sending ${meta.app} (${(tar.length / 1048576).toFixed(1)} MB)…`;
      // staged extract, atomic swap, system apps refused (lib/guards.ts, audit F-04)
      const head = `${meta.app} (${meta.bundleId} ${meta.version}): ${meta.machos} binaries re-signed (${meta.pacRewritten} had arm64e code rewritten), ${meta.bundlesSealed} bundles sealed, ${meta.files} files\n${modeNote}`;
      let live = "";
      const dec = new TextDecoder();
      const t0 = Date.now();
      const sendMsg = (sent: number) => `Sending ${meta.app}: ${(sent / 1048576).toFixed(1)} / ${(tar.length / 1048576).toFixed(1)} MB (${Math.round((sent / 1048576) / Math.max(1, (Date.now() - t0) / 1000) * 10) / 10} MB/s)`;
      let lastPaint = 0;
      // the phone side has 90 s for sweetuicache; if nothing has come back for 150 s after the last byte, stop and say so
      const stall = new AbortController();
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => stall.abort(), 150_000);
      };
      const r = await this.client.run(script, tar, {
        signal: stall.signal,
        onProgress: (sent, total) => {
          if (sent === total) arm();
          if (Date.now() - lastPaint > 250 || sent === total) {
            lastPaint = Date.now();
            this.busy = sent === total ? `Sent ${meta.app}; the phone is unpacking and registering it…` : sendMsg(sent);
          }
        },
        onData: (b) => {
          arm();
          live += dec.decode(b);
          this.output = head + live;
        },
      });
      clearTimeout(stallTimer);
      this.busy = null;
      if (r.stopped) throw new SshError(`the phone sent nothing for 150 s after the upload (last output):\n${live.trim() || "(nothing)"}\nThe app may be installed: check the home screen, or look at /Applications on the phone.`);
      const out = live || dec.decode(r.stdout) + dec.decode(r.stderr);
      if (r.code !== 0 && r.code !== null) throw new SshError(`the install script on the phone exited with ${r.code}:\n${out.trim()}`);
      if (r.code === null) throw new SshError(`the connection closed before the phone finished (last output):\n${out.trim() || "(nothing)"}`);
      this.output =
        `${meta.app} (${meta.bundleId} ${meta.version}): ${meta.machos} binaries re-signed (${meta.pacRewritten} had arm64e code rewritten), ` +
        `${meta.bundlesSealed} bundles sealed, ${meta.files} files\n${out.trim()}\n` +
        "If the icon does not show at once: respring (or reboot). Uninstall: the same panel, \"Remove an app\".";
    } catch (e) {
      this.error = explain(e as Error);
    } finally {
      this.busy = null;
    }
  }

  /** Unregisters and deletes /Applications/NAME.app (a sideloaded app; system apps are refused: name deny-list plus the phone-side sideload marker, lib/guards.ts). */
  async removeApp(name: string) {
    const app = name.endsWith(".app") ? name : `${name}.app`;
    const bad = appNameProblem(app);
    if (bad) {
      this.error = bad;
      return;
    }
    await this.runStreamed(`Remove ${app}`, removeScript(app));
  }

  /**
   * The crash loops that keep ReportCrash at 100-150 % CPU (seen on beryllium and fajita: the speech/AU extensions abort
   * at launch, MessagesBlastDoorService asserts, bluetoothd faults without a Bluetooth port). As the ios26 branch did,
   * with the user's OK: the five on-demand executables are parked in /var/root/disabled-bin (README = where each came
   * from) and bluetoothd is disabled in launchd (next boot). "Restore" puts everything back.
   */
  async quietCrashLoops() {
    await this.runStreamed(
      "Quiet crash loops",
      [
        "export PATH=$PATH:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
        "D=/var/root/disabled-bin; L=$D/README; mkdir -p $D; touch $L",
        "for n in SiriAUSP MauiAUSP MacinTalkAUSP KonaSynthesizer MessagesBlastDoorService; do",
        "  for p in $(find /System/Library /usr/libexec /Applications -type f -name \"$n\" 2>/dev/null); do",
        "    d=$D/$(echo \"$p\" | tr / _)",
        "    [ -e \"$d\" ] && continue",
        "    mv \"$p\" \"$d\" && echo \"$d $p\" >> $L && echo \"parked $p\"",
        "  done",
        "done",
        "for b in /Library/Audio/Plug-Ins /System/Library/Audio/Plug-Ins; do",
        "  if [ -d \"$b/HAL/BTAudioHALPlugin.driver\" ]; then",
        "    mkdir -p \"$b/HAL.disabled\"",
        "    mv \"$b/HAL/BTAudioHALPlugin.driver\" \"$b/HAL.disabled/BTAudioHALPlugin.driver\" && \\",
        "    echo \"$b/HAL.disabled/BTAudioHALPlugin.driver $b/HAL/BTAudioHALPlugin.driver\" >> $L && \\",
        "    echo \"parked $b/HAL/BTAudioHALPlugin.driver\"",
        "  fi",
        "done",
        "killall -9 audiomxd 2>/dev/null && echo 'audiomxd restarted (stops Bluetooth audio reconnect loop)' || true",
        "killall -9 ReportCrash 2>/dev/null || true",
        "if command -v launchctl >/dev/null 2>&1; then launchctl disable system/com.apple.bluetoothd && echo 'bluetoothd disabled (from the next boot)'; else echo 'no launchctl on this root: bluetoothd left as it is'; fi",
        "echo; echo 'parked so far:'; cat $L",
      ].join("\n"),
    );
  }

  async restoreCrashLoops() {
    await this.runStreamed(
      "Restore parked binaries",
      [
        "export PATH=$PATH:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
        "L=/var/root/disabled-bin/README",
        "[ -s $L ] && while read d p; do [ -e \"$d\" ] && mv \"$d\" \"$p\" && echo \"restored $p\"; done < $L; : > $L",
        "for b in /Library/Audio/Plug-Ins /System/Library/Audio/Plug-Ins; do",
        "  if [ -d \"$b/HAL.disabled/BTAudioHALPlugin.driver\" ]; then",
        "    mv \"$b/HAL.disabled/BTAudioHALPlugin.driver\" \"$b/HAL/BTAudioHALPlugin.driver\" && echo \"restored $b/HAL/BTAudioHALPlugin.driver\"",
        "  fi",
        "done",
        "killall -9 audiomxd 2>/dev/null && echo 'audiomxd restarted' || true",
        "command -v launchctl >/dev/null 2>&1 && launchctl enable system/com.apple.bluetoothd && echo 'bluetoothd enabled (from the next boot)'",
        "true",
      ].join("\n"),
    );
  }

  /**
   * "Disable unported services": the launchd jobs for hardware this port does not drive yet, or that crash-loop on it,
   * come out of /System/Library/xpc/launchd.plist (edited in this page, the original kept once as
   * /var/root/launchd.plist.orig). Next boot. "Re-enable" puts the original back. Enable a service again only once its
   * driver is ported.
   */
  async disableUnported() {
    if (!this.client) return;
    const PL = "/System/Library/xpc/launchd.plist", ORIG = "/var/root/launchd.plist.orig";
    this.output = null;
    try {
      this.busy = "Reading launchd.plist…";
      const have = await this.run(`[ -s ${ORIG} ] && echo HAVE_ORIG`);
      // always edit from Apple's original, so running this twice or after a change of list gives the same file
      const src = await this.fetchBytes(`cat ${/HAVE_ORIG/.test(have.text) ? ORIG : PL}`);
      const { plist, removed } = (await this.wasm()).removeJobs(src);
      if (!removed.length) throw new SshError("none of the unported services is in this launchd.plist (already disabled?)");
      if (!/HAVE_ORIG/.test(have.text)) {
        const r = await this.run(`cp -p ${PL} ${ORIG} && [ "$(wc -c < ${PL})" = "$(wc -c < ${ORIG})" ] && echo SAVED`);
        if (!/SAVED/.test(r.text)) throw new SshError(`could not keep ${ORIG}: ${r.text.trim()}`);
      }
      this.busy = "Writing launchd.plist…";
      await this.upload(PL, plist, "644");
      this.output = `launchd.plist: ${removed.length} services removed (original in ${ORIG}):\n  ${removed.join("\n  ")}\nTakes effect at the next boot. "Re-enable" restores them all.`;
    } catch (e) {
      this.error = explain(e as Error);
    } finally {
      this.busy = null;
      void this.refreshStatus();
    }
  }

  async enableUnported() {
    await this.runStreamed(
      "Re-enable services",
      "O=/var/root/launchd.plist.orig; P=/System/Library/xpc/launchd.plist; [ -s $O ] || { echo 'nothing to restore (no launchd.plist.orig)'; exit 0; }; cp -p $O $P.part && mv -f $P.part $P && echo \"restored $P from $O (next boot)\"",
    );
  }

  /** A command whose output streams into the log box (GPU tests); Stop ends it, Download .txt keeps it. */
  async runStreamed(title: string, cmd: string) {
    if (!this.client) return;
    const t0 = Date.now();
    this.klog = "";
    this.klogHead = `# ${title}, ${new Date().toLocaleString()}: ${cmd}`;
    const tick = setInterval(() => (this.busy = `${title}: ${Math.round((Date.now() - t0) / 1000)} s`), 500);
    this.busy = `${title}…`;
    const dec = new TextDecoder();
    try {
      const r = await this.run(`export PATH=$PATH:/usr/local/bin:/usr/sbin:/sbin; ${cmd} 2>&1`, (b) => (this.klog += dec.decode(b, { stream: true }).replace(/\r/g, "")), true);
      this.klog = r.text;
      const how = r.stopped ? "stopped by you" : r.signal ? `killed by SIG${r.signal}` : `exit ${r.code}`;
      this.klogHead += ` -> ${how} after ${((Date.now() - t0) / 1000).toFixed(1)} s`;
      this.output = `${title}: ${how}`;
    } catch (e) {
      this.error = explain(e as Error);
    } finally {
      clearInterval(tick);
      this.busy = null;
      void this.refreshStatus();
    }
  }

  /** Any file from this computer to a path on the phone (firmware, test tools…). */
  async uploadPicked(file: File, path: string, mode: string) {
    this.busy = `Sending ${file.name} (${Math.round(file.size / 1024)} KB)…`;
    try {
      await this.upload(path, new Uint8Array(await file.arrayBuffer()), mode);
      this.output = `${file.name} -> ${path} (${file.size} bytes, mode ${mode})`;
    } catch (e) {
      this.error = explain(e as Error);
    } finally {
      this.busy = null;
    }
  }

  /**
   * This boot's whole console (kernel lines from the first one, and what daemons write to the console): the ring
   * the kernel flushes every 10 s to the end of the root partition, read raw (4 MiB, read only) and decoded here.
   * Much faster than sweetlog, and never mixed with an older boot; but only the newest 4 MiB.
   */
  async bootConsole() {
    if (!this.client) return;
    const want = RING_BLOCKS * 4096;
    const t0 = Date.now();
    let got = 0;
    this.klog = "";
    this.klogHead = `# boot console (kernel ring at the end of the root partition), read ${new Date().toLocaleString()}`;
    const show = () =>
      (this.busy = got
        ? `Reading the boot console: ${(got / 1048576).toFixed(1)} of ${(want / 1048576).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 1000)} s`
        : `Finding the end of the root partition… ${Math.round((Date.now() - t0) / 1000)} s`);
    show();
    const tick = setInterval(show, 500);
    this.cancel = new AbortController();
    try {
      const r = await this.client.run(READ_RING_CMD, undefined, {
        signal: this.cancel.signal,
        onData: (b, err) => {
          if (!err) got += b.length;
        },
      });
      const err = new TextDecoder().decode(r.stderr).trim();
      if (r.stopped) {
        this.output = "boot console: stopped";
        return;
      }
      if (r.code !== 0 || r.stdout.length < want) {
        this.error = `boot console: could not read it (${err || `exit ${r.code}, ${r.stdout.length} bytes`}). "Full kernel log" (sweetlog) still works.`;
        return;
      }
      const ring = decodeConsoleRing(r.stdout);
      const lines = ring.text.split("\n").filter((l) => l.trim()).length;
      const note = ring.wrapped
        ? `the ring wrapped: only the newest ${ring.size >> 20} MiB of ${(ring.total / 1048576).toFixed(1)} MiB (read it sooner after boot for the start)`
        : `complete since boot (${(ring.total / 1048576).toFixed(2)} MiB)`;
      this.klogHead += `; ${err}; flush #${ring.seq}${ring.panic ? " (PANIC flush)" : ""}; ${note}`;
      this.klog = ring.text;
      log.prependHistory(ring.text, "boot console, " + note);
      this.output = `boot console: ${lines} lines in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${note}. Up to 10 s behind (flush interval).`;
    } catch (e) {
      this.error = explain(e as Error);
    } finally {
      clearInterval(tick);
      this.cancel = null;
      this.busy = null;
    }
  }

  /** Kernel lines since boot (sweetlog reads the unified log), else the kernel buffer; put before the live log. */
  async fetchKernelLog() {
    this.busy = "Asking the phone how long it has been up…";
    this.output = null;
    try {
      // the SSH shell's PATH is minimal and this root may ship neither dmesg nor sysctl on it
      // sweetlog walks the unified log from a wall-clock date: a fixed 30 min reached into the previous boot
      // and was killed (jetsam or the watchdog) before it got to this one. Ask for this boot only, from the
      // age of launchd, plus a margin for the clock the RTC offset moves at boot.
      const up = await this.uptime().catch(() => null);
      const secs = up === null ? 900 : Math.min(up + 300, 7200);
      const cmd = [
        "export PATH=$PATH:/usr/sbin:/sbin:/usr/local/bin",
        `if [ -x /usr/local/bin/sweetlog ]; then /usr/local/bin/sweetlog ${secs} 'SWEET GPU' 'SWEET SMMU' 'SWEET TS' 'SWEET TOUCH' 'SWEET RPMH' 'SWEET FB' 2>&1`,
        "elif command -v dmesg >/dev/null 2>&1; then dmesg",
        "elif command -v sysctl >/dev/null 2>&1; then sysctl -n kern.msgbuf",
        `else echo 'no sweetlog, dmesg or sysctl on this root: press "Install tools" first'; echo "PATH=$PATH"; ls /usr/sbin /sbin /usr/local/bin 2>/dev/null | tr '\\n' ' '; fi`,
      ].join("; ");
      const t0 = Date.now();
      let lines = 0;
      this.klog = "";
      this.klogHead = `# kernel log via sweetlog, phone up ${up === null ? "?" : fmtSecs(up)}, last ${fmtSecs(secs)}, started ${new Date().toLocaleString()}`;
      const show = () => {
        const sec = Math.round((Date.now() - t0) / 1000);
        this.busy = `Reading the kernel log (last ${fmtSecs(secs)}): ${lines} lines so far, ${sec} s` +
          (lines ? "" : " (sweetlog prints nothing until it reaches the window; can take a minute)");
      };
      show();
      const tick = setInterval(show, 1000);
      const dec = new TextDecoder();
      const onData = (b: Uint8Array) => {
        const t = dec.decode(b, { stream: true }).replace(/\r/g, "");
        lines += (t.match(/\n/g) ?? []).length;
        // kept in the page as it comes (the box shows it, "Download .txt" saves it), capped at 16 MB
        if (this.klog.length < 16 << 20) this.klog += t;
      };
      let r;
      try {
        r = await this.run(cmd, onData, true);
        // a dropbear that will not keep a pty open: hung up straight away, nothing read; again without one
        if (!r.stopped && r.signal === "HUP" && !r.text.trim()) r = await this.run(cmd, onData, false);
      } finally {
        clearInterval(tick);
      }
      const { text, code, signal, stopped } = r;
      const cut = stopped ? "STOPPED by you" : signal ? `CUT: sweetlog killed (${signal})` : "";
      this.klog = text;
      this.klogHead += `, ended ${new Date().toLocaleTimeString()}: ${stopped ? "stopped by you" : signal ? `killed by SIG${signal}, the end is missing` : `exit ${code}`}`;
      const head = `kernel log, phone up ${up === null ? "?" : fmtSecs(up)}, last ${fmtSecs(secs)}` + (cut ? `, ${cut}` : "");
      if (text.trim()) log.prependHistory(text, head + " at " + new Date().toLocaleTimeString());
      const n = text.split("\n").filter((l) => l.trim()).length;
      const how = stopped ? "stopped, what came is kept" : signal ? `killed by SIG${signal} (the end is missing)` : `exit ${code}`;
      this.output = `kernel log: ${n} lines in ${((Date.now() - t0) / 1000).toFixed(1)} s (${how}; phone up ${up === null ? "?" : fmtSecs(up)}), put before the live log` + (n ? "" : `\n${text || "(no output)"}`);
    } catch (e) {
      this.error = explain(e as Error);
    } finally {
      this.busy = null;
    }
  }

  output = $state<string | null>(null);

  /** What the kernel log button collected (live while it runs), and its header line. */
  klog = $state("");
  klogHead = $state("");

  /** The collected kernel log as a .txt download. */
  saveKernelLog() {
    const url = URL.createObjectURL(new Blob([this.klogHead + "\n" + this.klog], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `bergamota-kernel-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /** The processes using the most CPU (the little cores were pegged on the first boots). */
  async topCpu() {
    this.busy = "Listing processes…";
    try {
      const { text } = await this.run(
        "if command -v ps >/dev/null 2>&1; then ps -A -o pid=,%cpu=,time=,comm= | sort -k2 -nr | head -25; else echo 'no ps on this root'; fi; echo; uptime 2>/dev/null",
      );
      this.output = text;
    } catch (e) {
      this.error = explain(e as Error);
    } finally {
      this.busy = null;
    }
  }

  /** A clean reboot: sweetreboot flushes the filesystem before resetting (never hard-reset iOS). */
  async reboot(mode: RebootMode) {
    this.busy = mode === "poweroff" ? "Powering off…" : `Rebooting to ${mode}…`;
    this.rebooting = mode;
    try {
      const cmd =
        mode === "poweroff"
          ? "sync; reboot -p 2>/dev/null || halt -p 2>/dev/null || shutdown -h now 2>/dev/null"
          : `sync; /usr/local/bin/sweetreboot ${mode} 2>/dev/null || reboot`;
      void this.run(cmd).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      this.busy = null;
      this.disconnect();
    }
  }

  /**
   * Un clic pour l'IA : rassemble l'ensemble des métriques d'exécution, d'état noyau,
   * de processus, de logs de boot et de crashs dans un seul fichier .txt horodaté et le télécharge.
   */
  async exportAiDiag() {
    if (!this.client) return;
    this.busy = "Génération du diagnostic IA complet…";
    this.output = null;
    try {
      const diagScript = [
        "export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "echo '=== SECTION: SYSTÈME & UPTIME ==='",
        "echo \"Date: $(date 2>/dev/null)\"",
        "echo \"Uptime: $(uptime 2>/dev/null)\"",
        "echo \"launchd age (ps etime): $(ps -o etime= -p 1 2>/dev/null)\"",
        "uname -a 2>/dev/null || true",
        "sw_vers 2>/dev/null || true",
        "echo '== Montages / espace disque:'",
        "mount 2>/dev/null | head -n 12; df -h / /private/var 2>/dev/null",
        "echo '== Firmware GPU présent (le noyau lit ces dossiers):'",
        "ls -l /usr/local/share/firmware /usr/standalone/firmware/sweet 2>&1 | head -n 20",
        "echo '== Nettoyage CPU par défaut (docs/CPU_IDLE.md):'",
        "cat /var/root/IDLE-CPU.txt 2>/dev/null | head -n 8 || echo '(absent)'",
        "echo ''",
        "echo '=== SECTION: TOP PROCESSUS CPU & MÉMOIRE ==='",
        "ps aux 2>/dev/null | head -n 45 || ps -ef 2>/dev/null | head -n 45",
        "echo ''",
        "echo '=== SECTION: DUMP CPU PAR PROCESSUS ET PAR THREAD (deux échantillons à 6 s) ==='",
        "echo '== top par thread (si présent):'",
        "(top -H -b -n 1 2>/dev/null || top -b -n 1 -H 2>/dev/null || top -l 1 -stats pid,command,cpu,threads 2>/dev/null) | head -n 60 | cut -c1-170",
        "echo '== ps threads (-M / -T) échantillon A:'",
        "ps -M 2>/dev/null | head -n 5 || true; ps -AT 2>/dev/null | head -n 5 || true",
        "echo '== temps CPU cumulé A (pid, time, commande):'",
        "ps -A -o pid,time,command 2>/dev/null | cut -c1-130 > /var/tmp/diag-ps-a.txt; wc -l < /var/tmp/diag-ps-a.txt",
        "sleep 6",
        "ps -A -o pid,time,command 2>/dev/null | cut -c1-130 > /var/tmp/diag-ps-b.txt",
        "echo '== processus dont le temps CPU a bougé entre A et B (lignes B qui diffèrent de A):'",
        "grep -v -x -F -f /var/tmp/diag-ps-a.txt /var/tmp/diag-ps-b.txt | head -n 40",
        "rm -f /var/tmp/diag-ps-a.txt /var/tmp/diag-ps-b.txt",
        "echo '== charge par cœur / fréquences noyau (kern.sweet_cpufreq):'",
        "sysctl -n kern.sweet_cpufreq 2>/dev/null | head -n 40",
        "echo '== vm_stat / mémoire:'",
        "vm_stat 2>/dev/null | head -n 30; sysctl hw.memsize hw.ncpu hw.physicalcpu vm.page_free_count 2>/dev/null",
        "echo '== launchd: jobs en échec (statut != 0 ou sans pid):'",
        "launchctl list 2>/dev/null | grep -v -E '^[-0-9]+[[:space:]]+0[[:space:]]' | head -n 40",
        "echo ''",
        "echo '=== SECTION: SAFARI, CONTENEURS ET ICÔNES RÉGLAGES ==='",
        "ls -la /var/mobile/Library/Safari /var/mobile/Library/Safari/Bookmarks* /var/mobile/Library/WebKit /var/mobile/Library/Caches/com.apple.mobilesafari 2>&1 | head -n 60",
        "echo '== conteneurs de données (Safari, Preferences):'",
        "ls -la /var/mobile/Containers/Data/Application 2>&1 | head -n 30; ls -la /var/mobile/Containers/Data/PluginKitPlugin 2>&1 | head -n 10",
        "echo '== Preferences.app (ressources, icônes):'",
        "ls -la /Applications/Preferences.app 2>&1 | head -n 40; ls /Applications/Preferences.app/*.car /Applications/Preferences.app/Assets.car 2>&1 | head -n 5",
        "echo '== cache d icônes/LaunchServices:'",
        "ls -la /var/mobile/Library/Caches/com.apple.UIKit.pboard /var/mobile/Library/Caches/com.apple.LaunchServices* /var/containers/Data/System 2>&1 | head -n 20",
        "echo '== lignes de log système sur Safari/webbookmarksd/Preferences (console noyau):'",
        "(dmesg 2>/dev/null || true) | grep -i -E 'safari|webbookmarks|Preferences|exception|sandbox|deny' | tail -n 40 | cut -c1-240",
        "echo ''",
        "echo '=== SECTION: SYSCTL SWEET NOYAU ==='",
        "if command -v sysctl >/dev/null 2>&1; then",
        "  for k in kern.sweet_cpufreq kern.sweet_amp kern.sweet_amp_mode kern.sweet_amp_migrate kern.sweet_amp_kick kern.sweet_amp_reserve kern.sweet_gpu kern.sweet_fb kern.sweet_display_off kern.sweet_charger kern.sweet_reboot_mode kern.sweet_cpufreq_boost; do echo \"-- $k\"; sysctl -n $k 2>&1 | head -n 40; done",
        "  echo '-- tous les kern.sweet* (sysctl -a):'; sysctl -a 2>/dev/null | grep -i sweet | cut -c1-200 | head -n 80",
        "else echo '(pas de binaire sysctl sur ce root)'; fi",
        "echo '-- sweetmetrics (lit les sysctl sweet):'",
        "if [ -x /usr/local/bin/sweetmetrics ]; then /usr/local/bin/sweetmetrics 2>&1 | head -n 80; else echo '(sweetmetrics absent: installer les outils)'; fi",
        "echo ''",
        "echo '=== SECTION: CHLOROPHYLL & GPU ADRENO 630 ==='",
        "ls -la /usr/local/lib/bgmtl/ /private/var/tmp/bgmtl* 2>/dev/null || true",
        "ls -l /usr/libexec/backboardd /usr/libexec/backboardd.orig 2>/dev/null || true",
        "for f in /private/var/tmp/bgmtl-bb.state /private/var/tmp/bgmtl-bb.off; do [ -e $f ] && { echo \"== $f\"; cat $f; }; done",
        "echo '== Dernières lignes bgmtl.log:'",
        "tail -n 60 /private/var/tmp/bgmtl.log 2>/dev/null || echo '(aucun log bgmtl)'",
        "echo '== Lignes de performance (fps, encodage, pool de textures):'",
        "grep -E 'perf2?:|frames:|texpool|mempool' /private/var/tmp/bgmtl.log 2>/dev/null | tail -n 40 || true",
        "echo '== Tests GPU présents:'",
        "ls -l /var/root/turnip-test/tu_smoke /var/root/chl-test/chl_test 2>&1 | head -n 4",
        "echo ''",
        "echo '=== SECTION: DÉMONS GIVRÉS & CRASH LOOPS ==='",
        "echo '== Fichiers dans disabled-bin:'",
        "cat /var/root/disabled-bin/README 2>/dev/null || echo '(aucun binaire garé)'",
        "echo '== Audio HAL Plugins:'",
        "ls -la /Library/Audio/Plug-Ins/ /System/Library/Audio/Plug-Ins/ 2>/dev/null || true",
        "echo ''",
        "echo '=== SECTION: RAPPORTS DE CRASH RÉCENTS ==='",
        "ls -lt /Library/Logs/CrashReporter /var/mobile/Library/Logs/CrashReporter 2>/dev/null | head -n 25 || true",
        "echo '== Compte des crashs par processus:'",
        "ls /var/mobile/Library/Logs/CrashReporter 2>/dev/null | sed 's/-[0-9][0-9-]*\\..*//' | sort | uniq -c | sort -rn | head -n 12",
        "echo '== Début du crash le plus récent:'",
        "f=$(ls -t /var/mobile/Library/Logs/CrashReporter/*.ips 2>/dev/null | head -n 1); [ -n \"$f\" ] && { echo \"$f\"; head -c 1800 \"$f\"; echo; } || echo '(aucun)'",
        "echo ''",
        "echo '=== SECTION: RAPPORTS DE CRASH COMPLETS (tous les .ips, du plus récent, 60 Ko max chacun, 80 fichiers max) ==='",
        "for f in $(ls -t /var/mobile/Library/Logs/CrashReporter/*.ips /Library/Logs/CrashReporter/*.ips 2>/dev/null | head -n 80); do n=$(wc -c < \"$f\"); echo \"##### $f ($n octets)\"; head -c 60000 \"$f\"; [ \"$n\" -gt 60000 ] && echo \"[... tronqué: $((n-60000)) octets de plus]\"; echo; done",
        "echo ''",
        "echo '=== SECTION: PROCESSUS LES PLUS GOURMANDS (TOP 12, tri CPU) ==='",
        "ps aux 2>/dev/null | sort -k3 -rn | head -n 12 | cut -c1-170",
        "echo ''",
        "echo '=== SECTION: SERVICES LAUNCHD (compte, désactivés) ==='",
        "launchctl list 2>/dev/null | wc -l; ls /private/var/db/com.apple.xpc.launchd/ 2>/dev/null; cat /private/var/db/com.apple.xpc.launchd/disabled.plist 2>/dev/null | head -n 40",
      ].join("\n");

      const res = await this.run(diagScript);
      const report = [
        "================================================================================",
        "BERGAMOTA FAJITA - RAPPORT DE DIAGNOSTIC COMPLET POUR IA",
        `Généré le: ${new Date().toISOString()} (${new Date().toLocaleString()})`,
        "Cible: OnePlus 6T (fajita, SDM845, Adreno 630)",
        "================================================================================",
        "",
        res.text.trim(),
        "",
        "================================================================================",
        "=== SECTION: EXTRAIT CONSOLE DE BOOT & NOYAU ===",
        "================================================================================",
      ];

      // The page's own live kernel log (UDP 5140 over USB, REPLAY since boot): the part no SSH command can give, and the part that
      // survives a reset up to the last second. Key lines first (boot, SWEET subsystems, crashes, reboot), then the tail.
      const ring = log.lines;
      if (ring.length > 0) {
        const keyRe = /SWEET (REBOOT|GPU|AMP|CPUFREQ: (gov|governor|domain)|TS|FB: stats|CHARGER|HFS|UFS|SMMU)|CRASH |panic|Panic|PANIC|launchd got|System shutdown|Qualcomm|dload|sdi st/;
        const key = ring.filter((l) => keyRe.test(l.text) && !/LUT\[/.test(l.text)).map((l) => l.text);
        report.push("");
        report.push("================================================================================");
        report.push(`=== SECTION: LOG NOYAU TEMPS RÉEL DE LA PAGE (${ring.length} lignes en mémoire) ===`);
        report.push("================================================================================");
        report.push(`--- Lignes clés (${Math.min(key.length, 1500)} sur ${key.length}) ---`);
        report.push(key.slice(-1500).join("\n"));
        report.push("");
        report.push("--- Les 600 dernières lignes ---");
        report.push(ring.slice(-600).map((l) => l.text).join("\n"));
      } else {
        report.push("");
        report.push("(log temps réel de la page vide: ouvrir la page /log/, \"Connect the phone\", puis \"Log since boot\" avant d'exporter)");
      }
      report.push("");
      report.push(`--- Navigateur: ${typeof navigator !== "undefined" ? navigator.userAgent : "?"} ---`);

      if (this.klog && this.klog.length > 0) {
        report.push(`--- Log mémoire web (${this.klogHead || "console"}) ---`);
        report.push(this.klog.slice(-100000));
      } else {
        const dmesgRes = await this.run("export PATH=$PATH:/usr/sbin:/sbin; dmesg 2>/dev/null | tail -n 120 || sysctl -n kern.msgbuf 2>/dev/null | tail -n 120 || true");
        if (dmesgRes.text.trim()) {
          report.push(dmesgRes.text.trim());
        } else {
          report.push("(Console noyau non accessible via dmesg/sysctl, utilisez 'Console de boot' d'abord si nécessaire)");
        }
      }

      const fullReport = report.join("\n") + "\n";
      const blob = new Blob([fullReport], { type: "text/plain;charset=utf-8" });
      const nowStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `bergamota-diag-ai-${nowStr}.txt`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.output = `Diagnostic IA exporté avec succès :\n  Fichier: ${filename}\n  Taille: ${(fullReport.length / 1024).toFixed(1)} Ko\nPartagez ce fichier directement avec l'IA.`;
    } catch (e) {
      this.error = explain(e as Error);
    } finally {
      this.busy = null;
    }
  }

  /** A shell channel for the terminal (pty sized to it). */
  async shell(cols: number, rows: number): Promise<SshChannel> {
    if (!this.client) throw new SshError("SSH is not connected");
    const ch = await this.client.openSession();
    await ch.pty(cols, rows);
    if (!(await ch.shell())) throw new SshError("the phone refused a shell");
    return ch;
  }
}

/** ps etime: [[dd-]hh:]mm:ss -> seconds. */
export function parseEtime(t: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t);
  if (!m) return null;
  return ((+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * 60 + +m[3]) * 60 + +m[4];
}

function fmtSecs(s: number): string {
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}

function explain(e: Error): string {
  const m = e.message || String(e);
  if (/connection refused/i.test(m)) return "Nothing listens on port 22: this root has no SSH server (patch it again with the tools bundle).";
  if (/does not answer|no answer/i.test(m)) return "The phone does not answer on port 22 yet (iOS still starting?). Try again in a moment.";
  return m;
}

export const sshs = new SshSession();
