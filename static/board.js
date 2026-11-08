// Chess Coach board component + tiny FEN / SAN helpers. No chess engine logic here:
// move legality always comes from the backend (`legal` list of UCI moves).

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const FILES = 'abcdefgh';

export const CLASS_INFO = {
  brilliant: { sym: '!!', color: '#1baca6', label: 'Brilliant' },
  great: { sym: '!', color: '#5c8bb0', label: 'Great' },
  best: { sym: '★', color: '#96bc4b', label: 'Best' },
  good: { sym: '✓', color: '#8ba26b', label: 'Good' },
  inaccuracy: { sym: '?!', color: '#f7c631', label: 'Inaccuracy' },
  mistake: { sym: '?', color: '#e58f2a', label: 'Mistake' },
  blunder: { sym: '??', color: '#ca3431', label: 'Blunder' },
};

// ------------------------------------------------------------------ squares / FEN

export const sqName = (i) => FILES[i & 7] + ((i >> 3) + 1);
export const sqIndex = (n) => FILES.indexOf(n[0]) + (parseInt(n[1], 10) - 1) * 8;

export function parseFen(fen) {
  if (!fen || fen === 'startpos') fen = START_FEN;
  const [placement, turn = 'w', castling = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/);
  const board = new Array(64).fill(null);
  const rows = placement.split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r] || '') {
      if (/\d/.test(ch)) f += +ch;
      else {
        board[(7 - r) * 8 + f] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
        f++;
      }
    }
  }
  return { board, turn, castling, ep, half: +half || 0, full: +full || 1 };
}

