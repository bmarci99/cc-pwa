// Tiny gzip/DEFLATE decoder (RFC 1951/1952) — fallback for browsers without DecompressionStream.
// Small and dependency-free; not fast, but it only runs once per data update.

function buildTree(lengths) {
  const counts = new Uint16Array(16), offs = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  lengths.forEach((l, s) => { if (l) symbols[offs[l]++] = s; });
  return { counts, symbols };
}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let FIXED_L, FIXED_D;
function fixedTrees() {
  if (!FIXED_L) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED_L = buildTree(l);
    FIXED_D = buildTree(new Uint8Array(30).fill(5));
  }
  return [FIXED_L, FIXED_D];
}

/** Raw DEFLATE -> Uint8Array. */
export function inflateRaw(src, sizeHint = 0) {
  let pos = 0, bitBuf = 0, bitCnt = 0;
  let out = new Uint8Array(Math.max(1024, sizeHint || src.length * 4)), op = 0;
  const ensure = (n) => {
    if (op + n <= out.length) return;
    let len = out.length * 2;
    while (len < op + n) len *= 2;
    const o = new Uint8Array(len); o.set(out); out = o;
  };
  const bits = (n) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error('inflate: unexpected end of data');
      bitBuf |= src[pos++] << bitCnt; bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n; bitCnt -= n;
    return v;
  };
  const decode = (t) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = t.counts[len];
      if (code - first < c) return t.symbols[index + code - first];
      index += c; first = (first + c) << 1; code <<= 1;
    }
    throw new Error('inflate: bad code');
  };
  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      ensure(len);
      out.set(src.subarray(pos, pos + len), op);
      pos += len; op += len;
      continue;
    }
    let lt, dt;
    if (type === 1) [lt, dt] = fixedTrees();
    else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
      const ct = buildTree(cl);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const sym = decode(ct);
        if (sym < 16) lens[i++] = sym;
        else {
          let rep, val = 0;
          if (sym === 16) { val = lens[i - 1]; rep = 3 + bits(2); } else if (sym === 17) rep = 3 + bits(3); else rep = 11 + bits(7);
          while (rep--) lens[i++] = val;
        }
      }
      lt = buildTree(lens.subarray(0, hlit));
      dt = buildTree(lens.subarray(hlit));
    } else throw new Error('inflate: bad block type');
    for (;;) {
      const sym = decode(lt);
      if (sym < 256) { ensure(1); out[op++] = sym; } else if (sym === 256) break;
      else {
        const li = sym - 257;
        const len = LBASE[li] + bits(LEXT[li]);
        const di = decode(dt);
        const dist = DBASE[di] + bits(DEXT[di]);
        ensure(len);
        for (let k = 0; k < len; k++, op++) out[op] = out[op - dist];
      }
    }
  }
  return out.subarray(0, op);
}

/** gzip member -> Uint8Array. */
export function gunzip(buf) {
  const s = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (s[0] !== 0x1f || s[1] !== 0x8b || s[2] !== 8) throw new Error('not gzip');
  const flg = s[3];
  let p = 10;
  if (flg & 4) p += 2 + (s[p] | (s[p + 1] << 8));
  if (flg & 8) { while (s[p++]); }
  if (flg & 16) { while (s[p++]); }
  if (flg & 2) p += 2;
  const n = s.length;
  const isize = (s[n - 4] | (s[n - 3] << 8) | (s[n - 2] << 16) | (s[n - 1] << 24)) >>> 0;
  return inflateRaw(s.subarray(p, n - 8), isize);
}
