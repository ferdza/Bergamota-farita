// OpenSSH private keys ("-----BEGIN OPENSSH PRIVATE KEY-----", openssh-key-v1), ed25519 only, unencrypted.
// The key never leaves the page: it is parsed here and used by ssh.ts to sign the login challenge.

export interface Ed25519Key {
  seed: Uint8Array; // 32-byte private seed
  pub: Uint8Array; // 32-byte public key
  comment: string;
}

export class SshKeyError extends Error {}

const MAGIC = "openssh-key-v1\0";

class Reader {
  private v: DataView;
  private b: Uint8Array;
  off = 0;
  constructor(b: Uint8Array) {
    this.b = b;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u32(): number {
    if (this.off + 4 > this.b.length) throw new SshKeyError("the key is truncated");
    const n = this.v.getUint32(this.off, false);
    this.off += 4;
    return n;
  }
  bytes(): Uint8Array {
    const n = this.u32();
    if (this.off + n > this.b.length) throw new SshKeyError("the key is truncated");
    const r = this.b.subarray(this.off, this.off + n);
    this.off += n;
    return r;
  }
  str(): string {
    return new TextDecoder().decode(this.bytes());
  }
}

/** Parses an OpenSSH ed25519 private key. Throws a readable error for anything else. */
export function parseOpenSshKey(text: string): Ed25519Key {
  const t = text.trim();
  if (/BEGIN (RSA|EC|DSA) PRIVATE KEY|BEGIN PRIVATE KEY/.test(t)) throw new SshKeyError("That is an RSA/ECDSA/PKCS#8 key. Use an ed25519 key (ssh-keygen -t ed25519).");
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(t);
  if (!m) {
    if (/^ssh-ed25519 /.test(t)) throw new SshKeyError("That is the PUBLIC key (.pub). Paste the private one: ~/.ssh/id_ed25519.");
    throw new SshKeyError("Paste the whole private key, from -----BEGIN OPENSSH PRIVATE KEY----- to -----END OPENSSH PRIVATE KEY-----.");
  }
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(m[1].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  } catch {
    throw new SshKeyError("The key's base64 is damaged.");
  }
  if (new TextDecoder().decode(raw.subarray(0, MAGIC.length)) !== MAGIC) throw new SshKeyError("Not an OpenSSH key.");
  const r = new Reader(raw.subarray(MAGIC.length));
  const cipher = r.str();
  const kdf = r.str();
  r.bytes(); // kdf options
  if (cipher !== "none" || kdf !== "none")
    throw new SshKeyError("This key has a passphrase. Make a copy without one for the phone: cp ~/.ssh/id_ed25519 /tmp/k && ssh-keygen -p -N '' -f /tmp/k, then paste /tmp/k (and delete it after).");
  if (r.u32() !== 1) throw new SshKeyError("The file holds several keys; paste a single one.");
  r.bytes(); // public key blob (repeated inside)
  const priv = new Reader(r.bytes());
  if (priv.u32() !== priv.u32()) throw new SshKeyError("The key's check bytes do not match (damaged key).");
  const type = priv.str();
  if (type !== "ssh-ed25519") throw new SshKeyError(`Key type ${type}: only ssh-ed25519 is supported.`);
  const pub = priv.bytes();
  const sk = priv.bytes(); // 64 bytes: seed || pub
  const comment = priv.str();
  if (pub.length !== 32 || sk.length !== 64) throw new SshKeyError("Malformed ed25519 key.");
  return { seed: sk.slice(0, 32), pub: pub.slice(), comment };
}

/** "ssh-ed25519 AAAA… comment", the line that goes in authorized_keys (to compare with the patched root). */
export function publicLine(k: Ed25519Key): string {
  const name = new TextEncoder().encode("ssh-ed25519");
  const blob = new Uint8Array(4 + name.length + 4 + 32);
  const v = new DataView(blob.buffer);
  v.setUint32(0, name.length, false);
  blob.set(name, 4);
  v.setUint32(4 + name.length, 32, false);
  blob.set(k.pub, 8 + name.length);
  return `ssh-ed25519 ${btoa(String.fromCharCode(...blob))}${k.comment ? " " + k.comment : ""}`;
}
