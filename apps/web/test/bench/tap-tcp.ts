// End-to-end bench (root, Linux): the kernel on a TAP device plays the phone (192.168.7.2), our IpStack is the
// host (192.168.7.1). Usage: node --experimental-strip-types test/bench/tap-tcp.ts SOCK PORT [bytes]
import net from "node:net";
import { NetLogEngine } from "../../src/lib/netlog.ts";
import { IpStack } from "../../src/lib/ipstack.ts";

const [sock, portS, nS] = process.argv.slice(2);
const c = net.createConnection(sock);
let buf = Buffer.alloc(0);
const DROP = Number(process.env.DROP || 0);
const send = (f: Uint8Array) => { if (Math.random() < DROP) return; const h = Buffer.alloc(2); h.writeUInt16BE(f.length); c.write(Buffer.concat([h, Buffer.from(f)])); };
const engine = new NetLogEngine();
const stack = new IpStack(send);
c.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
    const n = buf.readUInt16BE(0);
    const f = new Uint8Array(buf.subarray(2, 2 + n));
    buf = buf.subarray(2 + n);
    if (Math.random() < DROP) continue;
    const { reply } = engine.handle(f);
    if (reply) send(reply);
    stack.onFrame(f);
  }
});
c.on("connect", async () => {
  send(engine.whoHas());
  const t0 = Date.now();
  const conn = await stack.connect(Number(portS));
  let got = 0; const want = Number(nS || 0); let text = "";
  const rx: Uint8Array[] = [];
  conn.ondata = (b) => { got += b.length; rx.push(b); if (text.length < 200) text += Buffer.from(b).toString("latin1"); };
  const tick = setInterval(() => console.error(`progress: got ${got} / ${want} pending ${conn.pending} state ${conn.state}`), 2000);
  if (want) {
    // echo-style bulk test: send `want` bytes, expect the same count back
    const chunk = new Uint8Array(4096).map((_, i) => i & 0xff);
    for (let s = 0; s < want; s += chunk.length) await conn.write(chunk.subarray(0, Math.min(chunk.length, want - s)));
    while (got < want) await new Promise((r) => setTimeout(r, 20));
    const all = Buffer.concat(rx.map((b) => Buffer.from(b)));
    let bad = -1;
    for (let i = 0; i < want; i++) if (all[i] !== (i % 4096 & 0xff)) { bad = i; break; }
    console.log(bad < 0 ? `BULK OK ${got} bytes echoed intact in ${Date.now() - t0} ms (drop ${DROP})` : `CORRUPT at byte ${bad}`);
  } else {
    await new Promise((r) => setTimeout(r, 800));
    console.log("BANNER:", JSON.stringify(text.split("\n")[0]));
  }
  conn.close(); setTimeout(() => process.exit(0), 300);
});
