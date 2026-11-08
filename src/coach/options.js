// Port of chess_analyzer/options.py: "Here are your options", a coach-style menu of plans for the side to move.
// All examples are scored in ONE restricted Stockfish search (`go ... searchmoves`, python's root_moves).
import {
  WHITE, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, FILE_NAMES, squareFile, squareRank, parseSquare, between,
  BB_KNIGHT_ATTACKS, moveUci,
} from './board.js';
import { NAMES, VALUES, describe, hangingPieces, lineSan, pinnedPieces, sq } from './coach.js';
import {
  badBishops, development, kingSafety, mobility, openFiles, outposts, pawnFiles, pawnStructure, phase, relRank, see,
  material,
} from './strategy.js';
import { MATE, analyseBoard, pyMax, pyMin, pyRound, scoreOf, sortedBy, uniqueMoves } from './util.js';
import { winPct } from './analyze.js';
import { DEFAULT_NODES } from '../engine.js';

export const MAX_CANDIDATES_PER_OPTION = 4;

// ------------------------------------------------------------------ helpers

/** The move doesn't simply hang the moved piece. */
export function safe(board, mv) {
  if (board.isCapture(mv) && see(board, mv) < 0) return false;
  const b = board.copy(false);
  b.push(mv);
  const s = mv.to;
  const p = b.pieceAt(s);
  if (p === null) return true;
  const attackers = b.attackers(!p.color, s);
  if (!attackers.length) return true;
  const cheapest = Math.min(...attackers.map((a) => VALUES[b.pieceTypeAt(a)]));
  const defended = b.attackers(p.color, s).length > 0;
  return (defended && cheapest >= VALUES[p.type]) || (p.type === PAWN && defended);
}

/** Safe moves after which the moved piece attacks `target` (and didn't before). */
export function movesAttacking(board, target, pieces = [KNIGHT, BISHOP, ROOK, QUEEN, PAWN]) {
  const out = [];
  for (const mv of board.legalMoves()) {
    const p = board.pieceAt(mv.from);
    if (!pieces.includes(p.type) || mv.to === target) continue;
    if (board.attacks(mv.from).includes(target)) continue;
    const b = board.copy(false);
    b.push(mv);
    if (b.attacks(mv.to).includes(target) && safe(board, mv)) out.push(mv);
  }
  return out;
}

export function defends(board, mv, target, color) {
  const b = board.copy(false);
  b.push(mv);
  return b.attackers(color, target).length > 0;
}

export function kingZone(board, color) {
  const k = board.king(color);
  if (k === null) return new Set();
  const zone = new Set([...board.attacks(k), k]);
  const step = color === WHITE ? 8 : -8;
  for (const s of [...zone]) if (s + step >= 0 && s + step < 64) zone.add(s + step);
  return zone;
}

export function attackersOnZone(board, color, zone) {
  const out = new Set();
  for (const z of zone) for (const a of board.attackers(color, z)) {
    const t = board.pieceTypeAt(a);
    if (t !== KING && t !== PAWN) out.add(a);
  }
  return out.size;
}

export function backwardPawns(board, color) {
  const out = [];
  const mine = pawnFiles(board, color);
  const step = color === WHITE ? 8 : -8;
  for (const [f, squares] of mine) {
    for (const s of squares) {
      const neighbours = [f - 1, f + 1].flatMap((ff) => mine.get(ff) || []);
      if (!neighbours.length || neighbours.some((t) => relRank(t, color) <= relRank(s, color))) continue;
      const stop = s + step;
      if (stop >= 0 && stop < 64 && board.attackers(!color, stop).some((a) => board.pieceTypeAt(a) === PAWN)) out.push(s);
    }
  }
  return out;
}

export function option(kind, icon, title, why, how, { targets = [], pieces = [], candidates = [], priority = 5, reveals_targets = false } = {}) {
  return { kind, icon, title, why, how, targets: targets.map(sq), pieces: pieces.map(sq),
           _cands: uniqueMoves(candidates).slice(0, MAX_CANDIDATES_PER_OPTION), priority, reveals_targets };
}

