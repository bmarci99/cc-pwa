// Port of chess_analyzer/analyze.py: win%, move classification, phase, and the per-game analysis loop.
import { Board, BISHOP, KNIGHT, PAWN, QUEEN, ROOK, WHITE, BLACK, STARTING_FEN, moveUci, sameMove } from './board.js';
import { MATE, analyseBoard, pyRound, scoreOf } from './util.js';
import { DEFAULT_NODES } from '../engine.js';

export const INACCURACY = 10.0, MISTAKE = 20.0, BLUNDER = 30.0;
export const PIECE_VALUES = { [KNIGHT]: 3, [BISHOP]: 3, [ROOK]: 5, [QUEEN]: 9 };

export function winPct(cp) {
  cp = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function materialAnalyze(board, color) {
  let n = 0;
  for (const [p, v] of [[KNIGHT, 3], [BISHOP, 3], [ROOK, 5], [QUEEN, 9], [PAWN, 1]]) n += board.pieces(p, color).length * v;
  return n;
}

/** Lichess-style error bands plus chess.com-style 'brilliant' / 'great' approximations (see analyze.py). */
export function classify(winDrop, played, best, { winBefore = 50, winAfter = 50, secondGap = 0, sacrificed = 0, obvious = false } = {}) {
  const isBest = !!best && played === best;
  const nearBest = isBest || winDrop < 2;
  if (isBest && sacrificed >= 2 && winAfter >= 45 && winBefore <= 85) return 'brilliant';
  if (nearBest && !obvious && secondGap >= 25 && winBefore >= 15 && winBefore <= 92) return 'great';
  if (best && played === best) return 'best';
  if (winDrop >= BLUNDER) return 'blunder';
  if (winDrop >= MISTAKE) return 'mistake';
  if (winDrop >= INACCURACY) return 'inaccuracy';
  return 'good';
}

export function phaseOf(board) {
  let material = 0;
  for (const [p, v] of [[KNIGHT, 3], [BISHOP, 3], [ROOK, 5], [QUEEN, 9]]) {
    material += (board.pieces(p, WHITE).length + board.pieces(p, BLACK).length) * v;
  }
  if (material <= 26 || (!board.pieces(QUEEN, WHITE).length && !board.pieces(QUEEN, BLACK).length && material <= 34)) return 'endgame';
  if (board.fullmoveNumber <= 12) return 'opening';
  return 'middlegame';
}

// ------------------------------------------------------------------ PGN (headers, mainline SAN, [%clk] comments)

/** Minimal PGN reader: {headers, startFen, moves: [{san, clock}]} for the first game's mainline. */
export function parsePgn(pgn) {
  const headers = {};
  const text = pgn.replace(/\r/g, '');
  const headerRe = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm;
  let m;
  let lastHeaderEnd = 0;
  while ((m = headerRe.exec(text))) { headers[m[1]] = m[2].replace(/\\(.)/g, '$1'); lastHeaderEnd = headerRe.lastIndex; }
  const body = text.slice(lastHeaderEnd);
  const moves = [];
  let i = 0, depth = 0;
  const clockOf = (comment) => {
    const c = /\[%clk\s(\d+):(\d+):(\d+(?:\.\d*)?)\]/.exec(comment);
    return c ? Number(c[1]) * 3600 + Number(c[2]) * 60 + Number(c[3]) : null;
  };
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{') {
      const j = body.indexOf('}', i + 1);
      const comment = body.slice(i + 1, j < 0 ? body.length : j);
      if (depth === 0 && moves.length) {
        const c = clockOf(comment);
        if (c !== null && moves[moves.length - 1].clock === null) moves[moves.length - 1].clock = c;
      }
      i = j < 0 ? body.length : j + 1;
      continue;
    }
    if (ch === ';') { const j = body.indexOf('\n', i); i = j < 0 ? body.length : j + 1; continue; }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    let j = i;
    while (j < body.length && !/[\s{}();]/.test(body[j])) j++;
    const tok = body.slice(i, j);
    i = j;
    if (depth > 0) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) break;
    if (/^\$\d+$/.test(tok)) continue;
    const t = tok.replace(/^\d+\.(\.\.)?/, '').replace(/^\.+/, '');
    if (!t || /^\d+$/.test(t)) continue;
    moves.push({ san: t, clock: null });
  }
  const startFen = headers.FEN && (headers.SetUp === undefined || headers.SetUp === '1') ? headers.FEN : STARTING_FEN;
  return { headers, startFen, moves };
}

async function evaluate(engine, board, nodes) {
  if (board.isCheckmate()) return [-MATE, [], null];
  if (board.isGameOver()) return [0, [], null];
  const infos = await analyseBoard(engine, board, { nodes, multipv: 2 });
  const top = infos[0];
  const second = infos.length > 1 ? scoreOf(infos[1], board.turn) : null;
  return [scoreOf(top, board.turn), top.pv || [], second];
}

