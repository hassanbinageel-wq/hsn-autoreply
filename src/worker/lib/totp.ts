/**
 * Time-based one-time codes (RFC 6238, the format Google Authenticator / Microsoft Authenticator use):
 * HMAC-SHA1, 30-second steps, 6 digits.
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export const newTotpSecret = () => base32Encode(crypto.getRandomValues(new Uint8Array(20)));

export async function totpAt(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(step));
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 15;
  const n = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000;
  return String(n).padStart(6, "0");
}

export const totpStep = (now = Date.now()) => Math.floor(now / 30_000);

/** The step the code belongs to (now ±1 step for clock drift), or null. Steps at or before `lastStep` are refused. */
export async function verifyTotp(secret: string, code: string, now = Date.now(), lastStep: number | null = null): Promise<number | null> {
  const c = code.replace(/\D/g, "");
  if (c.length !== 6) return null;
  const cur = totpStep(now);
  for (const s of [cur, cur - 1, cur + 1]) {
    if (lastStep !== null && s <= lastStep) continue;
    if ((await totpAt(secret, s)) === c) return s;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string, issuer = "HSN AutoReply") =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

const RC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const newRecoveryCodes = (n = 8) =>
  Array.from({ length: n }, () => {
    const b = crypto.getRandomValues(new Uint8Array(10));
    const s = [...b].map((x) => RC[x % RC.length]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });

export const normRecovery = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