// ------------------------------------------------------------------ option builders

export function optTactic(board, me, best, second) {
  if (!best || !second || !best.pv || !best.pv.length) return null;
  const s1 = scoreOf(best, me), s2 = scoreOf(second, me);
  const gap = winPct(s1) - winPct(s2);
  if (gap < 18 || (Math.abs(s1) >= MATE - 500 && s1 < 0)) return null;
  const mv = best.pv[0];
  const forcing = board.isCapture(mv) || board.givesCheck(mv);
  return option('tactic', '⚡', "There's a tactic: find it!",
    'One move here is much stronger than everything else. Positions like this are where games are won.',
    'Go through every check, then every capture, then every threat. For each one, ask how they reply.' +
    (forcing ? ' Start with the forcing moves.' : " The key move is quiet, but it creates a threat they can't meet."),
    { candidates: [mv], priority: 0 });
}

export function optParryThreat(board, me, threat, best) {
  if (!threat) return null;
  const tFrom = parseSquare(threat.from), tTo = parseSquare(threat.to);
  const cands = [];
  if (best && best.pv && best.pv.length) cands.push(best.pv[0]);
  const victim = board.pieceAt(tTo);
  const btw = between(tFrom, tTo);
  for (const m of board.legalMoves()) {
    if (!safe(board, m)) continue;
    if (m.to === tFrom) cands.push(m);                                                      // capture the attacker
    else if (victim && m.from === tTo) cands.push(m);                                       // move the target away
    else if (defends(board, m, tTo, me) && !board.attackers(me, tTo).length) cands.push(m); // defend the target square
    else if (btw.includes(m.to)) cands.push(m);                                             // block
  }
  return option('parry', '🚨', `Deal with their threat ${threat.san}`,
    `Their last move set up ${threat.desc}` + (threat.mate ? ` (mate in ${threat.mate})` : '') +
    '. If you ignore it, you lose material or worse.',
    'You can defend the target, move it, block the line, capture the attacker, or strike back with an even ' +
    'bigger threat (a counter-attack is often the best defence).',
    { targets: [tTo], pieces: [tFrom], candidates: cands, priority: 0 });
}

export function optGrab(board, me) {
  let wins = sortedBy(board.legalMoves().filter((m) => board.isCapture(m)).map((m) => [see(board, m), m]), (x) => -x[0]);
  wins = wins.filter(([g]) => g >= 1);
  if (!wins.length) return null;
  const [g, m] = wins[0];
  const victim = board.pieceAt(m.to) || { type: PAWN, color: !me };
  return option('grab', '💰', `Take the free ${NAMES[victim.type]} on ${sq(m.to)}`,
    `Their ${NAMES[victim.type]} on ${sq(m.to)} isn't defended well enough: ` +
    `after all the exchanges you come out about ${g} point${g > 1 ? 's' : ''} up.`,
    "Count attackers and defenders on that square. Before grabbing, check that the capture doesn't " +
    'walk into a check, a fork or a back-rank trick.',
    { targets: [m.to], pieces: [m.from], candidates: wins.slice(0, 3).map(([, x]) => x), priority: 1 });
}