export function toFen(pos) {
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '', empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.board[r * 8 + f];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += p[0] === 'w' ? p[1] : p[1].toLowerCase();
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${pos.turn} ${pos.castling || '-'} ${pos.ep || '-'} ${pos.half} ${pos.full}`;
}

/** Apply a (legal) UCI move locally. Used for previews / animations only. */
export function applyUci(posOrFen, uci) {
  const src = typeof posOrFen === 'string' ? parseFen(posOrFen) : posOrFen;
  const pos = { ...src, board: src.board.slice() };
  const from = sqIndex(uci.slice(0, 2)), to = sqIndex(uci.slice(2, 4));
  const p = pos.board[from];
  if (!p) return pos;
  const color = p[0], type = p[1];
  const captured = pos.board[to];
  pos.board[from] = null;
  // en passant
  if (type === 'P' && (from & 7) !== (to & 7) && !captured) {
    pos.board[(from & 56) + (to & 7)] = null;
  }
  // castling: move the rook too
  if (type === 'K' && Math.abs((from & 7) - (to & 7)) === 2) {
    const rank = from & 56;
    if ((to & 7) === 6) { pos.board[rank + 5] = pos.board[rank + 7]; pos.board[rank + 7] = null; }
    else { pos.board[rank + 3] = pos.board[rank]; pos.board[rank] = null; }
  }
  let placed = p;
  if (type === 'P' && ((to >> 3) === 7 || (to >> 3) === 0)) placed = color + (uci[4] || 'q').toUpperCase();
  pos.board[to] = placed;
  // castling rights
  let c = pos.castling === '-' ? '' : pos.castling;
  const strip = (chars) => { for (const ch of chars) c = c.replace(ch, ''); };
  if (type === 'K') strip(color === 'w' ? 'KQ' : 'kq');
  for (const s of [from, to]) {
    if (s === 0) strip('Q'); if (s === 7) strip('K'); if (s === 56) strip('q'); if (s === 63) strip('k');
  }
  pos.castling = c || '-';
  pos.ep = type === 'P' && Math.abs(to - from) === 16 ? sqName((from + to) / 2) : '-';
  pos.half = type === 'P' || captured ? 0 : pos.half + 1;
  if (color === 'b') pos.full += 1;
  pos.turn = color === 'w' ? 'b' : 'w';
  return pos;
}

// ------------------------------------------------------------------ SAN <-> UCI (using the backend's legal list)

/** SAN for `uci` in position `fen` (no +/# suffix). `legal` is needed for disambiguation. */
export function sanFor(fenOrPos, uci, legal = []) {
  const pos = typeof fenOrPos === 'string' ? parseFen(fenOrPos) : fenOrPos;
  const from = sqIndex(uci.slice(0, 2)), to = sqIndex(uci.slice(2, 4));
  const p = pos.board[from];
  if (!p) return null;
  const type = p[1];
  if (type === 'K' && Math.abs((from & 7) - (to & 7)) === 2 && (from >> 3) === (to >> 3)) {
    return (to & 7) === 6 ? 'O-O' : 'O-O-O';
  }
  const target = pos.board[to];
  const isEp = type === 'P' && (from & 7) !== (to & 7) && !target;
  const capture = !!target || isEp;
  if (type === 'P') {
    let s = capture ? FILES[from & 7] + 'x' + sqName(to) : sqName(to);
    if ((to >> 3) === 7 || (to >> 3) === 0) s += '=' + (uci[4] || 'q').toUpperCase();
    return s;
  }
  let s = type;
  const dest = uci.slice(2, 4), origin = uci.slice(0, 2);
  const rivals = new Set(
    legal.filter((m) => m.slice(2, 4) === dest && m.slice(0, 2) !== origin && pos.board[sqIndex(m.slice(0, 2))] === p)
      .map((m) => sqIndex(m.slice(0, 2))),
  );
  if (rivals.size) {
    const ff = from & 7, fr = from >> 3;
    const sameFile = [...rivals].some((r) => (r & 7) === ff);
    const sameRank = [...rivals].some((r) => (r >> 3) === fr);
    if (!sameFile) s += FILES[ff];
    else if (!sameRank) s += fr + 1;
    else s += FILES[ff] + (fr + 1);
  }
  if (capture) s += 'x';
  return s + dest;
}

export const normSan = (s) => String(s || '').replace(/[+#!?]/g, '').replace(/0/g, 'O').replace(/e\.?p\.?$/, '').trim();

/** Map SAN to a UCI move from the legal list (null if none matches). */
export function uciForSan(fenOrPos, san, legal = []) {
  const pos = typeof fenOrPos === 'string' ? parseFen(fenOrPos) : fenOrPos;
  const want = normSan(san);
  for (const m of legal) if (normSan(sanFor(pos, m, legal)) === want) return m;
  // tolerate a missing "=Q"
  for (const m of legal) if (m.length === 5 && m[4] === 'q' && normSan(sanFor(pos, m, legal)) === want + '=Q') return m;
  return null;
}

/** First SAN move of an engine line like "12...Nxe5 13. Qd4" -> "Nxe5". */
export function firstSan(line) {
  if (!line) return null;
  for (const tok of line.trim().split(/\s+/)) {
    const t = tok.replace(/^\d+\.(\.\.)?/, '');
    if (t) return t;
  }
  return null;
}

// ------------------------------------------------------------------ PGN + material helpers

/** Parse PGN text: headers, SAN move list (comments, variations, NAGs stripped) and result. */
export function parsePgn(text) {
  const headers = {};
  let t = String(text || '').replace(/\r/g, '');
  t = t.replace(/^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm, (_, k, v) => { headers[k] = v.replace(/\\(.)/g, '$1'); return ''; });
  t = t.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  let prev;
  do { prev = t; t = t.replace(/\([^()]*\)/g, ' '); } while (t !== prev);
  t = t.replace(/\$\d+/g, ' ');
  const sans = [];
  let result = null;
  for (let tok of t.split(/\s+/)) {
    if (!tok) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) { result = tok; continue; }
    tok = tok.replace(/^\d+\.+/, '');
    if (!tok || /^\.+$/.test(tok)) continue;
    sans.push(tok);
  }
  return { headers, sans, result };
}

/** Build PGN text from SAN moves (with +/# already attached). */
export function buildPgn({ startFen = 'startpos', sans = [], headers = {}, result = '*' }) {
  const start = parseFen(startFen);
  const custom = startFen && startFen !== 'startpos' && toFen(start) !== START_FEN;
  const h = { Event: 'Chess Coach', Site: 'Chess Coach', Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'), White: '?', Black: '?', Result: result, ...headers };
  if (custom) { h.SetUp = '1'; h.FEN = toFen(start); }
  let out = Object.entries(h).map(([k, v]) => `[${k} "${String(v).replace(/"/g, '\\"')}"]`).join('\n') + '\n\n';
  let n = start.full, white = start.turn === 'w';
  const parts = [];
  sans.forEach((san, i) => {
    if (white) parts.push(`${n}. ${san}`);
    else parts.push(i === 0 ? `${n}... ${san}` : san);
    if (!white) n++;
    white = !white;
  });
  parts.push(result);
  // wrap at ~80 chars
  let line = '';
  for (const p of parts) {
    if ((line + ' ' + p).trim().length > 80) { out += line.trim() + '\n'; line = ''; }
    line += ' ' + p;
  }
  return out + line.trim() + '\n';
}