/**
 * Per-ply rows like analyze.analyse_game (evals from the mover's POV, mate = ±10000).
 * Pass `pgn`, or `startFen` + `moves` (uci) [+ `clocks`: seconds left after each ply, + `timeControl` "600+5"].
 */
export async function analyseGame(engine, { pgn = null, startFen = null, moves = null, clocks = null, timeControl = null,
                                            myColor = 'white', increment = 0, nodes = DEFAULT_NODES.game, onProgress = null,
                                            gameId = undefined } = {}) {
  let board, plies, tc;
  if (pgn) {
    const g = parsePgn(pgn);
    board = new Board(g.startFen);
    const b = board.copy();
    plies = [];
    for (const mv of g.moves) {
      const m = b.parseSan(mv.san);
      plies.push({ move: m, clock: mv.clock });
      b.push(m);
    }
    tc = g.headers.TimeControl || '';
  } else {
    board = new Board(startFen || STARTING_FEN);
    const b = board.copy();
    plies = (moves || []).map((u, i) => {
      const m = b.parseUci(u);
      b.push(m);
      return { move: m, clock: clocks && clocks[i] !== undefined && clocks[i] !== null ? Number(clocks[i]) : null };
    });
    tc = timeControl || '';
  }

  const evals = [];
  const b = board.copy();
  const total = plies.length + 1;
  evals.push(await evaluate(engine, b, nodes));
  if (onProgress) onProgress(1, total);
  for (const p of plies) {
    b.push(p.move);
    evals.push(await evaluate(engine, b, nodes));
    if (onProgress) onProgress(evals.length, total);
  }

  let base = null;
  if (tc && !tc.includes('/') && tc !== '-') base = parseFloat(tc.split('+')[0]);
  const lastClock = { true: base, false: base };

  const rows = [];
  const me = myColor === 'white' ? WHITE : BLACK;
  plies.forEach((node, i) => {
    const mover = board.turn;
    const [scoreBefore, pv, second] = evals[i];
    const scoreAfter = -evals[i + 1][0];
    const best = pv.length ? pv[0] : null;
    let pvSan = '';
    try { pvSan = pv.length ? board.variationSan(pv.slice(0, 6)) : ''; } catch (e) { pvSan = ''; }
    const bestSan = best ? board.san(best) : null;
    const san = board.san(node.move);
    const phase = phaseOf(board);
    const fen = board.fen();

    const clock = node.clock;
    let spent = null;
    if (clock !== null && lastClock[mover] !== null && !Number.isNaN(lastClock[mover])) {
      spent = Math.max(0.0, lastClock[mover] - clock + increment);
    }
    if (clock !== null) lastClock[mover] = clock;

    const wb = winPct(scoreBefore), wa = winPct(scoreAfter);
    const drop = Math.max(0.0, wb - wa);
    const secondGap = second !== null ? wb - winPct(second) : 0.0;
    let sacrificed = 0;
    const after = board.copy();
    after.push(node.move);
    const replyPv = evals[i + 1][1];
    const line = after.copy();
    for (const mv of replyPv.slice(0, 6)) {
      if (!line.isLegal(mv)) break;
      line.push(mv);
    }
    const prevMove = board.moveStack.length ? board.peek() : null;
    const obvious = board.isCheck() || (prevMove !== null && board.isCapture(node.move) && node.move.to === prevMove.to);
    const replyCaptures = replyPv.length > 0 && after.isCapture(replyPv[0]);
    if (!node.move.promotion && replyCaptures) {
      const balanceBefore = materialAnalyze(board, mover) - materialAnalyze(board, !mover);
      const balanceLine = materialAnalyze(line, mover) - materialAnalyze(line, !mover);
      sacrificed = Math.max(0, balanceBefore - balanceLine);
    }
    const row = {};
    if (gameId !== undefined) row.game_id = gameId;
    Object.assign(row, {
      ply: i + 1,
      move_no: board.fullmoveNumber,
      is_mine: mover === me ? 1 : 0,
      san,
      uci: moveUci(node.move),
      fen_before: fen,
      best_uci: best ? moveUci(best) : null,
      best_san: bestSan,
      pv: pvSan,
      eval_before: scoreBefore,
      eval_after: scoreAfter,
      cp_loss: Math.max(0, Math.max(-1000, Math.min(1000, scoreBefore)) - Math.max(-1000, Math.min(1000, scoreAfter))),
      win_before: pyRound(wb, 2),
      win_after: pyRound(wa, 2),
      win_drop: pyRound(drop, 2),
      classification: classify(drop, moveUci(node.move), best ? moveUci(best) : null, {
        winBefore: wb, winAfter: wa, secondGap, sacrificed, obvious,
      }),
      second_gap: pyRound(secondGap, 2),
      sacrificed,
      phase,
      clock,
      time_spent: spent,
    });
    rows.push(row);
    board.push(node.move);
  });
  return rows;
}

export { sameMove };
