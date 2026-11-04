<script lang="ts">
  import { Terminal } from "@xterm/xterm";
  import "@xterm/xterm/css/xterm.css";
  import { sshs } from "./sshsession.svelte.ts";
  import type { SshChannel } from "../lib/ssh.ts";

  let el: HTMLElement | undefined = $state();
  let status = $state("");

  // one terminal + one shell channel per SSH connection
  $effect(() => {
    if (!el || sshs.state !== "ready") return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "JetBrains Mono, monospace", theme: { background: "#161616" }, convertEol: false });
    term.open(el);
    // size the pty to the box (xterm measures one cell after open)
    const cell = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core?._renderService?.dimensions?.css?.cell;
    const cols = Math.max(40, Math.floor((el.clientWidth - 8) / (cell?.width || 8)));
    const rows = Math.max(12, Math.floor((el.clientHeight - 8) / (cell?.height || 17)));
    term.resize(cols, rows);
    let ch: SshChannel | null = null;
    let alive = true;
    status = "opening a shell…";
    sshs
      .shell(cols, rows)
      .then((c) => {
        if (!alive) return c.close();
        ch = c;
        status = "";
        const dec = new TextDecoder();
        c.ondata = (b) => term.write(dec.decode(b, { stream: true }));
        c.onstderr = (b) => term.write(dec.decode(b, { stream: true }));
        c.onclose = () => term.write("\r\n\x1b[2m[shell closed]\x1b[0m\r\n");
        term.focus();
      })
      .catch((e) => (status = (e as Error).message));
    const enc = new TextEncoder();
    const sub = term.onData((d) => void ch?.write(enc.encode(d)).catch(() => {}));
    return () => {
      alive = false;
      sub.dispose();
      ch?.close();
      term.dispose();
    };
  });
</script>

<div class="term" bind:this={el} aria-label="SSH terminal"></div>
{#if status}<p class="muted">{status}</p>{/if}

<style>
  .term { height: min(52vh, 520px); background: #161616; border-radius: 8px; padding: 4px; overflow: hidden; }
  .muted { color: var(--ink-soft); font-size: 13px; margin: 6px 0 0; }
</style>