export const PIECE_VALUE = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
const FULL_SET = { P: 8, N: 2, B: 2, R: 2, Q: 1 };

/** Captured pieces per side (what each colour has taken) and material balance (white minus black). */
export function materialInfo(fenOrPos) {
  const pos = typeof fenOrPos === 'string' ? parseFen(fenOrPos) : fenOrPos;
  const count = { w: {}, b: {} };
  let diff = 0;
  for (const p of pos.board) {
    if (!p) continue;
    count[p[0]][p[1]] = (count[p[0]][p[1]] || 0) + 1;
    diff += (p[0] === 'w' ? 1 : -1) * PIECE_VALUE[p[1]];
  }
  const taken = (victim) => {
    const out = [];
    for (const t of ['Q', 'R', 'B', 'N', 'P']) for (let i = 0; i < FULL_SET[t] - (count[victim][t] || 0); i++) out.push(t);
    return out;
  };
  return { white: taken('b'), black: taken('w'), diff };
}

/** True when `color` ('white'|'black') cannot possibly mate (lone king, or king + one minor). */
export function insufficientToMate(fenOrPos, color) {
  const pos = typeof fenOrPos === 'string' ? parseFen(fenOrPos) : fenOrPos;
  const c = color[0];
  const mine = pos.board.filter((p) => p && p[0] === c && p[1] !== 'K').map((p) => p[1]);
  return mine.length === 0 || (mine.length === 1 && (mine[0] === 'N' || mine[0] === 'B'));
}

// ------------------------------------------------------------------ eval formatting

export function evalText(cp) {
  if (cp == null) return '–';
  if (Math.abs(cp) >= 9500) {
    const n = Math.max(1, Math.floor((10000 - Math.abs(cp) + 1) / 2));
    return (cp > 0 ? '' : '-') + (Math.abs(cp) >= 10000 ? '#' : 'M' + n);
  }
  const v = cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(1);
}

/** White share of the eval bar, 0..1 */
export function evalShare(cp) {
  if (cp == null) return 0.5;
  if (Math.abs(cp) >= 9500) return cp > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-0.0042 * cp));
}