export function optAttackWeakness(board, me) {
  const them = !me;
  const ph = phase(board);
  const weaknesses = []; // [prio, square, label, why]
  for (const s of pinnedPieces(board, them)) {
    weaknesses.push([1, s, `pinned ${NAMES[board.pieceTypeAt(s)]} on ${sq(s)}`,
      "It can't move without exposing the king, so it can't run away. Attack it again " +
      '(ideally with a pawn) and it may simply be lost.']);
  }
  if (ph !== 'opening' || board.fullmoveNumber >= 8) {
    for (const s of pawnStructure(board, them).isolated) {
      weaknesses.push([2, s, `isolated pawn on ${sq(s)}`,
        'No other pawn can ever defend it, so their pieces have to babysit it. That makes ' + 'them passive.']);
    }
    for (const s of backwardPawns(board, them)) {
      weaknesses.push([2, s, `backward pawn on ${sq(s)}`,
        "It's left behind its neighbours and can't safely advance, so it's a fixed target " + 'on a half-open file.']);
    }
    for (const f of pawnStructure(board, them).doubled) {
      const pawns = board.pieces(PAWN, them).filter((s) => FILE_NAMES[squareFile(s)] === f);
      const front = pyMax(pawns, (s) => relRank(s, them));
      weaknesses.push([3, front, `doubled pawns on the ${f}-file`,
        "Doubled pawns can't protect each other, and the front one is often weak."]);
    }
  }
  for (const [prio, s, label, why] of sortedBy(weaknesses, (x) => x[0])) {
    // pile pieces on pawn weaknesses; pawns may attack pinned pieces
    const pieces = [KNIGHT, BISHOP, ROOK, QUEEN, ...(prio === 1 ? [PAWN] : [])];
    const cands = movesAttacking(board, s, pieces);
    if (!cands.length && prio === 1) continue;
    const already = board.attackers(me, s).filter((a) => board.pieceTypeAt(a) !== KING);
    const defenders = board.attackers(them, s).filter((d) => board.pieceTypeAt(d) !== KING);
    const count = already.length || defenders.length
      ? ` Right now you attack it ${already.length}× and they defend it ${defenders.length}×.` : '';
    return option('attack_weakness', '🎯', `Attack their ${label}`, why + count,
      `Aim more pieces at ${sq(s)} than they can defend it with: rooks on its file, a knight ` +
      'or bishop hitting it. If it falls, you win material for free.',
      { targets: [s], pieces: [...cands.map((c) => c.from), ...already], candidates: cands, priority: 2 });
  }
  return null;
}

export function optOutpost(board, me) {
  const posts = outposts(board, me);
  const knights = board.pieces(KNIGHT, me);
  if (!posts.length || !knights.length) return null;
  const occupied = posts.filter((s) => board.hasPiece(s, KNIGHT, me));
  if (occupied.length) return null;
  // knights that can reach an outpost in one move, or approach it
  let best = null;
  for (const s of sortedBy(posts, (x) => -relRank(x, me))) {
    const direct = board.legalMoves().filter((m) => m.to === s && board.pieceTypeAt(m.from) === KNIGHT && safe(board, m));
    if (direct.length) { best = [s, direct]; break; }
    const approach = [];
    for (const m of board.legalMoves()) {
      if (board.pieceTypeAt(m.from) !== KNIGHT || !safe(board, m)) continue;
      if (BB_KNIGHT_ATTACKS[m.to].includes(s)) approach.push(m);
    }
    if (approach.length && best === null) best = [s, approach];
  }
  if (!best) return null;
  const [s, cands] = best;
  return option('outpost', '🐴', `Plant a knight on ${sq(s)}`,
    `${sq(s)} is a hole in their camp: no pawn of theirs can ever attack it. A knight there is a monster ` +
    "that controls key squares and can't be chased away.",
    `Route a knight to ${sq(s)} (it's protected by your pawn). If they trade it off, they usually have to ` +
    'give up a good piece for it.', { targets: [s], pieces: cands.map((c) => c.from), candidates: cands, priority: 3 });
}

/** Up to two of your own weaknesses, most urgent first. */
export function optFixWeaknesses(board, me) {
  const out = [];
  const sub = board.copy(false);
  for (const fn of [fixHanging, fixBackRank, fixPin, fixKingCentre, fixPassed, fixBadBishop]) {
    const o = fn(sub, me);
    if (o) out.push(o);
    if (out.length === 2) break;
  }
  return out;
}

