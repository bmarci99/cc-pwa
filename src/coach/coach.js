// Port of chess_analyzer/coach.py: board-geometry helpers, null-move threat detection and explain_move.
import {
  Board, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, SQUARES, squareName, moveUci, sameMove, Move, boardFrom, moveFromUci,
} from './board.js';
import { PySet } from './pyset.js';
import { MATE, analyseBoard, pyRound, scoreOf } from './util.js';
import { classify, winPct } from './analyze.js';
import { DEFAULT_NODES } from '../engine.js';

export const VALUES = { [PAWN]: 1, [KNIGHT]: 3, [BISHOP]: 3, [ROOK]: 5, [QUEEN]: 9, [KING]: 100 };
export const NAMES = { [PAWN]: 'pawn', [KNIGHT]: 'knight', [BISHOP]: 'bishop', [ROOK]: 'rook', [QUEEN]: 'queen', [KING]: 'king' };

export const TIPS = {
  allowed_mate: 'Before every move, look at every check your opponent would have afterwards. King safety first.',
  hung_piece: 'Blunder-check: after choosing a move, ask "what can they capture now?" and count attackers vs defenders.',
  moved_into_attack: 'Before moving a piece, check the destination square: who attacks it, and who defends it?',
  allowed_fork: 'Look for squares where one enemy piece could attack two of yours (especially knight checks).',
  allowed_pin: 'Pieces on the same line as your king or queen are pin targets. Watch the bishops and rooks.',
  allowed_discovered: 'When an enemy piece moves out of the way, a line opens. Check what the piece behind it now attacks.',
  trapped_piece: 'Before going deep with a piece (especially the queen), make sure it has a way back.',
  ignored_threat: 'First question every move: "What does my opponent\'s last move want?"',
  missed_mate: 'Checks first! When the enemy king is exposed, look at every forcing move.',
  missed_win_material: 'Scan your checks, captures and threats every move. Something was free here.',
  missed_fork: 'Look for double attacks: a move that hits two things at once (or king + piece).',
  material_loss: 'Calculate the forcing sequence to the end before entering it. Count material at the end of the line.',
  positional: 'When nothing tactical is happening, improve your worst piece and avoid creating weaknesses.',
  good: 'Good move. Keep using the same process.',
};

// ------------------------------------------------------------------ board geometry helpers
export const sq = squareName;

export function pieceDesc(board, s) {
  const p = board.pieceAt(s);
  return p ? `${NAMES[p.type]} on ${sq(s)}` : sq(s);
}

export function material(board, color) {
  let n = 0;
  for (const p of [PAWN, KNIGHT, BISHOP, ROOK, QUEEN]) n += board.pieces(p, color).length * VALUES[p];
  return n;
}
export const balance = (board, color) => material(board, color) - material(board, !color);

/** Piece on s can be won: attacked and undefended, or attacked by a cheaper piece. */
export function isHanging(board, s) {
  const p = board.pieceAt(s);
  if (!p || p.type === KING) return false;
  const attackers = board.attackers(!p.color, s);
  if (!attackers.length) return false;
  const defenders = board.attackers(p.color, s);
  const cheapest = Math.min(...attackers.map((a) => VALUES[board.pieceTypeAt(a)]));
  return !defenders.length || cheapest < VALUES[p.type];
}

/** python set of squares (PySet keeps CPython's iteration order). */
export function hangingPieces(board, color) {
  const out = new PySet();
  for (const s of SQUARES) if (board.pt[s] && board.pc[s] === color && isHanging(board, s)) out.add(s);
  return out;
}

/** Valuable enemy pieces (or king) attacked by the piece on s, if it attacks 2+ of them. */
export function forkTargets(board, s) {
  const p = board.pieceAt(s);
  if (!p) return [];
  const targets = [];
  for (const t of board.attacks(s)) {
    const q = board.pieceAt(t);
    if (q && q.color !== p.color && (q.type === KING || VALUES[q.type] > VALUES[p.type] ||
        (VALUES[q.type] >= 3 && !board.attackers(q.color, t).length))) targets.push(t);
  }
  return targets.length >= 2 ? targets : [];
}

export function pinnedPieces(board, color) {
  const out = new PySet();
  for (const s of SQUARES) {
    if (board.pt[s] && board.pc[s] === color && board.pt[s] !== KING && board.isPinned(color, s)) out.add(s);
  }
  return out;
}

