// Python-compatibility helpers + engine glue shared by the coach modules.
import { MATE, scoreOf as rawScoreOf } from '../engine.js';
import { moveFromUci, moveUci } from './board.js';

export { MATE };

/** Python's round(x, n) for floats (round-half-even on exact ties). */
export function pyRound(x, n = 0) {
  if (!Number.isFinite(x)) return x;
  // toFixed works on the exact binary value (like Python), but breaks exact ties upwards; Python rounds them to even
  const exact = x.toFixed(Math.min(100, n + 60));
  const dot = exact.indexOf('.');
  const tail = exact.slice(dot + 1 + n);
  if (/^50*$/.test(tail)) {
    const f = 10 ** n;
    const lo = Math.floor(Math.abs(x) * f);
    const v = (lo % 2 === 0 ? lo : lo + 1) / f;
    return x < 0 ? -v : v;
  }
  return Number(x.toFixed(n));
}

/** Python f"{x:.0f}". */
export const fmt0 = (x) => String(pyRound(x, 0));

export const pyMax = (arr, key) => {
  let best, bk;
  for (const x of arr) { const k = key(x); if (best === undefined || k > bk) { best = x; bk = k; } }
  return best;
};
export const pyMin = (arr, key) => {
  let best, bk;
  for (const x of arr) { const k = key(x); if (best === undefined || k < bk) { best = x; bk = k; } }
  return best;
};
/** Stable sort by key (numbers or arrays compared lexicographically) like Python's sorted(key=...). */
export function sortedBy(arr, key) {
  const cmp = (a, b) => {
    if (Array.isArray(a)) {
      for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; }
      return 0;
    }
    if (typeof a === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
    return a < b ? -1 : a > b ? 1 : 0;
  };
  return arr.map((x, i) => [key(x), i, x]).sort((p, q) => cmp(p[0], q[0]) || p[1] - q[1]).map((p) => p[2]);
}
/** list(dict.fromkeys(moves)) for move objects. */
export function uniqueMoves(moves) {
  const seen = new Set(), out = [];
  for (const m of moves) { const k = moveUci(m); if (!seen.has(k)) { seen.add(k); out.push(m); } }
  return out;
}

/** python-chess score_of(info, pov colour). Engine infos carry the root's side to move in `turn`. */
export function scoreOf(info, pov) {
  return rawScoreOf(info, info.turn === pov);
}

/** Engine lines with pv converted to move objects (like python-chess info dicts). */
function toInfo(line) {
  return { score: line.score, pv: (line.pv || []).map(moveFromUci).filter(Boolean), depth: line.depth, turn: line.turn,
           multipv: line.multipv };
}

/** python Engine.analyse(board, nodes, multipv, root_moves): [] when the game is over. */
export async function analyseBoard(engine, board, { nodes, multipv = 1, rootMoves = null } = {}) {
  if (board.isGameOver()) return [];
  const { fen, moves } = board.uciPosition();
  const lines = await engine.analyse(fen, { moves, nodes, multipv, searchmoves: rootMoves ? rootMoves.map(moveUci) : null });
  return lines.map(toInfo);
}