function fixHanging(board, me) {
  const hang = sortedBy([...hangingPieces(board, me)], (s) => -VALUES[board.pieceTypeAt(s)]);
  if (hang.length) {
    const s = hang[0];
    const p = board.pieceAt(s);
    const cands = board.legalMoves().filter((m) => m.from === s && safe(board, m));
    cands.push(...board.legalMoves().filter((m) => m.from !== s && board.pieceTypeAt(m.from) !== KING &&
      safe(board, m) && defends(board, m, s, me)).slice(0, 3));
    return option('fix_weakness', '🛡️', `Save your ${NAMES[p.type]} on ${sq(s)}`,
      `It's attacked ${!board.attackers(me, s).length ? 'and not defended' : 'by a cheaper piece'}: ` +
      'if you ignore it, you simply lose material.',
      'Move it to a safe square, defend it, or block the attack. Or, if you have one, play an even ' +
      'bigger threat first.', { targets: [s], candidates: cands, priority: 1 });
  }
  return null;
}

function fixBackRank(board, me) {
  const ks = kingSafety(board, me);
  if (ks.back_rank_risk) {
    const k = board.king(me);
    const luft = board.legalMoves().filter((m) => board.pieceTypeAt(m.from) === PAWN &&
      Math.abs(squareFile(m.from) - squareFile(k)) <= 1 && relRank(m.from, me) === 1 && safe(board, m));
    return option('fix_weakness', '🛡️', 'Give your king an escape square',
      `Your king on ${sq(k)} is boxed in by its own pawns and no rook guards the back rank. A single ` +
      'rook or queen check could be mate (exactly how one of your recent games was lost).',
      'Push one pawn in front of the king one square (h3/h6 or g3/g6) when you have a quiet moment, ' +
      'or keep a rook on the back rank.', { targets: [k], candidates: luft, priority: 2 });
  }
  return null;
}

function fixPin(board, me) {
  const pins = pinnedPieces(board, me);
  if (pins.size) {
    const s = pins[Symbol.iterator]().next().value;
    const btw = between(s, board.king(me));
    const cands = board.legalMoves().filter((m) => board.pieceTypeAt(m.from) === KING && safe(board, m));
    cands.push(...board.legalMoves().filter((m) => btw.includes(m.to) && safe(board, m)));
    return option('fix_weakness', '🛡️', `Break the pin on your ${NAMES[board.pieceTypeAt(s)]}`,
      "A pinned piece is paralysed. It can't move, so it doesn't really defend anything, and they " +
      'can pile up on it.',
      'Step the king out of the line, put something in between, or attack the pinning piece.',
      { targets: [s], candidates: cands, priority: 3 });
  }
  return null;
}

function fixKingCentre(board, me) {
  const ks = kingSafety(board, me);
  if (ks.in_center && phase(board) !== 'endgame' && board.fullmoveNumber >= 7) {
    const cands = board.legalMoves().filter((m) => board.isCastling(m));
    if (cands.length) {
      return option('fix_weakness', '🛡️', 'Get your king out of the centre',
        'The centre is where the lines open. An uncastled king there is the most common reason ' +
        'games are lost early.',
        'Castle now while it\'s still possible.', { targets: [board.king(me)], candidates: cands, priority: 2 });
    }
  }
  return null;
}

function fixPassed(board, me) {
  const them = !me;
  const oppPassed = pawnStructure(board, them).passed;
  if (oppPassed.length) {
    const s = pyMax(oppPassed, (x) => relRank(x, them));
    if (relRank(s, them) >= 4) {
      const stop = s + (them === WHITE ? 8 : -8);
      const cands = [...board.legalMoves().filter((m) => m.to === stop && safe(board, m)), ...movesAttacking(board, stop).slice(0, 2)];
      return option('fix_weakness', '🛡️', `Stop their passed pawn on ${sq(s)}`,
        'A passed pawn only needs a clear road to become a queen; every square it advances makes it ' +
        'more dangerous.',
        `Blockade it: put a piece (a knight is ideal) on ${sq(stop)}, right in front of it. A blockaded ` +
        'passed pawn is just a weakness.', { targets: [s, stop], candidates: cands, priority: 2 });
    }
  }
  return null;
}

function fixBadBishop(board, me) {
  for (const b of badBishops(board, me)) {
    const cands = board.legalMoves().filter((m) => m.from === b && safe(board, m));
    return option('fix_weakness', '🛡️', `Fix your bad bishop on ${sq(b)}`,
      'Your own pawns are fixed on its colour, so it bites on granite.',
      'Reroute it outside the pawn chain, or trade it for one of their good pieces.',
      { targets: [b], candidates: cands, priority: 4 });
  }
  return null;
}