/** Pieces worth >= 3 that are attacked and have no safe square to go to. */
export function trappedPieces(board, color) {
  const out = [];
  const b = board.copy(false).setTurn(color);
  for (const s of SQUARES) {
    const p = b.pieceAt(s);
    if (!p || p.color !== color || VALUES[p.type] < 3 || p.type === KING) continue;
    if (!isHanging(b, s)) continue;
    let escapes = false;
    for (const mv of b.legalMoves()) {
      if (mv.from !== s) continue;
      const captured = b.pieceAt(mv.to);
      if (captured && VALUES[captured.type] >= VALUES[p.type]) { escapes = true; break; }
      const b2 = b.copy(false);
      b2.push(mv);
      if (!isHanging(b2, mv.to)) { escapes = true; break; }
    }
    if (!escapes) out.push(s);
  }
  return out;
}

/** 'Nxe5 (knight takes pawn on e5, check)'. */
export function describe(board, move) {
  const san = board.san(move);
  const p = board.pieceAt(move.from);
  const parts = [];
  if (board.isCapture(move)) {
    const cap = board.pieceAt(move.to) || { type: PAWN, color: !board.turn };
    parts.push(`${NAMES[p.type]} takes ${NAMES[cap.type]} on ${sq(move.to)}`);
  } else if (board.isCastling(move)) parts.push('castles');
  else parts.push(`${NAMES[p.type]} to ${sq(move.to)}`);
  if (board.givesCheck(move)) parts.push('check');
  return `${san} (${parts.join(', ')})`;
}

export function mateIn(score) {
  if (Math.abs(score) >= MATE - 500) return Math.floor((MATE - Math.abs(score) + 1) / 2) || 1;
  return null;
}

export function lineSan(board, pv, n = 6) {
  try { return board.variationSan(pv.slice(0, n)); } catch (e) { return ''; }
}

export function materialAfterLine(board, pv, color, plies = 6) {
  const b = board.copy();
  for (const mv of pv.slice(0, plies)) {
    if (!b.isLegal(mv)) break;
    b.push(mv);
  }
  return balance(b, color);
}

/** What would the opponent do if it were their move again? (null-move threat detection)
 *  `base`: an existing analysis of `board` (saves a search; Python re-searches it at nodes // 2). */
export async function opponentThreat(board, engine, nodes, base = null) {
  if (board.isCheck()) return null;
  const b = board.nullMoveBoard();
  if (b.isGameOver()) return null;
  const infos = await analyseBoard(engine, b, { nodes });
  if (!infos.length || !infos[0].pv.length) return null;
  const threat = infos[0].pv[0];
  if (!base) base = await analyseBoard(engine, board, { nodes });
  const me = board.turn;
  const sNull = -scoreOf(infos[0], b.turn);
  const sNow = base && base.length ? scoreOf(base[0], me) : 0;
  if (winPct(sNow) - winPct(sNull) < 15) return null;
  return { uci: moveUci(threat), san: b.san(threat), desc: describe(b, threat), line: lineSan(b, infos[0].pv),
           mate: sNull < -9000 ? mateIn(-sNull) : null };
}

// ------------------------------------------------------------------ main entry point

