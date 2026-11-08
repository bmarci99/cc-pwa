// Emulation of CPython 3.12's `set` of small non-negative ints (squares 0..63), so that iterating a set gives the
// SAME order as the Python coach. Python iterates a set in hash-table slot order, not insertion order
// (e.g. list({10, 3}) == [10, 3]); several coach texts list pieces straight from a set.
//
// Mirrors Objects/setobject.c: set_add_entry (linear probes + perturbation), resize policy
// (fill*5 >= mask*3 -> resize(used>50000 ? used*2 : used*4)), set_insert_clean, dummies on discard, and
// set_difference (copy-and-discard when len(a) >> 2 > len(b), otherwise rebuild).

const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5;
const DUMMY = -1;
const EMPTY = undefined;
const MINSIZE = 8;

export class PySet {
  constructor(items = []) {
    this.table = new Array(MINSIZE).fill(EMPTY);
    this.mask = MINSIZE - 1;
    this.fill = 0;
    this.used = 0;
    for (const x of items) this.add(x);
  }

  static _insertClean(table, mask, key) {
    let perturb = key;
    let i = key & mask;
    for (;;) {
      if (table[i] === EMPTY) { table[i] = key; return; }
      if (i + LINEAR_PROBES <= mask) {
        for (let j = 0; j < LINEAR_PROBES; j++) {
          i++;
          if (table[i] === EMPTY) { table[i] = key; return; }
        }
      }
      perturb >>>= PERTURB_SHIFT;
      i = (i * 5 + 1 + perturb) & mask;
    }
  }

  _resize(minused) {
    let newsize = MINSIZE;
    while (newsize <= minused) newsize <<= 1;
    const old = this.table;
    this.table = new Array(newsize).fill(EMPTY);
    this.mask = newsize - 1;
    this.fill = this.used;
    for (const k of old) if (k !== EMPTY && k !== DUMMY) PySet._insertClean(this.table, this.mask, k);
  }

  add(key) {
    let mask = this.mask;
    let i = key & mask;
    let perturb = key;
    let freeslot = -1;
    for (;;) {
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      let idx = i;
      do {
        const e = this.table[idx];
        if (e === EMPTY) {
          if (freeslot >= 0) { this.table[freeslot] = key; this.used++; return this; }
          this.table[idx] = key;
          this.fill++; this.used++;
          if (this.fill * 5 < mask * 3) return this;
          this._resize(this.used > 50000 ? this.used * 2 : this.used * 4);
          return this;
        }
        if (e === key) return this;
        if (e === DUMMY && freeslot < 0) freeslot = idx;
        idx++;
      } while (probes--);
      perturb >>>= PERTURB_SHIFT;
      i = (i * 5 + 1 + perturb) & mask;
    }
  }

  has(key) {
    const mask = this.mask;
    let i = key & mask;
    let perturb = key;
    for (;;) {
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      let idx = i;
      do {
        const e = this.table[idx];
        if (e === EMPTY) return false;
        if (e === key) return true;
        idx++;
      } while (probes--);
      perturb >>>= PERTURB_SHIFT;
      i = (i * 5 + 1 + perturb) & mask;
    }
  }

  discard(key) {
    const mask = this.mask;
    let i = key & mask;
    let perturb = key;
    for (;;) {
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      let idx = i;
      do {
        const e = this.table[idx];
        if (e === EMPTY) return;
        if (e === key) { this.table[idx] = DUMMY; this.used--; return; }
        idx++;
      } while (probes--);
      perturb >>>= PERTURB_SHIFT;
      i = (i * 5 + 1 + perturb) & mask;
    }
  }

  get size() { return this.used; }

  *[Symbol.iterator]() {
    for (const k of this.table) if (k !== EMPTY && k !== DUMMY) yield k;
  }

  toArray() { return [...this]; }

  _copy() {
    // set_merge into an empty set: same-size tables without dummies are copied slot by slot
    const out = new PySet();
    if (this.used === 0) return out;
    if ((out.fill + this.used) * 5 >= out.mask * 3) out._resize((out.used + this.used) * 2);
    if (this.fill === this.used && this.mask === out.mask) {
      out.table = this.table.slice();
      out.fill = this.fill; out.used = this.used;
      return out;
    }
    for (const k of this) PySet._insertClean(out.table, out.mask, k);
    out.fill = out.used = this.used;
    return out;
  }

  difference(other) {
    const o = other instanceof PySet ? other : new PySet(other);
    if ((this.used >> 2) > o.used) {
      const out = this._copy();
      for (const k of o) out.discard(k);
      return out;
    }
    const out = new PySet();
    for (const k of this) if (!o.has(k)) out.add(k);
    return out;
  }
}