export function optImprovePiece(board, me) {
  if (phase(board) === 'opening') return null;
  const cands = [KNIGHT, BISHOP, ROOK].flatMap((pt) => board.pieces(pt, me).map((s) => [mobility(board, s), s]));
  if (!cands.length) return null;
  const [m0, s] = pyMin(cands, (x) => x[0] * 64 + x[1]); // min((mobility, square)) tuple order
  if (m0 > 3) return null;
  let moves = [];
  for (const mv of board.legalMoves()) {
    if (mv.from !== s || !safe(board, mv)) continue;
    const b = board.copy(false);
    b.push(mv);
    const gain = mobility(b, mv.to) - m0;
    if (gain >= 2) moves.push([gain, mv]);
  }
  moves = sortedBy(moves, (x) => -x[0]).map(([, m]) => m);
  if (!moves.length) return null;
  const name = NAMES[board.pieceTypeAt(s)];
  return option('improve_piece', '♻️', `Improve your ${name} on ${sq(s)}`,
    `It's your worst piece: it only has ${m0} useful square${m0 !== 1 ? 's' : ''}. A game is only as strong ` +
    'as your worst piece.',
    'Find it a square where it attacks something or controls the centre. Pieces work best together.',
    { targets: [s], pieces: [s], candidates: moves, priority: 4 });
}

export function optPawnBreak(board, me) {
  const breaks = [];
  for (const mv of board.legalMoves()) {
    if (board.pieceTypeAt(mv.from) !== PAWN || board.isCapture(mv)) continue;
    const b = board.copy(false);
    b.push(mv);
    const hits = b.attacks(mv.to).filter((t) => b.hasPiece(t, PAWN, !me));
    if (hits.length && safe(board, mv)) breaks.push([mv, hits[0]]);
  }
  if (!breaks.length) return null;
  const [mv, hit] = breaks[0];
  const f = FILE_NAMES[squareFile(hit)];
  return option('pawn_break', '💥', `Open the position with ${board.san(mv)}`,
    `A pawn break challenges their pawn on ${sq(hit)}. When pawns get exchanged, files and diagonals open ` +
    "for your rooks and bishops. That's how you create play.",
    'Prepare it so that after the exchange your pieces are the ones using the open lines (for example ' +
    `a rook ready for the ${f}-file).`, { targets: [hit], pieces: [mv.from], candidates: breaks.map(([b]) => b), priority: 4 });
}

export function optKingAttack(board, me) {
  const them = !me;
  if (phase(board) === 'endgame') return null;
  const ks = kingSafety(board, them);
  if (!(ks.in_center && board.fullmoveNumber >= 8) && (ks.shield ?? 3) >= 2) return null;
  const zone = kingZone(board, them);
  const base = attackersOnZone(board, me, zone);
  const cands = [];
  for (const mv of board.legalMoves()) {
    const t = board.pieceTypeAt(mv.from);
    if (t === KING || t === PAWN || !safe(board, mv)) continue;
    const b = board.copy(false);
    b.push(mv);
    if (attackersOnZone(b, me, zone) > base) cands.push(mv);
  }
  if (!cands.length) return null;
  const reason = ks.in_center ? 'Their king is still in the centre.' : `Their king on ${ks.square} has little pawn cover.`;
  return option('king_attack', '⚔️', 'Go after their king',
    `${reason} Attacks succeed when you bring more attackers than they have defenders.`,
    'Bring pieces closer one by one (queen, knights, rooks via open files or rook lifts). Don\'t start ' +
    'sacrificing until enough pieces are aimed at the king.',
    { targets: [board.king(them)], candidates: cands, priority: 3 });
}