/** Explain `move` played in `board` (position before the move). Same JSON as Python explain_move. */
export async function explainMoveBoard(board, move, engine, { nodes = DEFAULT_NODES.explain, threatNodes = DEFAULT_NODES.threat,
                                                               withThreat = true, reuseBaseForThreat = true } = {}) {
  const me = board.turn;
  const before = await analyseBoard(engine, board, { nodes, multipv: 2 });
  if (!before.length || !before[0].pv.length) throw new Error('no legal moves to explain');
  const bestInfo = before[0];
  const best = bestInfo.pv[0];
  const sBefore = scoreOf(bestInfo, me);
  const sSecond = before.length > 1 ? scoreOf(before[1], me) : null;

  const afterBoard = board.copy();
  afterBoard.push(move);
  const after = await analyseBoard(engine, afterBoard, { nodes });
  let sAfter;
  if (afterBoard.isCheckmate()) sAfter = MATE;
  else if (afterBoard.isGameOver() || !after.length) sAfter = 0;
  else sAfter = -scoreOf(after[0], afterBoard.turn);
  const refutation = after.length ? after[0].pv || [] : [];

  const wb = winPct(sBefore), wa = winPct(sAfter);
  const drop = Math.max(0.0, wb - wa);
  const secondGap = sSecond !== null ? wb - winPct(sSecond) : 0.0;
  let sacrificed = 0;
  if (refutation.length && afterBoard.isCapture(refutation[0])) {
    sacrificed = Math.max(0, balance(board, me) - materialAfterLine(afterBoard, refutation, me));
  }
  const prev = board.moveStack.length ? board.peek() : null;
  const obvious = board.isCheck() || (prev != null && board.isCapture(move) && move.to === prev.to);
  const label = classify(drop, moveUci(move), moveUci(best), { winBefore: wb, winAfter: wa, secondGap, sacrificed, obvious });

  const facts = [];
  const motifs = [];
  const playedDesc = describe(board, move);

  const threat = withThreat ? await opponentThreat(board, engine, threatNodes, reuseBaseForThreat ? before : null) : null;

  if (['brilliant', 'great', 'best', 'good'].includes(label)) {
    if (label === 'brilliant') {
      facts.push(`${playedDesc} is a sound sacrifice: you give up about ${sacrificed} points of material, ` +
                 'but the engine confirms it works.');
    } else if (label === 'great') {
      facts.push(`${playedDesc} was the only good move. Every alternative would have cost you a lot.`);
    } else if (label === 'best') {
      facts.push(`${playedDesc} is the engine's top choice.`);
    } else {
      facts.push(`${playedDesc} is fine. The engine slightly prefers ${describe(board, best)}.`);
    }
    if (threat) facts.push(`It also handles the opponent's threat ${threat.desc}.`);
    const targets = forkTargets(afterBoard, move.to);
    if (targets.length) facts.push('It creates a double attack on ' + targets.map((t) => pieceDesc(afterBoard, t)).join(' and ') + '.');
    motifs.push('good');
  } else {
    // --- what goes wrong after the played move
    if (sAfter <= -(MATE - 500)) {
      const n = mateIn(sAfter);
      facts.push(`${playedDesc} allows a forced mate in ${n}: ${lineSan(afterBoard, refutation, 2 * n + 1)}.`);
      motifs.push('allowed_mate');
    } else if (refutation.length) {
      const reply = refutation[0];
      const replyDesc = describe(afterBoard, reply);
      if (threat && threat.uci === moveUci(reply)) {
        facts.push(`Your opponent was already threatening ${threat.desc}, and ${board.san(move)} ` + "doesn't stop it.");
        motifs.push('ignored_threat');
      }
      if (afterBoard.isCapture(reply)) {
        const victimSq = reply.to;
        const victim = afterBoard.pieceAt(victimSq);
        if (victim && victimSq === move.to) {
          facts.push(`You moved your ${NAMES[victim.type]} to ${sq(victimSq)}, where it can ` + `simply be taken: ${replyDesc}.`);
          motifs.push('moved_into_attack');
        } else if (victim && hangingPieces(board, me).has(victimSq)) {
          if (!motifs.includes('ignored_threat')) {
            facts.push(`Your ${NAMES[victim.type]} on ${sq(victimSq)} was already under attack, ` +
                       `and ${board.san(move)} doesn't save it: ${replyDesc}.`);
            motifs.push('ignored_threat');
          }
        } else if (victim) {
          facts.push(`It leaves your ${NAMES[victim.type]} on ${sq(victimSq)} unprotected: ` + `${replyDesc}.`);
          motifs.push('hung_piece');
        }
      }
      const newlyHanging = hangingPieces(afterBoard, me).difference(hangingPieces(board, me)).difference(new PySet([move.to]));
      if (newlyHanging.size && !motifs.includes('hung_piece')) {
        facts.push('After your move these pieces are loose: ' + [...newlyHanging].map((s) => pieceDesc(afterBoard, s)).join(', ') + '.');
        motifs.push('hung_piece');
      }
      const b2 = afterBoard.copy();
      b2.push(reply);
      const targets = forkTargets(b2, reply.to);
      if (targets.length) {
        facts.push(`The reply ${replyDesc} forks your ` + targets.map((t) => pieceDesc(b2, t)).join(' and ') + '.');
        motifs.push('allowed_fork');
      }
      const newPins = pinnedPieces(afterBoard, me).difference(pinnedPieces(board, me));
      if (newPins.size) {
        facts.push('Your ' + [...newPins].map((s) => pieceDesc(afterBoard, s)).join(', ') + ' is now pinned to your king.');
        motifs.push('allowed_pin');
      }
      // discovered attack: a different enemy piece now attacks something valuable
      for (const s of SQUARES) {
        const p = b2.pieceAt(s);
        if (p && p.color !== me && s !== reply.to && [BISHOP, ROOK, QUEEN].includes(p.type)) {
          const old = new Set(afterBoard.attacks(s));
          const newHits = b2.attacks(s).filter((t) => !old.has(t)).filter((t) => {
            const q = b2.pieceAt(t);
            return q && q.color === me && [KING, QUEEN, ROOK].includes(q.type);
          });
          if (newHits.length) {
            facts.push(`Moving out of the way opens a line for their ${pieceDesc(b2, s)}, ` +
                       `which now hits your ${pieceDesc(b2, newHits[0])} (discovered attack).`);
            motifs.push('allowed_discovered');
            break;
          }
        }
      }
      const trapped = trappedPieces(b2, me);
      if (trapped.length) {
        facts.push('Your ' + trapped.map((s) => pieceDesc(b2, s)).join(', ') + ' gets trapped: it is attacked and has no safe square.');
        motifs.push('trapped_piece');
      }
      const loss = balance(board, me) - materialAfterLine(afterBoard, refutation, me);
      if (loss >= 2 && !motifs.some((m) => m === 'hung_piece' || m === 'moved_into_attack')) {
        facts.push(`After the likely continuation ${lineSan(afterBoard, refutation)} you are ` + `down about ${loss} points of material.`);
        motifs.push('material_loss');
      }
    }

    // --- what was missed
    const bestDesc = describe(board, best);
    if (sBefore >= MATE - 500) {
      const n = mateIn(sBefore);
      facts.push(`You had a forced mate in ${n}: ${lineSan(board, bestInfo.pv, 2 * n + 1)}.`);
      motifs.unshift('missed_mate');
    } else {
      const gain = materialAfterLine(board, bestInfo.pv, me) - balance(board, me);
      if (board.isCapture(best) && hangingPieces(board, !me).has(best.to)) {
        facts.push(`The opponent's ${pieceDesc(board, best.to)} was free: ${bestDesc}.`);
        motifs.push('missed_win_material');
      } else if (gain >= 2) {
        facts.push(`${bestDesc} would have won about ${gain} points of material: ` + `${lineSan(board, bestInfo.pv)}.`);
        motifs.push('missed_win_material');
      }
      const b3 = board.copy();
      b3.push(best);
      const targets = forkTargets(b3, best.to);
      if (targets.length) {
        facts.push(`${bestDesc} forks the ` + targets.map((t) => pieceDesc(b3, t)).join(' and ') + '.');
        motifs.push('missed_fork');
      }
    }
    facts.push(`Better was ${bestDesc}. Engine line: ${lineSan(board, bestInfo.pv)}.`);
    if (!motifs.length) motifs.push('positional');
  }

  const primary = motifs.length ? motifs[0] : 'positional';
  return {
    played: moveUci(move), played_san: board.san(move), classification: label,
    best: moveUci(best), best_san: board.san(best), best_line: lineSan(board, bestInfo.pv, 8),
    refutation_line: refutation.length ? lineSan(afterBoard, refutation, 8) : '',
    refutation_uci: refutation.slice(0, 8).map(moveUci),
    best_line_uci: bestInfo.pv.slice(0, 8).map(moveUci),
    eval_before: sBefore, eval_after: sAfter,
    win_before: pyRound(wb, 1), win_after: pyRound(wa, 1), win_drop: pyRound(drop, 1),
    threat, motifs, facts, tip: TIPS[primary] ?? TIPS.positional,
    fen_before: board.fen(), fen_after: afterBoard.fen(),
  };
}

/** server.parse_move: auto-queen promotions sent without a suffix. */
export function parseMove(board, uci) {
  let mv = moveFromUci(uci);
  if (!mv) throw new Error(`Bad move ${uci}`);
  if (!board.isLegal(mv)) {
    if (uci.length === 4) mv = moveFromUci(uci + 'q');
    if (!board.isLegal(mv)) throw new Error(`Illegal move ${uci}`);
  }
  return mv;
}

export async function explainMove(engine, { fen = 'startpos', moves = [], uci, ...opts } = {}) {
  const board = boardFrom(fen, moves);
  const mv = parseMove(board, uci);
  return explainMoveBoard(board, mv, engine, opts);
}

/** Puzzle check: the best move, or one that keeps nearly the same win chances. */
export async function isCorrectSolution(engine, { fen = 'startpos', moves = [], uci, bestUci = null, ...opts } = {}) {
  const board = boardFrom(fen, moves);
  const mv = parseMove(board, uci);
  const info = await explainMoveBoard(board, mv, engine, { ...opts, withThreat: true });
  const correct = moveUci(mv) === (bestUci || info.best) || info.win_drop <= 4 || ['best', 'great', 'brilliant'].includes(info.classification);
  return { correct, info };
}

export { Board, Move, sameMove };
