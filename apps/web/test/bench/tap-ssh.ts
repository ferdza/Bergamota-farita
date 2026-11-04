// Full browser chain on the bench: SshClient -> IpStack (TCP) -> Ethernet frames -> TAP -> Linux + dropbear.
import net from "node:net";
import { readFileSync } from "node:fs";
import { NetLogEngine } from "../../src/lib/netlog.ts";
import { IpStack } from "../../src/lib/ipstack.ts";
import { SshClient } from "../../src/lib/ssh.ts";
import { parseOpenSshKey } from "../../src/lib/sshkey.ts";

const [sockPath, portS, keyf] = process.argv.slice(2);
const c = net.createConnection(sockPath);
let buf = Buffer.alloc(0);
const send = (f: Uint8Array) => { const h = Buffer.alloc(2); h.writeUInt16BE(f.length); c.write(Buffer.concat([h, Buffer.from(f)])); };
const engine = new NetLogEngine();
const stack = new IpStack(send);
c.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
    const n = buf.readUInt16BE(0); const f = new Uint8Array(buf.subarray(2, 2 + n)); buf = buf.subarray(2 + n);
    const { reply } = engine.handle(f); if (reply) send(reply); stack.onFrame(f);
  }
});
c.on("connect", async () => {
  try {
    send(engine.whoHas());
    const t0 = Date.now();
    const tcp = await stack.connect(Number(portS));
    const ssh = new SshClient((b) => tcp.write(b), { key: parseOpenSshKey(readFileSync(keyf, "utf8")) });
    tcp.ondata = (b) => ssh.feed(b);
    tcp.onclose = (e) => ssh.transportClosed(e);
    await ssh.connect();
    console.log(`AUTH OK over our TCP in ${Date.now() - t0} ms (${ssh.serverId})`);
    const r = await ssh.run("uname -a; echo done");
    console.log("EXEC:", new TextDecoder().decode(r.stdout).trim().split("\n").pop(), "code", r.code);
    const big = new Uint8Array(4 << 20).map((_, i) => (i * 13) & 0xff);
    const t1 = Date.now();
    const w = await ssh.run("cat > /dev/null; echo ok", big);
    const s = (Date.now() - t1) / 1000;
    console.log(`UPLOAD 4 MiB: ${new TextDecoder().decode(w.stdout).trim()} in ${s.toFixed(2)} s = ${(4 / s).toFixed(1)} MiB/s`);
    ssh.disconnect(); setTimeout(() => process.exit(0), 200);
  } catch (e) { console.log("FAIL:", (e as Error).message); process.exit(1); }
});