export class EvalBar {
  constructor(el) {
    this.el = el;
    el.classList.add('evalbar');
    el.innerHTML = '<div class="eb-fill"></div><span class="eb-label"></span>';
    this.fill = el.firstChild;
    this.label = el.lastChild;
    this.orientation = 'white';
    this.set(null);
  }
  setOrientation(o) { this.orientation = o; this.set(this.cp); }
  set(cpWhite) {
    this.cp = cpWhite;
    const share = evalShare(cpWhite);
    this.el.classList.toggle('flipped', this.orientation === 'black');
    this.fill.style.height = (share * 100).toFixed(1) + '%';
    const txt = cpWhite == null ? '' : evalText(Math.abs(cpWhite)).replace('+', '');
    this.label.textContent = txt;
    const whiteAhead = cpWhite == null || cpWhite >= 0;
    this.label.className = 'eb-label ' + (whiteAhead ? 'on-white' : 'on-black');
    // label sits at the end of whoever is ahead
    const atBottom = (whiteAhead && this.orientation === 'white') || (!whiteAhead && this.orientation === 'black');
    this.label.classList.toggle('bottom', atBottom);
    this.el.title = cpWhite == null ? '' : 'Eval (White POV): ' + evalText(cpWhite);
  }
}

// ------------------------------------------------------------------ board component

const ARROW_COLORS = {
  green: 'rgba(129, 182, 76, 0.85)',
  red: 'rgba(212, 64, 58, 0.82)',
  blue: 'rgba(72, 140, 214, 0.82)',
  yellow: 'rgba(240, 190, 40, 0.85)',
};

/** Kind of sound for a move: 'capture' or 'move' (check is decided by the caller). */
export function moveKind(pos, uci) {
  const from = sqIndex(uci.slice(0, 2)), to = sqIndex(uci.slice(2, 4));
  const p = pos.board[from];
  if (pos.board[to] || (p && p[1] === 'P' && (from & 7) !== (to & 7))) return 'capture';
  if (p && p[1] === 'K' && Math.abs((from & 7) - (to & 7)) === 2) return 'castle';
  return 'move';
}

export class ChessBoard {
  /** Optional global sound hook: (kind: 'move'|'capture'|'castle'|'check') => void */
  static sound = null;

