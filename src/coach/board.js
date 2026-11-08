// A small python-chess-like Board on top of chess.js.
//
// * Squares are python-chess indices (a1 = 0, h1 = 7, a8 = 56, h8 = 63); colours are booleans (true = WHITE).
// * Piece geometry (attacks / attackers / pins / between) is implemented here and mirrors python-chess exactly
//   (x-ray free sliding attacks, attackers include pinned pieces, attack maps independent of whose turn it is).
// * chess.js provides legal move generation and SAN. Legal moves are re-ordered into python-chess's generation
//   order, because the coach often takes "the first candidate".
// * Board state (FEN, castling, ep, clocks, move stack, repetition) follows python-chess semantics.
import { Chess } from '../../vendor/chess.js/chess.js';

export const WHITE = true;
export const BLACK = false;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const PIECE_TYPES = [PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING];
export const FILE_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
export const SQUARES = Array.from({ length: 64 }, (_, i) => i);
export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const SYMBOLS = { 1: 'p', 2: 'n', 3: 'b', 4: 'r', 5: 'q', 6: 'k' };
const TYPE_OF = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

export const squareFile = (s) => s & 7;
export const squareRank = (s) => s >> 3;
export const square = (f, r) => r * 8 + f;
export const squareName = (s) => FILE_NAMES[s & 7] + String((s >> 3) + 1);
export const parseSquare = (n) => (n.charCodeAt(0) - 97) + 8 * (n.charCodeAt(1) - 49);
export const pieceSymbol = (type) => SYMBOLS[type];

