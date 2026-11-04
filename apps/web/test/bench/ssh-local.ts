// SshClient against a real dropbear over a plain Node socket. Usage: ssh-local.ts HOST PORT KEYFILE
import net from "node:net";
import { readFileSync } from "node:fs";
import { SshClient } from "../../src/lib/ssh.ts";
import { parseOpenSshKey } from "../../src/lib/sshkey.ts";

const [host, port, keyf] = process.argv.slice(2);
const key = parseOpenSshKey(readFileSync(keyf, "utf8"));
const sock = net.createConnection(Number(port), host);
const ssh = new SshClient((b) => new Promise((r) => sock.write(b, () => r())), { key, log: (s) => console.log(s) });
sock.on("data", (d) => ssh.feed(new Uint8Array(d)));
sock.on("close", () => ssh.transportClosed());
sock.on("connect", async () => {
  try {
    await ssh.connect();
    console.log("AUTH OK, server", ssh.serverId);
    const r = await ssh.run("echo hello-from-$(uname -s); id -u");
    console.log("EXEC:", JSON.stringify(new TextDecoder().decode(r.stdout)), "code", r.code);
    const big = new Uint8Array(1 << 20).map((_, i) => (i * 7) & 0xff);
    const w = await ssh.run("wc -c", big);
    console.log("STDIN 1MiB -> wc:", new TextDecoder().decode(w.stdout).trim(), "code", w.code);
    const h = await ssh.run("head -c 3000000 /dev/zero | sha256sum");
    console.log("STDOUT 3MB sha:", new TextDecoder().decode(h.stdout).slice(0, 16));
    ssh.disconnect();
    setTimeout(() => sock.end(), 100);
  } catch (e) {
    console.log("FAIL:", (e as Error).message);
    process.exit(1);
  }
});
