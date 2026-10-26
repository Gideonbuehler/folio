/**
 * Just enough DER to build and read CMS signatures and X.509 certificates.
 * Parsed nodes keep their byte offsets, so signed parts can be hashed exactly
 * as they appear in the file.
 */

export interface Node {
  /** Identifier octet (class, constructed bit and tag number < 31). */
  tag: number;
  /** Offset of the identifier octet, of the content, and the end, in `src`. */
  start: number;
  body: number;
  end: number;
  src: Uint8Array;
  children: Node[];
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8: 0x0c,
  PRINTABLE: 0x13,
  T61: 0x14,
  IA5: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  BMP: 0x1e,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** Parses one element (and, if constructed, its children) at `at`. */
export function parse(src: Uint8Array, at = 0, limit = src.length): Node {
  if (at + 2 > limit) throw new Error('Truncated DER');
  const tag = src[at];
  if ((tag & 0x1f) === 0x1f) throw new Error('Unsupported DER tag');
  let len = src[at + 1];
  let body = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (!n || n > 4) throw new Error('Unsupported DER length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + src[body + i];
    body += n;
  }
  const end = body + len;
  if (end > limit) throw new Error('Truncated DER');
  const node: Node = { tag, start: at, body, end, src, children: [] };
  if (tag & 0x20) {
    for (let p = body; p < end; ) {
      const child = parse(src, p, end);
      node.children.push(child);
      p = child.end;
    }
  }
  return node;
}

export const bytesOf = (n: Node) => n.src.subarray(n.body, n.end);
export const rawOf = (n: Node) => n.src.subarray(n.start, n.end);

export function oidOf(n: Node): string {
  const b = bytesOf(n);
  const parts: number[] = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

export function textOf(n: Node): string {
  const b = bytesOf(n);
  if (n.tag === TAG.BMP) {
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  if (n.tag === TAG.UTF8) return new TextDecoder().decode(b);
  return String.fromCharCode(...b);
}

export function timeOf(n: Node): Date {
  const s = textOf(n);
  const m = s.match(/^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?(Z|[+-]\d{4})?$/);
  if (!m) return new Date(NaN);
  let year = Number(m[1]);
  if (m[1].length === 2) year += year < 50 ? 2000 : 1900;
  const utc = Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  const tz = m[7] && m[7] !== 'Z' ? (m[7][0] === '-' ? -1 : 1) * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3))) : 0;
  return new Date(utc - tz * 60_000);
}

/* ------------------------------------------------------------------ */
/* Encoding                                                             */
/* ------------------------------------------------------------------ */

function lengthBytes(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return [0x80 | out.length, ...out];
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One element: tag, length, then the content (raw bytes or already-encoded children). */
export function el(tag: number, content: Uint8Array | Uint8Array[]): Uint8Array {
  const body = Array.isArray(content) ? concat(content) : content;
  return concat([new Uint8Array([tag, ...lengthBytes(body.length)]), body]);
}

export const seq = (...items: Uint8Array[]) => el(TAG.SEQUENCE, items);
export const set = (...items: Uint8Array[]) => el(TAG.SET, items);
/** SET OF in DER order (sorted by encoding). */
export const setOf = (items: Uint8Array[]) => el(TAG.SET, [...items].sort(compareBytes));
export const nul = () => new Uint8Array([TAG.NULL, 0]);
export const octets = (b: Uint8Array) => el(TAG.OCTET_STRING, b);
/** Context-specific tag [n]; constructed unless `primitive`. */
export const ctx = (n: number, content: Uint8Array | Uint8Array[], primitive = false) => el((primitive ? 0x80 : 0xa0) | n, content);

export function int(n: number | Uint8Array): Uint8Array {
  if (n instanceof Uint8Array) {
    let b = n;
    let i = 0;
    while (i < b.length - 1 && b[i] === 0 && !(b[i + 1] & 0x80)) i++;
    b = b.subarray(i);
    if (b[0] & 0x80) b = concat([new Uint8Array([0]), b]);
    return el(TAG.INTEGER, b);
  }
  const out: number[] = [];
  do {
    out.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  if (out[0] & 0x80) out.unshift(0);
  return el(TAG.INTEGER, new Uint8Array(out));
}

export function oid(dotted: string): Uint8Array {
  const p = dotted.split('.').map(Number);
  const out: number[] = [p[0] * 40 + p[1]];
  for (const v of p.slice(2)) {
    const chunk: number[] = [v & 0x7f];
    let x = Math.floor(v / 128);
    while (x > 0) {
      chunk.unshift((x & 0x7f) | 0x80);
      x = Math.floor(x / 128);
    }
    out.push(...chunk);
  }
  return el(TAG.OID, new Uint8Array(out));
}

export function compareBytes(a: Uint8Array, b: Uint8Array) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export function equalBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && compareBytes(a, b) === 0;
}

export const toHex = (b: Uint8Array) => [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