// ------------------------------------------------------------------ attack tables
const KNIGHT_ATT = [], KING_ATT = [], PAWN_ATT = { true: [], false: [] };
function stepTable(deltas) {
  const out = [];
  for (let s = 0; s < 64; s++) {
    const f = s & 7, r = s >> 3, list = [];
    for (const [df, dr] of deltas) {
      const ff = f + df, rr = r + dr;
      if (ff >= 0 && ff < 8 && rr >= 0 && rr < 8) list.push(rr * 8 + ff);
    }
    out.push(list.sort((a, b) => a - b));
  }
  return out;
}
KNIGHT_ATT.push(...stepTable([[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]));
KING_ATT.push(...stepTable([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]));
PAWN_ATT.true.push(...stepTable([[1, 1], [-1, 1]]));
PAWN_ATT.false.push(...stepTable([[1, -1], [-1, -1]]));
export const BB_KNIGHT_ATTACKS = KNIGHT_ATT;
export const BB_KING_ATTACKS = KING_ATT;
export const BB_PAWN_ATTACKS = PAWN_ATT;
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Squares strictly between a and b if they share a line (python-chess SquareSet.between), ascending. */
export function between(a, b) {
  const fa = a & 7, ra = a >> 3, fb = b & 7, rb = b >> 3;
  const df = Math.sign(fb - fa), dr = Math.sign(rb - ra);
  if (a === b) return [];
  if (!(fa === fb || ra === rb || Math.abs(fb - fa) === Math.abs(rb - ra))) return [];
  const out = [];
  let f = fa + df, r = ra + dr;
  while (f !== fb || r !== rb) { out.push(r * 8 + f); f += df; r += dr; }
  return out.sort((x, y) => x - y);
}

// ------------------------------------------------------------------ moves
export function moveFromUci(uci) {
  if (!uci || uci === '0000') return null;
  const promo = uci.length > 4 ? TYPE_OF[uci[4]] : 0;
  return { from: parseSquare(uci.slice(0, 2)), to: parseSquare(uci.slice(2, 4)), promotion: promo };
}
export function moveUci(m) {
  return squareName(m.from) + squareName(m.to) + (m.promotion ? SYMBOLS[m.promotion] : '');
}
export const sameMove = (a, b) => !!a && !!b && a.from === b.from && a.to === b.to && (a.promotion || 0) === (b.promotion || 0);
export const Move = (from, to, promotion = 0) => ({ from, to, promotion });

// ------------------------------------------------------------------ Board
export class Board {
  constructor(fen = STARTING_FEN) {
    this.pt = new Array(64).fill(0);   // piece type or 0
    this.pc = new Array(64).fill(false); // colour (true = white) where pt != 0
    this.turn = WHITE;
    this.castling = 0;     // bitmask of rook squares: bit0 a1, bit1 h1, bit2 a8, bit3 h8 (raw rights like python-chess)
    this.epSquare = null;
    this.halfmoveClock = 0;
    this.fullmoveNumber = 1;
    this.moveStack = [];   // moves (python move_stack)
    this._states = [];     // snapshots of the position before each move
    this._legal = null;    // cache
    if (fen !== null) this.setFen(fen === 'startpos' ? STARTING_FEN : fen);
  }

  setFen(fen) {
    const parts = fen.trim().split(/\s+/);
    const rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error(`invalid fen: ${fen}`);
    this.pt.fill(0); this.pc.fill(false);
    for (let i = 0; i < 8; i++) {
      const r = 7 - i;
      let f = 0;
      for (const ch of rows[i]) {
        if (ch >= '1' && ch <= '8') { f += Number(ch); continue; }
        const t = TYPE_OF[ch.toLowerCase()];
        if (!t || f > 7) throw new Error(`invalid fen: ${fen}`);
        this.pt[r * 8 + f] = t;
        this.pc[r * 8 + f] = ch === ch.toUpperCase();
        f++;
      }
    }
    this.turn = (parts[1] || 'w') === 'w';
    const c = parts[2] || '-';
    this.castling = 0;
    if (c.includes('Q')) this.castling |= 1;
    if (c.includes('K')) this.castling |= 2;
    if (c.includes('q')) this.castling |= 4;
    if (c.includes('k')) this.castling |= 8;
    this.epSquare = parts[3] && parts[3] !== '-' ? parseSquare(parts[3]) : null;
    this.halfmoveClock = parts[4] !== undefined ? parseInt(parts[4], 10) : 0;
    this.fullmoveNumber = parts[5] !== undefined ? Math.max(1, parseInt(parts[5], 10)) : 1;
    this.moveStack = []; this._states = []; this._legal = null;
  }

  copy(stack = true) {
    const b = new Board(null);
    b.pt = this.pt.slice(); b.pc = this.pc.slice();
    b.turn = this.turn; b.castling = this.castling; b.epSquare = this.epSquare;
    b.halfmoveClock = this.halfmoveClock; b.fullmoveNumber = this.fullmoveNumber;
    if (stack) { b.moveStack = this.moveStack.slice(); b._states = this._states.slice(); }
    b._legal = this._legal; // same position, same legal moves
    return b;
  }

  _snapshot() {
    return { pt: this.pt.slice(), pc: this.pc.slice(), turn: this.turn, castling: this.castling, ep: this.epSquare,
             half: this.halfmoveClock, full: this.fullmoveNumber };
  }
  _restore(st) {
    this.pt = st.pt.slice(); this.pc = st.pc.slice(); this.turn = st.turn; this.castling = st.castling;
    this.epSquare = st.ep; this.halfmoveClock = st.half; this.fullmoveNumber = st.full; this._legal = null;
  }

  /** python `b.turn = color` (invalidates the legal-move cache). */
  setTurn(color) {
    if (color !== this.turn) { this.turn = color; this._legal = null; }
    return this;
  }

  // ---------------------------------------------------------------- pieces
  pieceAt(s) { return this.pt[s] ? { type: this.pt[s], color: this.pc[s] } : null; }
  pieceTypeAt(s) { return this.pt[s] || null; }
  colorAt(s) { return this.pt[s] ? this.pc[s] : null; }
  hasPiece(s, type, color) { return this.pt[s] === type && this.pc[s] === color; }
  pieces(type, color) {
    const out = [];
    for (let s = 0; s < 64; s++) if (this.pt[s] === type && this.pc[s] === color) out.push(s);
    return out;
  }
  occupiedCo(color) {
    const out = [];
    for (let s = 0; s < 64; s++) if (this.pt[s] && this.pc[s] === color) out.push(s);
    return out;
  }
  king(color) {
    // python-chess: msb of the king mask
    for (let s = 63; s >= 0; s--) if (this.pt[s] === KING && this.pc[s] === color) return s;
    return null;
  }

  // ---------------------------------------------------------------- geometry (python-chess semantics)
  _ray(s, dirs, out) {
    const f0 = s & 7, r0 = s >> 3;
    for (const [df, dr] of dirs) {
      let f = f0 + df, r = r0 + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        const t = r * 8 + f;
        out.push(t);
        if (this.pt[t]) break;
        f += df; r += dr;
      }
    }
    return out;
  }
  /** Squares attacked by the piece on s (ascending), empty if no piece. */
  attacks(s) {
    const t = this.pt[s];
    if (!t) return [];
    if (t === PAWN) return PAWN_ATT[this.pc[s]][s].slice();
    if (t === KNIGHT) return KNIGHT_ATT[s].slice();
    if (t === KING) return KING_ATT[s].slice();
    const out = [];
    if (t === BISHOP || t === QUEEN) this._ray(s, BISHOP_DIRS, out);
    if (t === ROOK || t === QUEEN) this._ray(s, ROOK_DIRS, out);
    return out.sort((a, b) => a - b);
  }
  /** Pieces of `color` attacking square s (ascending). */
  attackers(color, s) {
    const out = [];
    for (const a of KNIGHT_ATT[s]) if (this.pt[a] === KNIGHT && this.pc[a] === color) out.push(a);
    for (const a of KING_ATT[s]) if (this.pt[a] === KING && this.pc[a] === color) out.push(a);
    for (const a of PAWN_ATT[!color][s]) if (this.pt[a] === PAWN && this.pc[a] === color) out.push(a);
    const f0 = s & 7, r0 = s >> 3;
    for (const [dirs, kinds] of [[ROOK_DIRS, [ROOK, QUEEN]], [BISHOP_DIRS, [BISHOP, QUEEN]]]) {
      for (const [df, dr] of dirs) {
        let f = f0 + df, r = r0 + dr;
        while (f >= 0 && f < 8 && r >= 0 && r < 8) {
          const t = r * 8 + f;
          if (this.pt[t]) {
            if (this.pc[t] === color && kinds.includes(this.pt[t])) out.push(t);
            break;
          }
          f += df; r += dr;
        }
      }
    }
    return out.sort((a, b) => a - b);
  }
  isAttackedBy(color, s) { return this.attackers(color, s).length > 0; }

  /** python-chess Board.is_pinned(color, square). */
  isPinned(color, s) {
    const k = this.king(color);
    if (k === null || k === s) return false;
    const fk = k & 7, rk = k >> 3, fs = s & 7, rs = s >> 3;
    let kinds, onLine;
    if (fk === fs) { kinds = [ROOK, QUEEN]; onLine = (t) => (t & 7) === fk; }
    else if (rk === rs) { kinds = [ROOK, QUEEN]; onLine = (t) => (t >> 3) === rk; }
    else if (Math.abs(fk - fs) === Math.abs(rk - rs)) {
      kinds = [BISHOP, QUEEN];
      // python uses both diagonals through the king (BB_DIAG_ATTACKS), but only the snipers on the square's line can pass
      onLine = (t) => Math.abs((t & 7) - fk) === Math.abs((t >> 3) - rk) && t !== k;
    } else return false;
    for (let t = 63; t >= 0; t--) {
      if (!this.pt[t] || this.pc[t] === color || !kinds.includes(this.pt[t]) || !onLine(t)) continue;
      const btw = between(t, k);
      if (!btw.includes(s)) continue;
      if (btw.every((x) => x === s || !this.pt[x])) return true;
    }
    return false;
  }

  isCheck() {
    const k = this.king(this.turn);
    return k !== null && this.isAttackedBy(!this.turn, k);
  }

  // ---------------------------------------------------------------- move properties
  isEnPassant(m) {
    const d = m.to - m.from;
    return this.epSquare === m.to && this.pt[m.from] === PAWN && (Math.abs(d) === 7 || Math.abs(d) === 9) && !this.pt[m.to];
  }
  isCapture(m) {
    return (this.pt[m.to] !== 0 && this.pc[m.to] !== this.turn) || this.isEnPassant(m);
  }
  isCastling(m) {
    if (this.pt[m.from] === KING) {
      const diff = (m.from & 7) - (m.to & 7);
      return Math.abs(diff) > 1 || (this.pt[m.to] === ROOK && this.pc[m.to] === this.turn);
    }
    return false;
  }
  isZeroing(m) {
    return this.pt[m.from] === PAWN || this.pt[m.to] === PAWN ||
      (this.pt[m.to] !== 0 && this.pc[m.to] !== this.turn) || (this.pt[m.from] !== 0 && this.pc[m.from] !== this.turn);
  }
  givesCheck(m) {
    const b = this.copy(false);
    b.push(m);
    return b.isCheck();
  }

  // ---------------------------------------------------------------- push / pop
  push(m) {
    this._states.push(this._snapshot());
    this.moveStack.push(m);
    this._legal = null;
    const epSquare = this.epSquare;
    this.epSquare = null;
    this.halfmoveClock += 1;
    if (this.turn === BLACK) this.fullmoveNumber += 1;
    if (!m) { this.turn = !this.turn; return this; } // null move
    const t = this.pt[m.from];
    const capturedType = this.pt[m.to] && this.pc[m.to] !== this.turn ? this.pt[m.to] : 0;
    if (t === PAWN || capturedType) this.halfmoveClock = 0;
    // castling rights
    const bit = (s) => (s === 0 ? 1 : s === 7 ? 2 : s === 56 ? 4 : s === 63 ? 8 : 0);
    this.castling &= ~bit(m.from) & ~bit(m.to);
    if (t === KING) this.castling &= this.turn === WHITE ? ~3 : ~12;
    const castling = this.isCastlingRaw(m, t);
    this.pt[m.from] = 0;
    if (castling) {
      const rank = m.from >> 3;
      const kingside = (m.to & 7) > (m.from & 7);
      const rookFrom = this.pt[m.to] === ROOK && this.pc[m.to] === this.turn ? m.to : rank * 8 + (kingside ? 7 : 0);
      this.pt[rookFrom] = 0;
      const kTo = rank * 8 + (kingside ? 6 : 2), rTo = rank * 8 + (kingside ? 5 : 3);
      this.pt[kTo] = KING; this.pc[kTo] = this.turn;
      this.pt[rTo] = ROOK; this.pc[rTo] = this.turn;
    } else {
      if (t === PAWN) {
        const diff = m.to - m.from;
        if (diff === 16 && (m.from >> 3) === 1) this.epSquare = m.from + 8;
        else if (diff === -16 && (m.from >> 3) === 6) this.epSquare = m.from - 8;
        else if (m.to === epSquare && (Math.abs(diff) === 7 || Math.abs(diff) === 9) && !capturedType) {
          const down = this.turn === WHITE ? -8 : 8;
          this.pt[epSquare + down] = 0;
        }
      }
      this.pt[m.to] = m.promotion || t;
      this.pc[m.to] = this.turn;
    }
    this.turn = !this.turn;
    return this;
  }
  isCastlingRaw(m, t) {
    if (t !== KING) return false;
    const diff = (m.from & 7) - (m.to & 7);
    return Math.abs(diff) > 1 || (this.pt[m.to] === ROOK && this.pc[m.to] === this.turn);
  }
  pushUci(uci) {
    const m = this.parseUci(uci);
    return this.push(m);
  }
  pushSan(san) { const m = this.parseSan(san); this.push(m); return m; }
  pushNull() { return this.push(null); }
  pop() {
    const m = this.moveStack.pop();
    this._restore(this._states.pop());
    return m;
  }
  peek() { return this.moveStack[this.moveStack.length - 1]; }

  /** python-chess: `b.push(Move.null()); Board(b.fen())` -- the side to move passes, history dropped. */
  nullMoveBoard() {
    const b = this.copy(false);
    b.push(null);
    return new Board(b.fen());
  }

  // ---------------------------------------------------------------- castling helpers
  cleanCastlingRights() {
    let c = 0;
    const ok = (bit, sq, color, kingSq) =>
      (this.castling & bit) && this.pt[sq] === ROOK && this.pc[sq] === color && this.pt[kingSq] === KING && this.pc[kingSq] === color;
    if (ok(1, 0, WHITE, 4)) c |= 1;
    if (ok(2, 7, WHITE, 4)) c |= 2;
    if (ok(4, 56, BLACK, 60)) c |= 4;
    if (ok(8, 63, BLACK, 60)) c |= 8;
    return c;
  }
  hasCastlingRights(color) {
    return (this.cleanCastlingRights() & (color === WHITE ? 3 : 12)) !== 0;
  }

  // ---------------------------------------------------------------- FEN
  boardFen() {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = '', empty = 0;
      for (let f = 0; f < 8; f++) {
        const s = r * 8 + f;
        if (!this.pt[s]) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        const sym = SYMBOLS[this.pt[s]];
        row += this.pc[s] ? sym.toUpperCase() : sym;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join('/');
  }
  castlingFen() {
    const c = this.cleanCastlingRights();
    let s = '';
    if (c & 2) s += 'K';
    if (c & 1) s += 'Q';
    if (c & 8) s += 'k';
    if (c & 4) s += 'q';
    return s || '-';
  }
  _rawFen() {
    return `${this.boardFen()} ${this.turn ? 'w' : 'b'} ${this.castlingFen()} ${this.epSquare !== null ? squareName(this.epSquare) : '-'} ${this.halfmoveClock} ${this.fullmoveNumber}`;
  }
  /** What python-chess sends to the engine: the root position + the move stack. */
  uciPosition() {
    let root = this;
    if (this._states.length) { root = new Board(null); root._restore(this._states[0]); }
    const fen = root._rawFen();
    if (this.moveStack.some((m) => !m)) return { fen: this._rawFen(), moves: [] }; // null moves can't be sent
    return { fen: fen === STARTING_FEN ? 'startpos' : fen, moves: this.moveStack.map(moveUci) };
  }
  hasLegalEnPassant() {
    if (this.epSquare === null) return false;
    return this.legalMoves().some((m) => this.isEnPassant(m));
  }
  fen() {
    const ep = this.hasLegalEnPassant() ? squareName(this.epSquare) : '-';
    return `${this.boardFen()} ${this.turn ? 'w' : 'b'} ${this.castlingFen()} ${ep} ${this.halfmoveClock} ${this.fullmoveNumber}`;
  }

  // ---------------------------------------------------------------- legal moves (via chess.js, python order)
  _chess() {
    // chess.js needs a valid-looking ep square for the side to move; pass the raw one only if it's on the right rank
    let ep = '-';
    if (this.epSquare !== null && (this.epSquare >> 3) === (this.turn ? 5 : 2)) ep = squareName(this.epSquare);
    const fen = `${this.boardFen()} ${this.turn ? 'w' : 'b'} ${this.castlingFen()} ${ep} ${this.halfmoveClock} ${this.fullmoveNumber}`;
    return new Chess(fen, { skipValidation: true });
  }
  _computeLegal() {
    let list;
    try {
      list = this._chess().moves({ verbose: true });
    } catch (e) {
      list = [];
    }
    const inCheck = this.isCheck();
    const PROMO_RANK = { 5: 0, 4: 1, 3: 2, 2: 3, 0: 0 };
    const moves = list.map((v) => {
      const m = { from: parseSquare(v.from), to: parseSquare(v.to), promotion: v.promotion ? TYPE_OF[v.promotion] : 0 };
      const t = this.pt[m.from];
      let group;
      if (t === KING && (v.flags.includes('k') || v.flags.includes('q'))) group = 1;
      else if (t !== PAWN) group = 0;
      else if (v.flags.includes('e')) group = 5;
      else if (v.flags.includes('c')) group = 2;
      else if (v.flags.includes('b')) group = 4;
      else group = 3;
      if (inCheck && t === KING && group === 0) group = -1;
      let k1 = -m.from, k2 = -m.to;
      if (group === 3 || group === 4) { k1 = -m.to; k2 = 0; }
      if (group === 1) { k1 = -m.to; k2 = 0; } // kingside (higher rook square) first
      const key = [group, k1, k2, PROMO_RANK[m.promotion || 0]];
      return { m, key, san: v.san };
    });
    moves.sort((a, b) => {
      for (let i = 0; i < 4; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
      return 0;
    });
    const san = new Map();
    for (const x of moves) san.set(moveUci(x.m), x.san);
    return { moves: moves.map((x) => x.m), san };
  }
  legalMoves() {
    if (!this._legal) this._legal = this._computeLegal();
    return this._legal.moves;
  }
  isLegal(m) {
    if (!m) return false;
    this.legalMoves();
    return this._legal.san.has(moveUci(m));
  }
  /** Legality of a capture-like move by king safety only (python is_legal for pseudo-legal moves; used by SEE). */
  isLegalFast(m) {
    if (!this.pt[m.from] || this.pc[m.from] !== this.turn) return false;
    if (this.pt[m.to] && this.pc[m.to] === this.turn) return false;
    if (this.pt[m.to] === KING) return false;
    const b = this.copy(false);
    const color = this.turn;
    b.push(m);
    const k = b.king(color);
    return k === null || !b.isAttackedBy(!color, k);
  }
  parseUci(uci) {
    const m = moveFromUci(uci);
    if (!this.isLegal(m)) throw new Error(`illegal uci: ${uci} in ${this.fen()}`);
    return m;
  }
  san(m) {
    this.legalMoves();
    const s = this._legal.san.get(moveUci(m));
    if (s === undefined) throw new Error(`illegal move ${moveUci(m)} in ${this._rawFen()}`);
    return s;
  }
  parseSan(san) {
    const norm = (x) => x.replace(/[+#!?]/g, '').replace(/e\.p\./, '').replace(/0/g, 'O').trim();
    const want = norm(san);
    for (const m of this.legalMoves()) if (norm(this.san(m)) === want) return m;
    // permissive fallback (e.g. "Nge2" where not needed, or lower-case promotions)
    try {
      const c = this._chess();
      const v = c.move(san, { strict: false });
      if (v) return { from: parseSquare(v.from), to: parseSquare(v.to), promotion: v.promotion ? TYPE_OF[v.promotion] : 0 };
    } catch (e) { /* fallthrough */ }
    throw new Error(`illegal san: ${san} in ${this.fen()}`);
  }
  variationSan(moves) {
    const b = this.copy(false);
    const out = [];
    for (const m of moves) {
      if (!b.isLegal(m)) throw new Error(`illegal move ${moveUci(m)} in position ${b.fen()}`);
      const s = b.san(m);
      if (b.turn === WHITE) out.push(`${b.fullmoveNumber}. ${s}`);
      else if (!out.length) out.push(`${b.fullmoveNumber}...${s}`);
      else out.push(s);
      b.push(m);
    }
    return out.join(' ');
  }

  // ---------------------------------------------------------------- game state
  isCheckmate() { return this.isCheck() && this.legalMoves().length === 0; }
  isStalemate() { return !this.isCheck() && this.legalMoves().length === 0; }
  hasInsufficientMaterial(color) {
    const mine = this.occupiedCo(color), theirs = this.occupiedCo(!color);
    if (mine.some((s) => [PAWN, ROOK, QUEEN].includes(this.pt[s]))) return false;
    if (mine.some((s) => this.pt[s] === KNIGHT)) {
      return mine.length <= 2 && !theirs.some((s) => this.pt[s] !== KING && this.pt[s] !== QUEEN);
    }
    if (mine.some((s) => this.pt[s] === BISHOP)) {
      const bishops = SQUARES.filter((s) => this.pt[s] === BISHOP);
      const dark = (s) => ((s & 7) + (s >> 3)) % 2 === 0;
      const sameColor = !bishops.some(dark) || !bishops.some((s) => !dark(s));
      const anyPawn = SQUARES.some((s) => this.pt[s] === PAWN), anyKnight = SQUARES.some((s) => this.pt[s] === KNIGHT);
      return sameColor && !anyPawn && !anyKnight;
    }
    return true;
  }
  isInsufficientMaterial() { return this.hasInsufficientMaterial(WHITE) && this.hasInsufficientMaterial(BLACK); }
  _isHalfmoves(n) { return this.halfmoveClock >= n && this.legalMoves().length > 0; }
  isSeventyfiveMoves() { return this._isHalfmoves(150); }
  isFiftyMoves() { return this._isHalfmoves(100); }
  canClaimFiftyMoves() {
    if (this.isFiftyMoves()) return true;
    if (this.halfmoveClock >= 99) {
      for (const m of this.legalMoves()) {
        if (!this.isZeroing(m)) {
          const b = this.copy(false);
          b.push(m);
          if (b.isFiftyMoves()) return true;
        }
      }
    }
    return false;
  }
  transpositionKey() {
    return `${this.boardFen()} ${this.turn ? 'w' : 'b'} ${this.cleanCastlingRights()} ${this.hasLegalEnPassant() ? this.epSquare : '-'}`;
  }
  _reducesCastlingRights(m) {
    const cr = this.cleanCastlingRights();
    const bit = (s) => (s === 0 ? 1 : s === 7 ? 2 : s === 56 ? 4 : s === 63 ? 8 : 0);
    if ((bit(m.from) | bit(m.to)) & cr) return true;
    const touchedKing = (color) => [m.from, m.to].some((s) => this.pt[s] === KING && this.pc[s] === color);
    return !!((cr & 3) && touchedKing(WHITE)) || !!((cr & 12) && touchedKing(BLACK));
  }
  isIrreversible(m) {
    return this.isZeroing(m) || this._reducesCastlingRights(m) || this.hasLegalEnPassant();
  }
  /** Earlier positions back to the last irreversible move, newest first (as Boards). */
  _history() {
    const out = [];
    for (let i = this._states.length - 1; i >= 0; i--) {
      const prev = new Board(null);
      prev._restore(this._states[i]);
      const mv = this.moveStack[i];
      if (!mv) break; // null move: python treats as reversible but positions don't repeat meaningfully; stop
      if (prev.isIrreversible(mv)) break;
      out.push(prev);
    }
    return out;
  }
  isRepetition(count = 3) {
    const key = this.transpositionKey();
    let n = 1;
    for (const b of this._history()) {
      if (b.transpositionKey() === key) n++;
      if (n >= count) return true;
    }
    return n >= count;
  }
  canClaimThreefoldRepetition() {
    const counts = new Map();
    const key = this.transpositionKey();
    counts.set(key, 1);
    for (const b of this._history()) {
      const k = b.transpositionKey();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    if (counts.get(key) >= 3) return true;
    for (const m of this.legalMoves()) {
      const b = this.copy(false);
      b.push(m);
      if ((counts.get(b.transpositionKey()) || 0) >= 2) return true;
    }
    return false;
  }
  isFivefoldRepetition() { return this.isRepetition(5); }

  /** python-chess Board.outcome(claim_draw=...) -> {termination, winner, result} | null */
  outcome(claimDraw = false) {
    if (this.isCheckmate()) return { termination: 'checkmate', winner: !this.turn, result: this.turn ? '0-1' : '1-0' };
    const draw = (t) => ({ termination: t, winner: null, result: '1/2-1/2' });
    if (this.isInsufficientMaterial()) return draw('insufficient_material');
    if (this.legalMoves().length === 0) return draw('stalemate');
    if (this.isSeventyfiveMoves()) return draw('seventyfive_moves');
    if (this.isFivefoldRepetition()) return draw('fivefold_repetition');
    if (claimDraw) {
      if (this.canClaimFiftyMoves()) return draw('fifty_moves');
      if (this.canClaimThreefoldRepetition()) return draw('threefold_repetition');
    }
    return null;
  }
  isGameOver(claimDraw = false) { return this.outcome(claimDraw) !== null; }
}

export function boardFrom(fen, moves = []) {
  const b = new Board(!fen || fen === 'startpos' ? STARTING_FEN : fen);
  for (const u of moves || []) b.pushUci(u);
  return b;
}