  /**
   * @param {HTMLElement} el
   * @param {{orientation?: 'white'|'black', onMove?: (uci:string)=>void, movable?: 'white'|'black'|'both'|'none'}} opts
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.orientation = opts.orientation || 'white';
    this.onMove = opts.onMove || null;
    this.movable = opts.movable || 'none';
    this.promotion = opts.promotion || 'ask'; // 'ask' shows a Q/R/B/N picker, 'auto' queens
    this.pos = parseFen(START_FEN);
    this.legal = [];
    this.lastMove = null;
    this.check = false;
    this.arrows = [];
    this.badge = null;
    this.selected = null;
    this.drag = null;
    el.classList.add('cb');
    el.__board = this; // handy for debugging from the console
    this.overlay = { arrows: [], squares: [], color: null };
    el.innerHTML = '<div class="cb-squares"></div><div class="cb-marks"></div><div class="cb-pieces"></div>' +
      '<svg class="cb-arrows" viewBox="0 0 800 800" preserveAspectRatio="none"></svg><div class="cb-badges"></div>';
    this.sqLayer = el.children[0];
    this.mkLayer = el.children[1];
    this.pcLayer = el.children[2];
    this.arLayer = el.children[3];
    this.bdLayer = el.children[4];
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._moveEv(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', () => this._cancelDrag());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.render();
  }

  // ---- public API
  setPosition(fen, { legal = [], lastMove = null, check = false, movable, animate = false, sound = animate } = {}) {
    this._closePromo();
    const prev = this.pos;
    if (sound && lastMove && ChessBoard.sound) ChessBoard.sound(check ? 'check' : moveKind(prev, lastMove));
    this.pos = parseFen(fen);
    this.legal = legal || [];
    this.lastMove = lastMove;
    this.check = check;
    if (movable !== undefined) this.movable = movable;
    this.selected = null;
    this.badge = null;
    this.arrows = [];
    this.overlay = { arrows: [], squares: [], color: null };
    this.render();
    if (animate && lastMove) this._animate(lastMove);
  }
  /** Show a move immediately (before the backend answers). Board becomes non-interactive. */
  previewMove(uci, { sound = true } = {}) {
    this._closePromo();
    if (sound && ChessBoard.sound) ChessBoard.sound(moveKind(this.pos, uci));
    this.pos = applyUci(this.pos, uci);
    this.legal = [];
    this.lastMove = uci;
    this.check = false;
    this.selected = null;
    this.arrows = [];
    this.badge = null;
    this.overlay = { arrows: [], squares: [], color: null };
    this.render();
  }
  get fen() { return toFen(this.pos); }
  setOrientation(o) { this.orientation = o; this.render(); }
  flip() { this.setOrientation(this.orientation === 'white' ? 'black' : 'white'); }
  setMovable(m) { this.movable = m; this.selected = null; this.render(); }
  /** arrows: [{uci:'e2e4', color:'green'}] or [{from, to, color}] */
  setArrows(list = []) {
    this.arrows = list.filter(Boolean).map((a) => (a.uci ? { from: a.uci.slice(0, 2), to: a.uci.slice(2, 4), color: a.color } : a));
    this._renderArrows();
  }
  /** Temporary highlight layer (squares + arrows) drawn on top of the regular arrows. */
  setOverlay({ arrows = [], squares = [], color = null } = {}) {
    this.overlay = { arrows: arrows.map((a) => (Array.isArray(a) ? { from: a[0], to: a[1], color } : a)), squares, color };
    this._renderArrows();
    this._renderMarks();
  }
  clearOverlay() { this.setOverlay(); }
  _renderMarks() {
    const { squares, color } = this.overlay;
    this.mkLayer.innerHTML = squares.map((m) => {
      const name = typeof m === 'string' ? m : m.sq;
      const cls = typeof m === 'string' ? '' : m.cls || '';
      const [col, row] = this._xy(sqIndex(name));
      return `<div class="cb-mark ${cls}" style="left:${col * 12.5}%;top:${row * 12.5}%;--mk:${color || 'rgba(240,190,40,.55)'}"></div>`;
    }).join('');
  }
  setBadge(square, cls) { this.badge = square && cls && CLASS_INFO[cls] ? { square, cls } : null; this._renderBadge(); }
  clearDecorations() { this.arrows = []; this.badge = null; this._renderArrows(); this._renderBadge(); }

