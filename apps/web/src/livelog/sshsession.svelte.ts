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
      const ssh = new SshClient((b) => tcp.write(b), { key: this.key });
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

  /** Fetches the kernel's whole message buffer and puts it before the live log. */
  async fetchKernelLog() {
    this.busy = "Reading the kernel log…";
    try {
      const { text } = await this.run("dmesg 2>/dev/null || sysctl -n kern.msgbuf");
      log.prependHistory(text, "kernel buffer at " + new Date().toLocaleTimeString());
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
