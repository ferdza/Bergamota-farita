// SSH to the phone from the page, over the CDC-ECM link the live log already holds (logsession.stack).
// The private key is kept in memory only: never written to storage, gone when the tab closes.

import { log } from "./logsession.svelte.ts";
import { SshClient, SshError, type SshChannel } from "../lib/ssh.ts";
import { planZip } from "../lib/zipinstall.ts";
import wasmUrl from "../patcher/renegade.wasm?url";
import { Renegade } from "../patcher/wasm.ts";
import { decodeConsoleRing, READ_RING_CMD, RING_BLOCKS } from "../lib/consolering.ts";
import { parseOpenSshKey, publicLine, SshKeyError, type Ed25519Key } from "../lib/sshkey.ts";

export type RebootMode = "fastboot" | "bergamota" | "recovery" | "normal";

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
      const names = ["sweetlog", "sweetmetrics", "sweetshot", "sweetsample", "sweettouch", "sweetprefs"];
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
      this.renegade ??= fetch(wasmUrl).then((r) => r.arrayBuffer()).then((b) => Renegade.standalone(b));
      // iOS 26 kept a short name for binaries with little header slack: /usr/local/bgi.dylib, a symlink to the inject
      let lib = INJ;
      let signed: Uint8Array;
      try {
        signed = (await this.renegade).linkDylib(bin, INJ, true);
      } catch (e) {
        if (!/no slack/.test((e as Error).message)) throw e;
        lib = "/usr/local/bgi.dylib";
        signed = (await this.renegade).linkDylib(bin, lib, true);
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
    }
  }

  /** The kill switch (what the inject's dead-man writes): backboardd starts stock from its next start, wiring kept. */
  async gpuOff() {
    await this.runStreamed("GPU off", "cd /private/var/tmp && echo 'off from the web page' > bgmtl-bb.off && ls -l bgmtl-bb.*");
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
    this.busy = `Rebooting to ${mode}…`;
    this.rebooting = mode;
    try {
      // the command does not come back (the phone resets); give it a moment, then drop the session
      void this.run(`sync; /usr/local/bin/sweetreboot ${mode}`).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      this.busy = null;
      this.disconnect();
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