export function optOpenFile(board, me) {
  const [full, half] = openFiles(board, me);
  const files = full.length ? full : half;
  if (!files.length || phase(board) === 'opening') return null;
  const occupied = new Set(board.pieces(ROOK, me).map((r) => FILE_NAMES[squareFile(r)]));
  const targetFiles = files.filter((f) => !occupied.has(f));
  if (!targetFiles.length) return null;
  const cands = board.legalMoves().filter((m) => [ROOK, QUEEN].includes(board.pieceTypeAt(m.from)) &&
    targetFiles.includes(FILE_NAMES[squareFile(m.to)]) && safe(board, m));
  if (!cands.length) return null;
  const f = FILE_NAMES[squareFile(cands[0].to)];
  return option('open_file', '🏰', `Take the ${full.includes(f) ? 'open' : 'half-open'} ${f}-file`,
    'Rooks are only strong on open files. Whoever controls the file can invade on the 7th rank.',
    "Put a rook on it, then double rooks (or rook + queen) so they can't contest it.",
    { targets: [cands[0].to], pieces: cands.map((c) => c.from), candidates: cands, priority: 5 });
}

export function optTrade(board, me, evalPov) {
  const ahead = material(board, me) - material(board, !me) >= 2 || winPct(evalPov) >= 75;
  if (!ahead) return null;
  const cands = board.legalMoves().filter((m) => board.isCapture(m) && see(board, m) >= 0 &&
    board.pieceAt(m.to) && VALUES[board.pieceTypeAt(m.to)] >= 3);
  if (!cands.length) return null;
  return option('trade', '🤝', 'Trade pieces and simplify',
    "You're ahead. Every piece trade makes your extra material count more and takes away their " +
    'chances for tricks.',
    'Offer trades of pieces (not pawns), especially their most active attacker. Then win the endgame.',
    { candidates: cands, priority: 3 });
}

export function optDevelop(board, me) {
  if (phase(board) !== 'opening') return null;
  const dev = development(board, me);
  const cands = board.legalMoves().filter((m) => dev.undeveloped.includes(m.from) && safe(board, m));
  cands.push(...board.legalMoves().filter((m) => board.isCastling(m)));
  if (!cands.length) return null;
  return option('develop', '🚀', 'Finish your development',
    'In the opening the side that gets its pieces out first gets to attack first.',
    'Bring out the remaining minor pieces towards the centre, castle, then connect the rooks.',
    { targets: dev.undeveloped, pieces: dev.undeveloped, candidates: cands, priority: 3 });
}

export function optEndgame(board, me) {
  if (phase(board) !== 'endgame') return [];
  const out = [];
  const k = board.king(me);
  const dist = (s) => Math.abs(squareFile(s) - 3.5) + Math.abs(squareRank(s) - 3.5);
  const central = board.legalMoves().filter((m) => m.from === k && safe(board, m) && dist(m.to) < dist(k));
  if (central.length) {
    out.push(option('king_activity', '👑', 'Activate your king',
      'In the endgame the king is a strong fighting piece. Every move it sits on the back rank is ' +
      'wasted.', 'March it towards the centre or towards the pawns that matter.',
      { targets: [k], pieces: [k], candidates: central, priority: 3 }));
  }
  const passed = pawnStructure(board, me).passed;
  if (passed.length) {
    const s = pyMax(passed, (x) => relRank(x, me));
    const pushes = board.legalMoves().filter((m) => m.from === s && safe(board, m));
    const support = movesAttacking(board, s + (me === WHITE ? 8 : -8)).slice(0, 2);
    if (pushes.length || support.length) {
      out.push(option('passed_pawn', '♟️', `Push your passed pawn on ${sq(s)}`,
        'Passed pawns must be pushed. Each step forward ties down more of their pieces.',
        'Support it with king and rook (rooks belong behind passed pawns) and push when the ' +
        'next square is safe.', { targets: [s], candidates: [...pushes, ...support], priority: 2 }));
    }
  }
  return out;
}

// ------------------------------------------------------------------ assemble + engine-verify

const VERDICT_TEXT = {
  excellent: 'The engine agrees: this is one of the best plans right now.',
  good: 'A good, sound plan.',
  slower: "Playable, but there's something more urgent or stronger.",
  'not now': "Tempting, but it doesn't work right now. Check the position for a concrete problem first.",
};

