// SSH to the phone from the page, over the CDC-ECM link the live log already holds (logsession.stack).
// The private key is kept in memory only: never written to storage, gone when the tab closes.

import { log } from "./logsession.svelte.ts";
import { SshClient, SshError, type SshChannel } from "../lib/ssh.ts";
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
  async run(command: string): Promise<{ text: string; code: number | null }> {
    if (!this.client) throw new SshError("SSH is not connected");
    const r = await this.client.run(command);
    const dec = new TextDecoder();
    return { text: dec.decode(r.stdout) + (r.stderr.length ? dec.decode(r.stderr) : ""), code: r.code };
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

  /** Kernel lines since boot (sweetlog reads the unified log), else the kernel buffer; put before the live log. */
  async fetchKernelLog() {
    this.busy = "Reading the kernel log…";
    try {
      // the SSH shell's PATH is minimal and this root may ship neither dmesg nor sysctl on it
      const cmd = [
        "export PATH=$PATH:/usr/sbin:/sbin:/usr/local/bin",
        // a day of the unified log is far too slow to walk: the last 30 min, only our kernel subsystems
        "if [ -x /usr/local/bin/sweetlog ]; then /usr/local/bin/sweetlog 1800 'SWEET GPU' 'SWEET SMMU' 'SWEET TS' 'SWEET TOUCH' 'SWEET RPMH' 'SWEET FB' 2>&1",
        "elif command -v dmesg >/dev/null 2>&1; then dmesg",
        "elif command -v sysctl >/dev/null 2>&1; then sysctl -n kern.msgbuf",
        `else echo 'no sweetlog, dmesg or sysctl on this root: press "Install tools" first'; echo "PATH=$PATH"; ls /usr/sbin /sbin /usr/local/bin 2>/dev/null | tr '\\n' ' '; fi`,
      ].join("; ");
      const t0 = Date.now();
      const { text, code } = await this.run(cmd);
      log.prependHistory(text, "kernel buffer at " + new Date().toLocaleTimeString());
      const n = text.split("\n").filter((l) => l.trim()).length;
      this.output = `kernel log: ${n} lines in ${((Date.now() - t0) / 1000).toFixed(1)} s (exit ${code}), put before the live log` + (n ? "" : `\n${text || "(no output)"}`);
    } catch (e) {
      this.error = explain(e as Error);
    } finally {
      this.busy = null;
    }
  }

  output = $state<string | null>(null);

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

function explain(e: Error): string {
  const m = e.message || String(e);
  if (/connection refused/i.test(m)) return "Nothing listens on port 22: this root has no SSH server (patch it again with the tools bundle).";
  if (/does not answer|no answer/i.test(m)) return "The phone does not answer on port 22 yet (iOS still starting?). Try again in a moment.";
  return m;
}

export const sshs = new SshSession();