  // ---- geometry
  _xy(sq) { // display column/row for square index
    const f = sq & 7, r = sq >> 3;
    return this.orientation === 'white' ? [f, 7 - r] : [7 - f, r];
  }
  _sqAt(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const col = Math.floor(((clientX - rect.left) / rect.width) * 8);
    const row = Math.floor(((clientY - rect.top) / rect.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return this.orientation === 'white' ? (7 - row) * 8 + col : row * 8 + (7 - col);
  }
  _canMovePiece(p) {
    if (!p || !this.legal.length) return false;
    const c = p[0] === 'w' ? 'white' : 'black';
    const turn = this.pos.turn === 'w' ? 'white' : 'black';
    return c === turn && (this.movable === 'both' || this.movable === c);
  }
  _targets(from) {
    const n = sqName(from);
    return this.legal.filter((m) => m.startsWith(n)).map((m) => sqIndex(m.slice(2, 4)));
  }

  // ---- rendering
  render() {
    const lm = this.lastMove ? [this.lastMove.slice(0, 2), this.lastMove.slice(2, 4)] : [];
    const targets = this.selected != null ? new Set(this._targets(this.selected)) : new Set();
    let kingSq = null;
    if (this.check) {
      const k = (this.pos.turn === 'w' ? 'w' : 'b') + 'K';
      kingSq = this.pos.board.indexOf(k);
    }
    let sqHtml = '';
    let pcHtml = '';
    for (let sq = 0; sq < 64; sq++) {
      const [col, row] = this._xy(sq);
      const light = ((sq & 7) + (sq >> 3)) % 2 === 1;
      const name = sqName(sq);
      const cls = ['cb-sq', light ? 'light' : 'dark'];
      if (lm.includes(name)) cls.push('last');
      if (sq === this.selected) cls.push('sel');
      if (sq === kingSq) cls.push('check');
      if (targets.has(sq)) cls.push(this.pos.board[sq] || (this.pos.board[this.selected]?.[1] === 'P' && (sq & 7) !== (this.selected & 7)) ? 'target cap' : 'target');
      let coords = '';
      if (col === 0) coords += `<span class="co rk">${(sq >> 3) + 1}</span>`;
      if (row === 7) coords += `<span class="co fl">${FILES[sq & 7]}</span>`;
      sqHtml += `<div class="${cls.join(' ')}" style="left:${col * 12.5}%;top:${row * 12.5}%">${coords}</div>`;
      const p = this.pos.board[sq];
      if (p) {
        const movable = this._canMovePiece(p) ? ' movable' : '';
        pcHtml += `<img class="cb-pc${movable}" data-sq="${sq}" src="pieces/${p}.svg" alt="${p}" draggable="false" style="left:${col * 12.5}%;top:${row * 12.5}%">`;
      }
    }
    this.sqLayer.innerHTML = sqHtml;
    this.pcLayer.innerHTML = pcHtml;
    this.el.classList.toggle('interactive', this.legal.length > 0 && this.movable !== 'none');
    this._renderArrows();
    this._renderMarks();
    this._renderBadge();
  }

  _center(name) {
    const [col, row] = this._xy(sqIndex(name));
    return [col * 100 + 50, row * 100 + 50];
  }
  _renderArrows() {
    let out = '';
    for (const a of [...this.arrows, ...(this.overlay?.arrows || [])]) {
      if (!a.from || !a.to || a.from === a.to) continue;
      const [x1, y1] = this._center(a.from);
      const [x2, y2] = this._center(a.to);
      const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
      const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
      const w = 9, hw = 22, hl = 34, start = 22;
      const sx = x1 + ux * start, sy = y1 + uy * start;
      const bx = x2 - ux * hl, by = y2 - uy * hl;
      const pts = [
        [sx + nx * w, sy + ny * w], [bx + nx * w, by + ny * w], [bx + nx * hw, by + ny * hw], [x2, y2],
        [bx - nx * hw, by - ny * hw], [bx - nx * w, by - ny * w], [sx - nx * w, sy - ny * w],
      ];
      out += `<polygon points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" fill="${ARROW_COLORS[a.color] || a.color || ARROW_COLORS.green}"/>`;
    }
    this.arLayer.innerHTML = out;
  }
  _renderBadge() {
    if (!this.badge) { this.bdLayer.innerHTML = ''; return; }
    const info = CLASS_INFO[this.badge.cls];
    const [col, row] = this._xy(sqIndex(this.badge.square));
    this.bdLayer.innerHTML = `<div class="cb-badge" title="${info.label}" style="left:${(col + 1) * 12.5}%;top:${row * 12.5}%;background:${info.color}">${info.sym}</div>`;
  }
  _animate(uci) {
    const from = sqIndex(uci.slice(0, 2)), to = sqIndex(uci.slice(2, 4));
    const img = this.pcLayer.querySelector(`img[data-sq="${to}"]`);
    if (!img) return;
    const [fc, fr] = this._xy(from), [tc, tr] = this._xy(to);
    img.style.transition = 'none';
    img.style.transform = `translate(${(fc - tc) * 100}%, ${(fr - tr) * 100}%)`;
    img.getBoundingClientRect();
    requestAnimationFrame(() => {
      img.style.transition = 'transform 260ms ease';
      img.style.transform = '';
    });
  }

  // ---- interaction (pointer events: mouse + touch + pen)
  _select(sq) { this.selected = sq; this.render(); }
  _tryMove(from, to) {
    const prefix = sqName(from) + sqName(to);
    const cands = this.legal.filter((m) => m.startsWith(prefix));
    if (!cands.length) return false;
    if (cands.length > 1 && this.promotion === 'ask') { this._askPromotion(from, to); return true; }
    const uci = cands.find((m) => m.length === 4) || cands.find((m) => m[4] === 'q') || cands[0]; // auto-queen
    this.previewMove(uci);
    if (this.onMove) this.onMove(uci);
    return true;
  }
  _askPromotion(from, to) {
    const color = this.pos.board[from][0];
    this.selected = null;
    this.render();
    const [col, row] = this._xy(to);
    const dir = row === 0 ? 1 : -1;
    const wrap = document.createElement('div');
    wrap.className = 'cb-promo';
    wrap.innerHTML = ['q', 'n', 'r', 'b'].map((p, i) =>
      `<button type="button" data-p="${p}" aria-label="Promote to ${p}" style="left:${col * 12.5}%;top:${(row + dir * i) * 12.5}%"><img src="pieces/${color}${p.toUpperCase()}.svg" alt="" draggable="false"></button>`).join('');
    wrap.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const b = e.target.closest('button');
      this._closePromo();
      if (!b) { this.render(); return; }
      const uci = sqName(from) + sqName(to) + b.dataset.p;
      this.previewMove(uci);
      if (this.onMove) this.onMove(uci);
    });
    this.el.appendChild(wrap);
    this.promoEl = wrap;
  }
  _closePromo() { if (this.promoEl) { this.promoEl.remove(); this.promoEl = null; } }
  _down(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const sq = this._sqAt(e.clientX, e.clientY);
    if (sq == null) return;
    if (this.selected != null && sq !== this.selected && this._targets(this.selected).includes(sq)) {
      e.preventDefault();
      this._tryMove(this.selected, sq);
      return;
    }
    const p = this.pos.board[sq];
    if (!this._canMovePiece(p)) {
      if (this.selected != null) this._select(null);
      return;
    }
    e.preventDefault();
    const wasSelected = this.selected === sq;
    if (!wasSelected) this._select(sq);
    const img = this.pcLayer.querySelector(`img[data-sq="${sq}"]`);
    this.drag = { from: sq, x: e.clientX, y: e.clientY, moved: false, img, wasSelected, ghost: null };
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  _moveEv(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    if (!d.moved) {
      d.moved = true;
      const size = this.el.getBoundingClientRect().width / 8;
      const g = document.createElement('img');
      g.src = d.img.src;
      g.className = 'cb-ghost';
      g.style.width = g.style.height = size + 'px';
      document.body.appendChild(g);
      d.ghost = g;
      d.size = size;
      d.img.classList.add('dragging');
    }
    d.ghost.style.transform = `translate(${e.clientX - d.size / 2}px, ${e.clientY - d.size / 2}px)`;
    const over = this._sqAt(e.clientX, e.clientY);
    this.sqLayer.querySelectorAll('.hover').forEach((n) => n.classList.remove('hover'));
    if (over != null && this._targets(d.from).includes(over)) {
      const [c, r] = this._xy(over);
      const idx = [...this.sqLayer.children].find((n) => n.style.left === `${c * 12.5}%` && n.style.top === `${r * 12.5}%`);
      idx?.classList.add('hover');
    }
  }
  _up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.ghost) d.ghost.remove();
    if (d.moved) {
      const sq = this._sqAt(e.clientX, e.clientY);
      if (sq != null && sq !== d.from && this._tryMove(d.from, sq)) return;
      d.img?.classList.remove('dragging');
      this.sqLayer.querySelectorAll('.hover').forEach((n) => n.classList.remove('hover'));
      if (sq !== d.from) this._select(null);
      return;
    }
    if (d.wasSelected) this._select(null); // second click on the same piece deselects
  }
  _cancelDrag() {
    if (this.drag?.ghost) this.drag.ghost.remove();
    this.drag?.img?.classList.remove('dragging');
    this.drag = null;
  }
}