/** Coach's menu for `pov` (only meaningful when it's pov's move; otherwise []). */
export async function buildOptions(board, engine, pov, best, second, evalPov, { threat = null, nodes = DEFAULT_NODES.options,
                                                                             maxNodes = DEFAULT_NODES.optionsMax, limit = 6 } = {}) {
  if (board.turn !== pov || board.isGameOver()) return [];
  const me = pov;
  const raw = [optParryThreat(board, me, threat, best), optTactic(board, me, best, second), optGrab(board, me),
               ...optFixWeaknesses(board, me),
               optAttackWeakness(board, me), optOutpost(board, me), optKingAttack(board, me),
               optDevelop(board, me), optPawnBreak(board, me), optImprovePiece(board, me),
               optOpenFile(board, me), optTrade(board, me, evalPov), ...optEndgame(board, me)];
  const opts = raw.filter(Boolean);
  if (!opts.length) return [];

  // one restricted search over all candidate moves
  const cands = uniqueMoves(opts.flatMap((o) => o._cands.filter((m) => board.isLegal(m)))).slice(0, 16);
  const scores = new Map(); // uci -> [score, pv]
  if (cands.length) {
    const n = Math.min(maxNodes, nodes * Math.max(1, Math.floor(cands.length / 4)));
    const infos = await analyseBoard(engine, board, { nodes: n, multipv: cands.length, rootMoves: cands });
    for (const i of infos) if (i.pv && i.pv.length) scores.set(moveUci(i.pv[0]), [scoreOf(i, me), i.pv]);
  }
  const top = best ? winPct(scoreOf(best, me)) : 50.0;
  const bestMove = best && best.pv && best.pv.length ? best.pv[0] : null;

  for (const o of opts) {
    const c = o._cands;
    delete o._cands;
    const scored = c.filter((m) => scores.has(moveUci(m))).map((m) => [scores.get(moveUci(m))[0], m]);
    if (scored.length) {
      const [s, mv] = pyMax(scored, (x) => x[0]);
      const loss = Math.max(0.0, top - winPct(s));
      o.example = { san: board.san(mv), uci: moveUci(mv), from: sq(mv.from), to: sq(mv.to),
                    desc: describe(board, mv), line: lineSan(board, scores.get(moveUci(mv))[1], 6),
                    is_engine_best: !!bestMove && moveUci(mv) === moveUci(bestMove) };
      o.loss = pyRound(loss, 1);
      o.verdict = loss <= 3 ? 'excellent' : loss <= 8 ? 'good' : loss <= 15 ? 'slower' : 'not now';
      if (o.verdict === 'not now' && winPct(s) >= 55) o.verdict = 'slower'; // still a good position afterwards
      let reason = '';
      const pv = scores.get(moveUci(mv))[1];
      if (o.verdict === 'not now' && pv.length >= 2) {
        const b2 = board.copy(false);
        b2.push(mv);
        const reply = pv[1];
        if (b2.isLegal(reply)) {
          const b3 = b2.copy(false);
          b3.push(reply);
          reason = b3.isCheckmate() ? `After ${board.san(mv)}, ${b2.san(reply)} is checkmate!`
                                    : `After ${board.san(mv)}, they have ${describe(b2, reply)}.`;
        }
      }
      o.not_now_reason = reason;
      o.verdict_text = VERDICT_TEXT[o.verdict];
    } else {
      o.example = null; o.loss = null; o.verdict = 'idea'; o.verdict_text = 'A long-term idea to keep in mind.';
    }
  }
  // urgent things first, then by how good the engine thinks the plan is
  const rank = { excellent: 0, good: 1, idea: 2, slower: 3, 'not now': 4 };
  const sorted = sortedBy(opts, (o) => [o.priority > 1, rank[o.verdict], o.priority]);
  // drop duplicates of the same example move (keep the more urgent framing)
  const seen = new Set(), out = [];
  for (const o of sorted) {
    const key = o.example ? o.example.uci : o.kind + o.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out.slice(0, limit);
}
