/**
 * A copy of a TrueType/OpenType font without the named tables. Used to drop
 * embedded bitmaps (EBDT/EBLC/EBSC): fontkit treats every glyph of a font that
 * has them as a bitmap and can't subset it, while the outlines are all that
 * screen rendering and PDF embedding need.
 */
export function withoutTables(bytes: Uint8Array, drop: string[]): Uint8Array {
  if (bytes.length < 12) return bytes;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = v.getUint32(0);
  // TrueType (1.0 or 'true') and CFF ('OTTO') outlines; leave anything else alone.
  if (version !== 0x00010000 && version !== 0x74727565 && version !== 0x4f54544f) return bytes;
  const count = v.getUint16(4);
  if (bytes.length < 12 + count * 16) return bytes;
  const tables: { tag: string; sum: number; off: number; len: number }[] = [];
  for (let i = 0; i < count; i++) {
    const o = 12 + i * 16;
    tables.push({
      tag: String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]),
      sum: v.getUint32(o + 4),
      off: v.getUint32(o + 8),
      len: v.getUint32(o + 12),
    });
  }
  const keep = tables.filter((t) => !drop.includes(t.tag));
  if (keep.length === count || keep.some((t) => t.off + t.len > bytes.length)) return bytes;
  const pad = (n: number) => (n + 3) & ~3;
  const start = 12 + keep.length * 16;
  const out = new Uint8Array(keep.reduce((n, t) => n + pad(t.len), start));
  const w = new DataView(out.buffer);
  const pow = 2 ** Math.floor(Math.log2(keep.length));
  w.setUint32(0, version);
  w.setUint16(4, keep.length);
  w.setUint16(6, pow * 16);
  w.setUint16(8, Math.log2(pow));
  w.setUint16(10, keep.length * 16 - pow * 16);
  let at = start;
  keep.forEach((t, i) => {
    const o = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[o + k] = t.tag.charCodeAt(k);
    w.setUint32(o + 4, t.sum);
    w.setUint32(o + 8, at);
    w.setUint32(o + 12, t.len);
    out.set(bytes.subarray(t.off, t.off + t.len), at);
    at += pad(t.len);
  });
  return out;
}
