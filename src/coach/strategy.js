// Port of chess_analyzer/strategy.py (insight v2): static features, named pawn structures, engine plan in words,
// tactical scan, last-move insight, imbalances, goals and the `insight` entry point.
import {
  Board, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, SQUARES, FILE_NAMES, squareFile, squareRank, square,
  parseSquare, moveUci, sameMove, Move, boardFrom,
} from './board.js';
import {
  NAMES, VALUES, describe, forkTargets, hangingPieces, lineSan, mateIn, pieceDesc, pinnedPieces, sq,
} from './coach.js';
import { PySet } from './pyset.js';
import { MATE, analyseBoard, fmt0, pyMax, pyMin, pyRound, scoreOf, sortedBy } from './util.js';
import { winPct } from './analyze.js';
import { DEFAULT_NODES } from '../engine.js';
import { buildOptions } from './options.js';

export const SIDE = { true: 'White', false: 'Black' };
const D4 = 27, E4 = 28, D5 = 35, E5 = 36;
export const CENTER = [D4, E4, D5, E5];
export const MINOR_MAJOR = [KNIGHT, BISHOP, ROOK, QUEEN];

// =========================================================================== small helpers

export function relRank(s, color) {
  const r = squareRank(s);
  return color === WHITE ? r : 7 - r;
}
export const hasPawn = (board, color, s) => board.hasPiece(s, PAWN, color);

/** dict file -> [squares], insertion order like python (Map!). */
export function pawnFiles(board, color) {
  const out = new Map();
  for (const s of board.pieces(PAWN, color)) {
    const f = squareFile(s);
    if (!out.has(f)) out.set(f, []);
    out.get(f).push(s);
  }
  return out;
}

/** Squares a piece can go to (not occupied by own pieces, not attacked by cheaper enemy pieces). */
export function mobility(board, s) {
  const p = board.pieceAt(s);
  if (!p) return 0;
  let n = 0;
  for (const t of board.attacks(s)) {
    const q = board.pieceAt(t);
    if (q && q.color === p.color) continue;
    const enemy = board.attackers(!p.color, t);
    if (enemy.some((a) => VALUES[board.pieceTypeAt(a)] < VALUES[p.type])) continue;
    n += 1;
  }
  return n;
}

/** Static exchange evaluation of a capture, in pawns, for the side making `move`. */
export function see(board, move) {
  if (!board.isCapture(move)) return 0;
  const b = board.copy(false);
  const target = move.to;
  const victim = b.pieceAt(target);
  const gain = [victim ? VALUES[victim.type] : 1]; // en passant = pawn
  let attackerValue = VALUES[b.pieceTypeAt(move.from)];
  b.push(move);
  for (;;) {
    const cands = [];
    for (const a of b.attackers(b.turn, target)) {
      const p = b.pieceAt(a);
      const promo = p.type === PAWN && (squareRank(target) === 0 || squareRank(target) === 7) ? QUEEN : 0;
      const m = Move(a, target, promo);
      if (b.isLegalFast(m)) cands.push([VALUES[p.type], m]);
    }
    if (!cands.length) break;
    const [v, m] = pyMin(cands, (x) => x[0]);
    gain.push(attackerValue - gain[gain.length - 1]);
    attackerValue = v;
    b.push(m);
    if (attackerValue >= 100) break; // king captured last: nothing can recapture (legality checked)
  }
  for (let i = gain.length - 1; i > 0; i--) gain[i - 1] = -Math.max(-gain[i - 1], gain[i]);
  return gain[0];
}

export function phase(board) {
  let nonPawn = 0;
  for (const p of MINOR_MAJOR) nonPawn += (board.pieces(p, WHITE).length + board.pieces(p, BLACK).length) * VALUES[p];
  if (nonPawn <= 26) return 'endgame';
  if (board.fullmoveNumber <= 12) return 'opening';
  return 'middlegame';
}

export function material(board, color) {
  let n = 0;
  for (const p of [PAWN, KNIGHT, BISHOP, ROOK, QUEEN]) n += board.pieces(p, color).length * VALUES[p];
  return n;
}

export function evalWords(w) {
  if (w >= 90) return 'winning';
  if (w >= 70) return 'clearly better';
  if (w >= 58) return 'slightly better';
  if (w > 42) return 'roughly equal';
  if (w > 30) return 'slightly worse';
  if (w > 10) return 'clearly worse';
  return 'losing';
}

// =========================================================================== static features

export function pawnStructure(board, color) {
  const mine = pawnFiles(board, color), theirs = pawnFiles(board, !color);
  const isolated = [], doubled = [], passed = [], backward = [];
  for (const [f, squares] of mine) {
    if (squares.length > 1) doubled.push(FILE_NAMES[f]);
    if (!mine.has(f - 1) && !mine.has(f + 1)) isolated.push(...squares);
    for (const s of squares) {
      const rr = relRank(s, color);
      const blockers = [f - 1, f, f + 1].flatMap((ff) => theirs.get(ff) || []).filter((t) => relRank(t, color) > rr);
      if (!blockers.length) passed.push(s);
    }
  }
  return { isolated, doubled, passed, backward };
}

export function openFiles(board, color) {
  const mine = pawnFiles(board, color), theirs = pawnFiles(board, !color);
  const full = [], half = [];
  for (let f = 0; f < 8; f++) {
    if (!mine.has(f) && !theirs.has(f)) full.push(FILE_NAMES[f]);
    if (!mine.has(f) && theirs.has(f)) half.push(FILE_NAMES[f]);
  }
  return [full, half];
}

export function kingSafety(board, color) {
  const k = board.king(color);
  if (k === null) return {};
  const kf = squareFile(k), kr = squareRank(k);
  const home = color === WHITE ? 0 : 7;
  const step = color === WHITE ? 1 : -1;
  let shield = 0;
  for (const f of [kf - 1, kf, kf + 1]) {
    if (f >= 0 && f < 8) {
      for (const d of [1, 2]) {
        const r = kr + step * d;
        if (r >= 0 && r < 8 && hasPawn(board, color, square(f, r))) { shield += 1; break; }
      }
    }
  }
  const zone = new Set([...board.attacks(k), k]);
  const attackers = new Set();
  for (const z of zone) for (const a of board.attackers(!color, z)) attackers.add(a);
  const [full, half] = openFiles(board, color);
  const nearOpen = [kf - 1, kf, kf + 1].filter((f) => f >= 0 && f < 8 && (full.includes(FILE_NAMES[f]) || half.includes(FILE_NAMES[f])))
    .map((f) => FILE_NAMES[f]);
  const castled = kr === home && [0, 1, 2, 6, 7].includes(kf);
  const inCenter = kr === home && [3, 4, 5].includes(kf) && !castled;
  let luft = true;
  if (kr === home) {
    const r = kr + step;
    luft = [kf - 1, kf, kf + 1].some((f) => f >= 0 && f < 8 && !board.pieceAt(square(f, r)) && !board.attackers(!color, square(f, r)).length);
  }
  const enemyHeavy = board.pieces(ROOK, !color).length > 0 || board.pieces(QUEEN, !color).length > 0;
  const guarded = [...board.pieces(ROOK, color), ...board.pieces(QUEEN, color)].some((s) => squareRank(s) === home);
  const wing = kf >= 5 ? 'kingside' : (kf <= 2 ? 'queenside' : 'centre');
  return { square: sq(k), shield, attackers: attackers.size, open_files_near: nearOpen,
           castled, in_center: inCenter, wing,
           back_rank_risk: kr === home && !luft && enemyHeavy && !guarded };
}

export function development(board, color) {
  const home = color === WHITE ? 0 : 7;
  const starts = [1, 2, 5, 6].map((f) => square(f, home));
  const undeveloped = starts.filter((s) => { const p = board.pieceAt(s); return p && p.color === color && (p.type === KNIGHT || p.type === BISHOP); });
  return { undeveloped, can_castle: board.hasCastlingRights(color) };
}

/** Squares in the opponent's half (relative ranks 4-6) controlled by own pawns, plus advanced central pawns. */
export function space(board, color) {
  const ctrl = new Set();
  for (const p of board.pieces(PAWN, color)) for (const t of board.attacks(p)) if (relRank(t, color) >= 4 && relRank(t, color) <= 6) ctrl.add(t);
  const adv = board.pieces(PAWN, color).filter((p) => relRank(p, color) >= 4 && squareFile(p) >= 2 && squareFile(p) <= 5).length;
  return ctrl.size + 2 * adv;
}

/** Squares in the enemy half that our pawn defends and no enemy pawn can ever attack. */
export function outposts(board, color) {
  const out = [];
  const theirs = pawnFiles(board, !color);
  for (const s of SQUARES) {
    const rr = relRank(s, color);
    const f = squareFile(s);
    if (!(rr >= 3 && rr <= 5 && f >= 1 && f <= 6)) continue;
    if (!board.attackers(color, s).some((a) => hasPawn(board, color, a))) continue;
    const attackable = [f - 1, f + 1].some((ff) => (theirs.get(ff) || []).some((t) => relRank(t, color) > rr));
    if (!attackable) out.push(s);
  }
  return out;
}

export function badBishops(board, color) {
  const out = [];
  const pawns = board.pieces(PAWN, color);
  for (const b of board.pieces(BISHOP, color)) {
    const light = (squareFile(b) + squareRank(b)) % 2 === 1;
    const same = pawns.filter((p) => ((squareFile(p) + squareRank(p)) % 2 === 1) === light);
    const blockedCentral = same.filter((p) => squareFile(p) >= 2 && squareFile(p) <= 5 && relRank(p, color) >= 3 &&
      board.pieceAt(p + (color === WHITE ? 8 : -8)) !== null);
    if (phase(board) !== 'opening' && same.length >= 4 && blockedCentral.length >= 2) out.push(b);
  }
  return out;
}

export function worstPiece(board, color) {
  const cands = [KNIGHT, BISHOP, ROOK].flatMap((pt) => board.pieces(pt, color).map((s) => [s, mobility(board, s)]));
  if (!cands.length) return null;
  const [s, m] = pyMin(cands, (x) => x[1]);
  return m <= 2 ? [s, m] : null;
}

// =========================================================================== named pawn structures

export function classifyStructure(board) {
  const W = WHITE, B = BLACK;
  if (phase(board) === 'endgame') return null;
  const wp = pawnFiles(board, W), bp = pawnFiles(board, B);
  const P = (c, s) => hasPawn(board, c, parseSquare(s));
  const d = 3, e = 4, c_ = 2;
  const plansOf = (pairs) => { const o = new Map(); for (const [k, v] of pairs) o.set(k, v); return o; };

  for (const color of [W, B]) {
    const mine = color === W ? wp : bp;
    if (mine.has(d) && mine.get(d).length === 1 && !mine.has(c_) && !mine.has(e)) {
      const s = mine.get(d)[0];
      const blockade = square(d, squareRank(s) + (color === W ? 1 : -1));
      const name = `Isolated queen's pawn (IQP) on ${sq(s)}`;
      const plans = plansOf([
        [color, ['Use the space and open lines it gives: attack on the kingside (knight to e5, bishop on the ' +
                 'b1–h7 or b8–h1 diagonal, rook lift).',
                 `Look for the ${sq(s)[0]}-pawn break (push it when it's safe) to open the centre.`,
                 'Keep pieces on the board. Trades make the IQP weak in the endgame.']],
        [!color, [`Blockade the pawn: a knight on ${sq(blockade)} is ideal.`,
                  'Trade pieces (especially attackers). The IQP becomes a target in the endgame.',
                  `Pile up on the pawn on ${sq(s)} with rooks and queen.`]],
      ]);
      return { name, plans };
    }
  }

  if (P(W, 'd4') && P(W, 'e5') && P(B, 'd5') && P(B, 'e6')) {
    return { name: 'French-type pawn chain (White e5/d4 vs Black e6/d5)', plans: plansOf([
      [W, ['You have kingside space: attack there (f4–f5, pieces towards Black\'s king).',
           'Keep the d4 base of the chain strong: it supports e5.']],
      [B, ['Attack the base of the chain: ...c5 to hit d4, and ...f6 to break e5.',
           "Your play is on the queenside and against the d4 pawn; don't let White's kingside attack run first."]]]) };
  }
  if (P(B, 'd5') && P(B, 'e4') && P(W, 'd4') && P(W, 'e3')) {
    return { name: 'Reversed French chain (Black e4/d5)', plans: plansOf([
      [B, ['Kingside space is yours: ...f5–f4 and pieces towards the king.', 'Protect d5, the base of your chain.']],
      [W, ['Break the chain with c4 and f3.', 'Play on the queenside, where you have more space.']]]) };
  }
  if (P(W, 'd5') && P(W, 'e4') && P(B, 'd6') && P(B, 'e5')) {
    return { name: "King's Indian–type chain (White d5/e4 vs Black d6/e5)", plans: plansOf([
      [W, ['Your play is on the queenside: prepare c4–c5 to open the c-file.',
           'Meet ...f5 by keeping control of e4 and the light squares.']],
      [B, ["Your play is on the kingside: ...f5 (and ...f4, ...g5) to attack White's king.",
           "The queenside is White's; don't open it for them."]]]) };
  }
  if (P(W, 'd4') && !wp.has(c_) && P(B, 'd5') && P(B, 'c6') && !bp.has(e)) {
    return { name: "Carlsbad structure (Queen's Gambit Exchange type)", plans: plansOf([
      [W, ['Minority attack: push b4–b5 to create a weak pawn on c6.',
           'Alternatively central play with f3 and e4.']],
      [B, ["Kingside play: pieces towards White's king, ...Ne4, ...f5 ideas.",
           'Meet b5 with ...cxb5 or ...c5 at the right moment; watch your c6 pawn.']]]) };
  }
  if (P(B, 'd5') && !bp.has(c_) && P(W, 'd4') && P(W, 'c3') && !wp.has(e)) {
    return { name: 'Reversed Carlsbad structure', plans: plansOf([
      [B, ['Minority attack: ...b5–b4 against c3.']], [W, ['Kingside play and the e4 break (Ne5, f3, e4).']]]) };
  }

  for (const color of [W, B]) {
    const mine = color === W ? wp : bp;
    if (mine.has(c_) && mine.has(d) && !mine.has(1) && !mine.has(e)) {
      const cs = mine.get(c_)[0], ds = mine.get(d)[0];
      if (squareRank(cs) === squareRank(ds)) {
        return { name: `Hanging pawns on ${sq(cs)} and ${sq(ds)}`, plans: plansOf([
          [color, ['The pawns give space and central control: support them and prepare an advance (d-pawn push) ' +
                   'when it wins space or opens lines.', "Keep pieces active; don't let them become fixed."]],
          [!color, ['Pressure the pawns from the front (c- and d-files) to force one to advance.',
                    'Once one advances, blockade the weak square left behind.']]]) };
      }
    }
  }

  const centrePawns = SQUARES.filter((s) => (squareFile(s) === 3 || squareFile(s) === 4) && board.pieceTypeAt(s) === PAWN).length;
  const wk = board.king(W), bk = board.king(B);
  if (wk !== null && bk !== null && phase(board) !== 'endgame') {
    const wf = squareFile(wk), bf = squareFile(bk);
    if ((wf >= 5 && bf <= 2) || (wf <= 2 && bf >= 5)) {
      return { name: 'Opposite-side castling: a race', plans: plansOf([
        [W, ["It's a race: storm the enemy king with pawns (they don't shelter your own king), open files towards it.",
             'Every tempo counts. Attack first, defend only when you must.']],
        [B, ["It's a race: storm the enemy king with pawns, open files towards it.",
             'Every tempo counts. Attack first, defend only when you must.']]]) };
    }
  }
  if (centrePawns <= 1) {
    return { name: 'Open centre', plans: plansOf([W, B].map((c) => [c, [
      'Piece play: development, king safety and open lines decide. Bishops and rooks love this.',
      'Put rooks on the open d/e-files; a lead in development means attack now.']])) };
  }
  const locked = [d, e].filter((f) => board.pieces(PAWN, W).some((s) => squareFile(s) === f && hasPawn(board, B, s + 8)));
  if (locked.length === 2) {
    return { name: 'Locked centre', plans: plansOf([W, B].map((c) => [c, [
      'With the centre closed, play on the wings: push pawns on the side your pawn chain points to.',
      'Knights are often better than bishops here; reroute pieces to where the play will happen.',
      "Prepare pawn breaks slowly; there's time for regrouping."]])) };
  }
  return null;
}

// =========================================================================== engine plan → words

/** Translate the `color` side's moves in an engine line into manoeuvres. */
export function planInWords(board, pv, color, maxMoves = 4) {
  const b = board.copy();
  const journeys = new Map(); // current square -> path
  const kinds = new Map();    // journey start square -> piece type
  let order = [];
  const phrases = [];
  let own = 0;
  const line = pv.slice(0, 2 * maxMoves + 1);
  for (let i = 0; i < line.length; i++) {
    const mv = line[i];
    if (!b.isLegal(mv)) break;
    if (b.turn === color) {
      own += 1;
      const p = b.pieceAt(mv.from);
      if (b.isCastling(mv)) {
        phrases.push([i, 'castle ' + (squareFile(mv.to) === 6 ? 'kingside' : 'queenside')]);
      } else if (b.isCapture(mv)) {
        const cap = b.pieceAt(mv.to) || { type: PAWN, color: !color };
        const recapture = b.moveStack.length > 0 && b.peek().to === mv.to;
        const verb = recapture ? 'recapture' : (see(b, mv) >= 1 ? 'win' : 'trade');
        phrases.push([i, `${b.san(mv)} (${verb} the ${NAMES[cap.type]} on ${sq(mv.to)})`]);
      } else if (p.type === PAWN) {
        const after = b.copy(false);
        after.push(mv);
        const hits = after.attacks(mv.to).filter((t) => { const q = after.pieceAt(t); return q && q.color !== color && q.type === PAWN; });
        const kind = hits.length ? 'pawn break' : 'pawn push';
        phrases.push([i, `the ${sq(mv.to)} ${kind}`]);
      } else {
        let path = journeys.has(mv.from) ? journeys.get(mv.from) : [mv.from];
        journeys.delete(mv.from);
        if (!kinds.has(path[0])) kinds.set(path[0], p.type);
        if (path.includes(mv.to)) path = path.slice(0, path.indexOf(mv.to)); // a route that loops back
        path.push(mv.to);
        journeys.set(mv.to, path);
        if (!order.includes(mv.to)) order = order.filter((o) => o !== mv.from).concat([mv.to]);
        phrases.push([i, `@${mv.to}`]);
      }
      if (b.givesCheck(mv)) {
        const afterChk = b.copy(false);
        afterChk.push(mv);
        const last = phrases[phrases.length - 1];
        phrases[phrases.length - 1] = [last[0], last[1] + (afterChk.isCheckmate() ? ' (checkmate!)' : ' with check')];
      }
      if (own >= maxMoves) { b.push(mv); break; }
    }
    b.push(mv);
  }
  // resolve piece journeys (keep only the last mention of each journey)
  const out = [], seenJ = new Set();
  for (const [, ph] of phrases) {
    if (ph.startsWith('@')) {
      const head = ph.slice(1).split(' ')[0];
      const dest = parseInt(head, 10);
      const suffix = ph.slice(('@' + head).length);
      const path = journeys.get(dest);
      if (path === undefined) continue;
      const key = path[0];
      if (seenJ.has(key)) continue;
      seenJ.add(key);
      const name = NAMES[kinds.has(key) ? kinds.get(key) : KNIGHT];
      out.push(`${name} ${path.map(sq).join('→')}${suffix}`);
    } else out.push(ph);
  }
  if (!out.length) return '';
  return out.length === 1 ? out[0] : out.slice(0, 3).join(', then ');
}

// =========================================================================== tactical scan

export function tacticalScan(board, pov, best, second) {
  const items = [];
  const me = pov, them = !pov;
  const myTurn = board.turn === me;

  const add = (kind, prio, text, { hint = null, squares = [], arrows = [], reveals = false } = {}) => {
    items.push({ kind, priority: prio, text, hint: hint || text, squares: [...squares].map(sq),
                 arrows: arrows.map(([a, b]) => [sq(a), sq(b)]), reveals });
  };

  // mate on the board for the side to move
  if (best != null && myTurn) {
    const s = scoreOf(best, me);
    if (s >= MATE - 500 && best.pv.length) {
      const n = mateIn(s);
      add('mate', 0, `You have a forced mate in ${n}: ${lineSan(board, best.pv, 2 * n + 1)}.`,
        { hint: `There's a forced mate in ${n}. Check every check!`, reveals: true, arrows: [[best.pv[0].from, best.pv[0].to]] });
    } else if (s <= -(MATE - 500)) {
      add('mate', 0, "You're getting mated by force: find the most stubborn defence (every check, every block).");
    }
    // tactic detector: the best move is much better than the rest and forcing / wins material
    if (second != null && best.pv.length) {
      const gap = winPct(s) - winPct(scoreOf(second, me));
      const mv = best.pv[0];
      const forcing = board.isCapture(mv) || board.givesCheck(mv);
      if (gap >= 18 && Math.abs(s) < MATE - 500) {
        add('tactic', 1, `Only one move keeps the advantage here: ${describe(board, mv)}.`,
          { hint: 'There\'s a tactic in this position. One move is much stronger than all others ' +
                  (forcing ? '(start with checks and captures).' : '(look for a quiet but forcing idea).'),
            reveals: true, arrows: [[mv.from, mv.to]] });
      }
    }
  }

  // their pieces: loose, pinned, overloaded → opportunities for me
  const relevantLoose = (s, color) => {
    const p = board.pieceAt(s);
    if (!p || p.color !== color || p.type === KING || p.type === PAWN || board.attackers(color, s).length) return false;
    if (board.attackers(!color, s).length) return true;
    if (relRank(s, color) === 0) return false;
    return !(p.type === ROOK && phase(board) === 'endgame');
  };

  const theirLoose = SQUARES.filter((s) => relevantLoose(s, them));
  if (theirLoose.length) {
    add('loose_enemy', 4, 'Undefended enemy pieces (loose pieces drop off!): ' + theirLoose.map((s) => pieceDesc(board, s)).join(', ') + '.',
      { hint: 'Some enemy pieces are undefended. Look for a double attack on them.', squares: theirLoose });
  }
  for (const s of pinnedPieces(board, them)) {
    add('pin', 4, `Their ${pieceDesc(board, s)} is pinned to the king. Attack it again (pile up), or hit it with a pawn.`,
      { hint: 'One of their pieces is pinned. Can you attack it again?', squares: [s] });
  }
  const sole = new Map();
  for (const s of SQUARES) {
    const p = board.pieceAt(s);
    if (p && p.color === them && p.type !== KING && board.attackers(me, s).length) {
      const d = board.attackers(them, s);
      if (d.length === 1) {
        if (!sole.has(d[0])) sole.set(d[0], []);
        sole.get(d[0]).push(s);
      }
    }
  }
  for (const [defender, guarded] of sole) {
    if (board.pieceTypeAt(defender) === KING) continue;
    if (guarded.length >= 2 && guarded.some((g) => VALUES[board.pieceTypeAt(g)] >= 3)) {
      add('overload', 3, `Their ${pieceDesc(board, defender)} is overloaded: it alone defends ` +
        guarded.map((g) => pieceDesc(board, g)).join(' and ') + '. Capture one, and the other falls.',
        { hint: 'One of their pieces is doing two defensive jobs at once.', squares: [defender, ...guarded] });
    }
  }
  if (myTurn) {
    const wins = [];
    for (const mv of board.legalMoves()) {
      if (board.isCapture(mv)) {
        const g = see(board, mv);
        if (g >= 2) wins.push([g, mv]);
      }
    }
    for (const [g, mv] of sortedBy(wins, (x) => -x[0]).slice(0, 2)) {
      add('win_material', 2, `${describe(board, mv)} wins material (about ${g} points after the exchanges).`,
        { hint: 'You can win material with a capture. Count attackers and defenders.', reveals: true, arrows: [[mv.from, mv.to]] });
    }
    for (const mv of board.legalMoves()) {
      const p = board.pieceAt(mv.from);
      if (![KNIGHT, PAWN, QUEEN, BISHOP].includes(p.type)) continue;
      const b2 = board.copy(false);
      b2.push(mv);
      const tg = forkTargets(b2, mv.to);
      if (tg.length && see(board, mv) >= 0 && (!b2.attackers(them, mv.to).length ||
          b2.attackers(me, mv.to).length >= b2.attackers(them, mv.to).length)) {
        add('fork_chance', 2, `Fork: ${describe(board, mv)} attacks ` + tg.map((t) => pieceDesc(b2, t)).join(' and ') + '.',
          { hint: `Look for a ${NAMES[p.type]} fork.`, reveals: true, squares: tg, arrows: [[mv.from, mv.to]] });
        break;
      }
    }
  }

  // my pieces: loose / pinned / back rank / king danger
  const hang = hangingPieces(board, me);
  if (hang.size) {
    add('hanging_mine', myTurn ? 1 : 2,
      'Your ' + [...hang].map((s) => pieceDesc(board, s)).join(', ') + (hang.size === 1 ? ' is' : ' are') +
      ' attacked and not safely defended. Save it, or make sure you have something bigger.', { squares: [...hang] });
  }
  const myLoose = SQUARES.filter((s) => relevantLoose(s, me) && !hang.has(s));
  if (myLoose.length) {
    add('loose_mine', 5, 'Loose (undefended) pieces of yours: ' + myLoose.map((s) => pieceDesc(board, s)).join(', ') +
      ". They're targets for forks and double attacks.", { squares: myLoose });
  }
  for (const s of pinnedPieces(board, me)) {
    add('pinned_mine', 3, `Your ${pieceDesc(board, s)} is pinned to your king: it can't move, and it isn't really defending.`, { squares: [s] });
  }
  const ks = kingSafety(board, me);
  if (ks.back_rank_risk) {
    add('back_rank', 2, `Back rank: your king on ${ks.square} has no escape square and no rook guards the rank. ` +
      'One heavy-piece check could be mate. Make luft (h3/h6) when you have a free move.', { squares: [parseSquare(ks.square)] });
  }
  if ((ks.attackers ?? 0) >= 3 && phase(board) !== 'endgame') {
    add('king_danger', 2, `${ks.attackers} enemy pieces aim at the squares around your king. Defend before you attack.`,
      { squares: [parseSquare(ks.square)] });
  }
  outer: for (const n of board.pieces(KNIGHT, them)) {
    for (const t of board.attacks(n)) {
      const q = board.pieceAt(t);
      if (q && q.color === them) continue;
      const b = board.copy(false).setTurn(them);
      const m = Move(n, t);
      if (!b.isLegal(m)) continue;
      b.push(m);
      const tg = forkTargets(b, t);
      if (tg.length && !b.attackers(me, t).length) {
        add('fork_alert', 3, `Fork alert: their knight can jump to ${sq(t)} and hit ` +
          tg.map((x) => pieceDesc(b, x)).join(' and ') + '. Cover that square or move a target.',
          { squares: [t, ...tg], arrows: [[n, t]] });
        break outer;
      }
    }
  }
  return sortedBy(items, (x) => x.priority);
}

// =========================================================================== last move

/** Engine analysis as if the side to move passed: reveals the other side's threat and plan. */
export async function nullAnalysis(board, engine, nodes) {
  if (board.isCheck() || board.isGameOver()) return null;
  const b = board.nullMoveBoard();
  if (b.isGameOver()) return null;
  const infos = await analyseBoard(engine, b, { nodes });
  if (!infos.length || !infos[0].pv.length) return null;
  return { board: b, info: infos[0] };
}

/** `na`: the null-move analysis of `board` (Python searches the same thing twice; we reuse it). */
export async function lastMoveInsight(board, engine, nodes, baseScoreStm, na = undefined) {
  if (!board.moveStack.length) return null;
  const mv = board.peek();
  const before = board.copy();
  before.pop();
  const mover = before.turn;
  const who = SIDE[mover];
  const p = before.pieceAt(mv.from);
  const points = [];
  const intent = [];

  if (before.isCastling(mv)) {
    points.push(`${who} castles: the king goes to safety and a rook joins the game.`);
  } else if (before.isCapture(mv)) {
    const cap = before.pieceAt(mv.to) || { type: PAWN, color: !mover };
    const recapture = before.moveStack.length > 0 && before.peek().to === mv.to;
    const g = see(before, mv);
    const verb = recapture ? 'recaptures' : 'captures';
    const tail = recapture ? '' : (g >= 2 ? ' and wins material' : (g >= 0 ? ' (an equal trade)' : ' (it gives up material: a sacrifice?)'));
    points.push(`${who} ${verb} the ${NAMES[cap.type]} on ${sq(mv.to)}${tail}.`);
  }
  if (mv.promotion) points.push(`${who} promotes to a ${NAMES[mv.promotion]}.`);
  if (board.isCheck()) points.push(`Check! ${SIDE[board.turn]} must respond to it first.`);

  const home = mover === WHITE ? 0 : 7;
  if (p && (p.type === KNIGHT || p.type === BISHOP) && squareRank(mv.from) === home && board.fullmoveNumber <= 15) {
    points.push(`Development: the ${NAMES[p.type]} comes into play.`);
  }
  // retreat / saving an attacked piece
  if (p && p.type !== PAWN && hangingPieces(before, mover).has(mv.from) && !before.isCapture(mv)) {
    points.push(`It rescues the attacked ${NAMES[p.type]}.`);
  }
  // defending something
  const saved = hangingPieces(before, mover).difference(new PySet([mv.from])).difference(hangingPieces(board, mover));
  if (saved.size && !before.isCapture(mv)) {
    points.push('It also defends the ' + [...saved].filter((s) => board.pieceAt(s)).map((s) => pieceDesc(board, s)).join(', ') + '.');
  }
  // pawn moves
  if (p && p.type === PAWN) {
    const hits = board.attacks(mv.to).filter((t) => { const q = board.pieceAt(t); return q && q.color !== mover && q.type === PAWN; });
    if (hits.length && !before.isCapture(mv)) points.push(`A pawn break: it challenges the pawn on ${sq(hits[0])} to open lines.`);
    if (CENTER.includes(mv.to)) points.push('It claims the centre.');
    const k = board.king(mover);
    if (k !== null && squareRank(k) === home && Math.abs(squareFile(mv.to) - squareFile(k)) <= 1 &&
        relRank(mv.to, mover) === 2 && [0, 1, 2, 5, 6, 7].includes(squareFile(mv.to))) {
      points.push('It makes luft: an escape square for the king against back-rank mates.');
    }
    if (pawnStructure(board, mover).passed.includes(mv.to)) points.push(`The ${sq(mv.to)} pawn is passed and heading for promotion.`);
    const tk = board.king(!mover);
    if (tk !== null && Math.abs(squareFile(mv.to) - squareFile(tk)) <= 1 && phase(board) === 'middlegame') {
      points.push(`A pawn storm: it advances towards ${SIDE[!mover]}'s king to open lines.`);
    }
  }
  if (p && p.type === ROOK) {
    const [full, half] = openFiles(board, mover);
    const f = FILE_NAMES[squareFile(mv.to)];
    if (full.includes(f)) points.push(`The rook seizes the open ${f}-file.`);
    else if (half.includes(f)) points.push(`The rook goes to the half-open ${f}-file to pressure it.`);
    if (relRank(mv.to, mover) === 6) points.push('A rook on the 7th rank: it attacks pawns and confines the king.');
  }
  if (p && p.type === KNIGHT && outposts(board, mover).includes(mv.to)) {
    points.push(`The knight lands on an outpost (${sq(mv.to)}): no pawn can chase it away.`);
  }
  if (p && MINOR_MAJOR.includes(p.type) && !before.isCapture(mv)) {
    const m0 = mobility(before, mv.from);
    const m1 = mobility(board, mv.to);
    if (m1 - m0 >= 4) points.push(`It activates the ${NAMES[p.type]} (from ${m0} to ${m1} useful squares).`);
    const same = board.attackers(!mover, mv.to).filter((a) => board.pieceAt(a).type === p.type);
    if (same.length && board.attackers(mover, mv.to).length) points.push(`It offers a trade of ${NAMES[p.type]}s.`);
  }
  // attacks created
  if (p) {
    const moved = board.pieceAt(mv.to);
    const targets = board.attacks(mv.to).filter((t) => {
      const q = board.pieceAt(t);
      return q && q.color !== mover && q.type !== KING && (VALUES[q.type] > VALUES[moved.type] || !board.attackers(q.color, t).length);
    });
    if (targets.length >= 2) points.push('Double attack on ' + targets.map((t) => pieceDesc(board, t)).join(' and ') + '.');
    else if (targets.length) points.push(`It attacks the ${pieceDesc(board, targets[0])}.`);
  }
  for (const s of SQUARES) {
    const q = board.pieceAt(s);
    if (q && q.color === mover && s !== mv.to && [BISHOP, ROOK, QUEEN].includes(q.type)) {
      const old = new Set(before.attacks(s));
      const fresh = board.attacks(s).filter((t) => !old.has(t)).filter((t) => {
        const x = board.pieceAt(t);
        return x && x.color !== mover && [QUEEN, ROOK, KING].includes(x.type);
      });
      if (fresh.length) {
        points.push(`Discovered: it opens a line for the ${pieceDesc(board, s)}, which now eyes the ${pieceDesc(board, fresh[0])}.`);
        break;
      }
    }
  }

  // what it intends: engine's view of the mover's next ideas (null move) + threat
  let threat = null;
  if (na === undefined) na = await nullAnalysis(board, engine, Math.floor(nodes / 2));
  if (na) {
    const nb = na.board, info = na.info;
    const tm = info.pv[0];
    const sNullMover = scoreOf(info, mover);
    if (baseScoreStm !== null && baseScoreStm !== undefined) {
      const gain = winPct(sNullMover) - winPct(-baseScoreStm);
      if (gain >= 15) {
        const tb = nb.copy(false);
        tb.push(tm);
        let consequence = '';
        const tg = forkTargets(tb, tm.to);
        if (tb.isCheckmate()) consequence = ': checkmate';
        else if (tg.length) consequence = ', forking your ' + tg.map((t) => pieceDesc(tb, t)).join(' and ');
        else if (nb.isCapture(tm) && see(nb, tm) >= 1) {
          const g = see(nb, tm);
          consequence = g === 1 ? ', winning a pawn' : `, winning material (about ${g} points)`;
        }
        threat = { uci: moveUci(tm), san: nb.san(tm), desc: describe(nb, tm) + consequence,
                   line: lineSan(nb, info.pv),
                   mate: sNullMover >= MATE - 500 ? mateIn(sNullMover) : null,
                   from: sq(tm.from), to: sq(tm.to) };
      }
    }
    const idea = planInWords(nb, info.pv, mover, 3);
    if (idea) intent.push(`${who}'s idea: ${idea}.`);
  }
  if (threat) {
    points.unshift(`**Threat:** ${who} wants ${threat.desc}` + (threat.mate ? `, leading to mate in ${threat.mate}` : '') +
                   ` (line: ${threat.line}).`);
  }
  if (!points.length) points.push(`A quiet improving move (${before.san(mv)}). No direct threat.`);
  return { san: before.san(mv), by: mover ? 'white' : 'black', points, intent, threat };
}

// =========================================================================== imbalances + goals

export function imbalances(board, pov) {
  const out = [];
  const me = pov, them = !pov;
  const add = (label, side, text) => out.push({ label, side: side === me ? 'you' : (side === them ? 'them' : 'both'), text });

  const diff = material(board, me) - material(board, them);
  if (diff) {
    const better = diff > 0 ? me : them;
    add('Material', better, `${SIDE[better]} is up about ${Math.abs(diff)} point${Math.abs(diff) !== 1 ? 's' : ''} of material.`);
  }
  for (const c of [me, them]) {
    if (board.pieces(BISHOP, c).length === 2 && board.pieces(BISHOP, !c).length < 2) {
      add('Bishop pair', c, `${SIDE[c]} has the bishop pair: it gets stronger as the position opens.`);
    }
  }
  const sMe = space(board, me), sThem = space(board, them);
  if (Math.abs(sMe - sThem) >= 4) {
    const c = sMe > sThem ? me : them;
    add('Space', c, `${SIDE[c]} has more space: easier to manoeuvre; the other side should look for pawn breaks to free itself.`);
  }
  for (const c of [me, them]) {
    for (const b of badBishops(board, c)) add('Bad bishop', !c, `${SIDE[c]}'s bishop on ${sq(b)} is hemmed in by its own pawns (a 'bad' bishop).`);
    const posts = outposts(board, c);
    const occupied = posts.filter((s) => board.hasPiece(s, KNIGHT, c));
    if (occupied.length) add('Outpost', c, `${SIDE[c]}'s knight on ${sq(occupied[0])} sits on an outpost: a monster piece that can't be chased.`);
    else if (posts.length && board.pieces(KNIGHT, c).length) add('Outpost', c, `${sq(posts[0])} is an outpost square for ${SIDE[c]}: a knight there would be very strong.`);
    for (const r of board.pieces(ROOK, c)) {
      if (relRank(r, c) === 6) { add('7th rank', c, `${SIDE[c]}'s rook on ${sq(r)} is on the 7th rank.`); break; }
    }
  }
  const [full] = openFiles(board, me);
  const heavy = (c) => [...board.pieces(ROOK, c), ...board.pieces(QUEEN, c)].sort((a, b) => a - b);
  for (const f of full) {
    const fi = FILE_NAMES.indexOf(f);
    const mine = heavy(me).filter((r) => squareFile(r) === fi);
    const theirs = heavy(them).filter((r) => squareFile(r) === fi);
    if (mine.length && !theirs.length) add('Open file', me, `You control the open ${f}-file.`);
    else if (theirs.length && !mine.length) add('Open file', them, `They control the open ${f}-file. Contest it.`);
    else if (!mine.length && !theirs.length) add('Open file', null, `The ${f}-file is open: the first rook to get there gains.`);
  }
  for (const c of [me, them]) {
    const ps = pawnStructure(board, c);
    if (ps.passed.length) {
      const s = pyMax(ps.passed, (x) => relRank(x, c));
      add('Passed pawn', c, `${SIDE[c]} has a passed pawn on ${sq(s)}.`);
    }
    if (ps.isolated.length && phase(board) !== 'opening') add('Weak pawn', !c, `${SIDE[c]}'s isolated pawn on ${sq(ps.isolated[0])} is a long-term weakness.`);
    if (ps.doubled.length && phase(board) !== 'opening') add('Doubled pawns', !c, `${SIDE[c]} has doubled pawns on the ${ps.doubled[0]}-file.`);
  }
  const wp = worstPiece(board, me);
  if (wp && phase(board) !== 'opening') add('Worst piece', them, `Your worst piece is the ${pieceDesc(board, wp[0])} (only ${wp[1]} useful squares). Improve it.`);
  const ksMe = kingSafety(board, me), ksThem = kingSafety(board, them);
  if (phase(board) !== 'endgame') {
    if (ksMe.in_center && board.fullmoveNumber >= 8) add('King safety', them, 'Your king is still in the centre.');
    if (ksThem.in_center && board.fullmoveNumber >= 8) add('King safety', me, 'Their king is still in the centre: open lines against it.');
    if (ksThem.castled && (ksThem.shield ?? 3) <= 1) add('King safety', me, `Their king on ${ksThem.square} has little pawn cover.`);
    if (ksMe.castled && (ksMe.shield ?? 3) <= 1) add('King safety', them, `Your king on ${ksMe.square} has little pawn cover.`);
  }
  const devMe = development(board, me), devThem = development(board, them);
  if (phase(board) === 'opening') {
    const lead = devThem.undeveloped.length - devMe.undeveloped.length;
    if (Math.abs(lead) >= 2) {
      const c = lead > 0 ? me : them;
      add('Development', c, `${SIDE[c]} is ahead in development: open the position and attack before the other side catches up.`);
    }
  }
  return out;
}

/** The one long-term goal that matters most for `pov`, with why and how. */
export function bigGoal(board, pov, evalPov, structure, imbs, enginePlan) {
  const w = winPct(evalPov);
  const ph = phase(board);
  const me = pov, them = !pov;
  const ksMe = kingSafety(board, me), ksThem = kingSafety(board, them);
  const dev = development(board, me);
  const howEngine = enginePlan ? [`Engine's plan for you: ${enginePlan}.`] : [];
  const structPlans = structure && structure.plans.has(me) ? structure.plans.get(me) : [];

  if (Math.abs(evalPov) >= MATE - 500) {
    if (evalPov > 0) return { title: 'Deliver mate', why: "There's a forced mate on the board.", how: ['Look at every check first, then every capture.', ...howEngine] };
    return { title: 'Survive', why: "The opponent has a forced mate if you're not careful.", how: ['Find the defence that stops the mate: every check, block and capture.'] };
  }
  if (w >= 85) {
    return { title: 'Convert the win safely', why: `You're ${evalWords(w)}. Now the only way to lose is carelessness.`,
             how: ['Trade pieces (not pawns): every trade makes your extra material count more.',
                   'Take away counterplay: cover your back rank, keep your king safe, stop their passed pawns.',
                   "Before every move: their checks, captures and threats. Don't grab material that opens your king.",
                   ...howEngine] };
  }
  if (w <= 15 && ph === 'endgame') {
    return { title: 'Fight for the draw', why: `You're ${evalWords(w)}, but endgames are full of drawing chances.`,
             how: ['Activate everything: passive rooks lose rook endgames. Attack their pawns from behind or the side.',
                   'Bring your king in front of their passed pawn.',
                   'Trade pawns, not pieces: fewer pawns means more drawing chances (R vs R+P is often a draw).',
                   ...howEngine] };
  }
  if (w <= 15) {
    return { title: 'Create maximum trouble', why: `You're ${evalWords(w)}: passive defence loses slowly.`,
             how: ['Keep pieces on the board and set concrete problems (threats, checks, traps).',
                   'Aim at their king, or create a passed pawn: give them chances to go wrong.', ...howEngine] };
  }
  if ((ksMe.attackers ?? 0) >= 3 && ph !== 'endgame') {
    return { title: 'Secure your king first', why: `${ksMe.attackers} enemy pieces are aimed at your king.`,
             how: ['Bring a defender back (knight to f3/f6 is a great defender), trade their most dangerous attacker.',
                   "Don't open the pawns in front of your king.", ...howEngine] };
  }
  const needsCastle = !ksMe.castled && dev.can_castle;
  let devBullets = [];
  if (dev.undeveloped.length || needsCastle) {
    const parts = [];
    if (dev.undeveloped.length) parts.push('develop the ' + dev.undeveloped.map((s) => NAMES[board.pieceAt(s).type] + ' on ' + sq(s)).join(', '));
    if (needsCastle) parts.push('castle');
    devBullets = ['First ' + parts.join(' and ') + '.'];
  }
  if (ph === 'opening' && (dev.undeveloped.length >= 2 || (needsCastle && !structure))) {
    const pieces = dev.undeveloped.map((s) => NAMES[board.pieceAt(s).type] + ' on ' + sq(s)).join(', ');
    const how = [];
    if (dev.undeveloped.length) how.push(`Develop the rest: ${pieces}. Knights before bishops; no piece moves twice without a reason.`);
    if (!ksMe.castled && dev.can_castle) how.push('Castle. King safety first, then connect your rooks.');
    how.push('Fight for the centre (e4/d4/e5/d5) with pawns and pieces.');
    return { title: 'Finish development and castle', why: 'In the opening, time is the key resource.', how: [...how, ...howEngine] };
  }
  if (ksThem.in_center && ph !== 'endgame' && board.fullmoveNumber >= 8 && !ksMe.in_center) {
    return { title: 'Punish the king in the centre', why: "Their king hasn't castled. Open lines are deadly for it.",
             how: ['Open the centre (pawn breaks on d/e, even with a pawn sacrifice).',
                   'Put rooks on the e- and d-files and aim every piece at the king.', ...howEngine] };
  }
  if (ph === 'endgame') {
    const how = ["Activate your king: in the endgame it's a fighting piece. March it to the centre or towards the pawns."];
    const ps = pawnStructure(board, me);
    if (ps.passed.length) {
      const s = pyMax(ps.passed, (x) => relRank(x, me));
      how.push(`Push your passed pawn on ${sq(s)} with support; rooks belong behind passed pawns.`);
    } else how.push('Create a passed pawn: use your pawn majority on one wing.');
    how.push('Put your rook on the most active square (open file, 7th rank, behind a passed pawn).');
    return { title: 'Win the endgame with king and pawns', why: 'With few pieces left, king activity and passed pawns decide.', how: [...how, ...howEngine] };
  }
  if (structure) return { title: structure.name, why: 'The pawn structure tells you where to play.', how: [...devBullets, ...structPlans, ...howEngine] };
  const mine = imbs.filter((i) => i.side === 'you');
  if (mine.length) {
    const top = mine[0];
    return { title: `Use your edge: ${top.label.toLowerCase()}`, why: top.text,
             how: [...devBullets, "Make your advantage permanent and play where you're stronger.",
                   'Improve your worst piece before starting action.', ...howEngine] };
  }
  return { title: 'Improve your pieces', why: 'No clear imbalance yet: the side with better pieces wins the middlegame.',
           how: [...devBullets, 'Find your worst piece and give it a better square.', 'Put rooks on open or half-open files.',
                 'Prepare a pawn break that opens lines for your pieces.', ...howEngine] };
}

// =========================================================================== entry point

export async function insightBoard(board, engine, { pov = null, nodes = DEFAULT_NODES.insight, nullNodes = DEFAULT_NODES.nullMove,
                                                    optionsNodes = DEFAULT_NODES.options, optionsMaxNodes = DEFAULT_NODES.optionsMax } = {}) {
  pov = pov === null || pov === undefined ? board.turn : pov;
  const them = !pov;
  const infos = !board.isGameOver() ? await analyseBoard(engine, board, { nodes, multipv: 3 }) : [];
  const best = infos.length ? infos[0] : null;
  const second = infos.length > 1 ? infos[1] : null;
  const evalPov = best ? scoreOf(best, pov) : 0;
  const w = winPct(evalPov);
  const baseStm = best ? scoreOf(best, board.turn) : null;

  // engine plan in words for both sides: the side to move from the main line, the other side via a null move
  let myPlan = '', theirPlan = '';
  const na = await nullAnalysis(board, engine, nullNodes);
  if (best && best.pv.length) {
    if (board.turn === pov) myPlan = planInWords(board, best.pv, pov);
    else theirPlan = planInWords(board, best.pv, them);
  }
  if (na) {
    if (board.turn === pov) theirPlan = planInWords(na.board, na.info.pv, them);
    else myPlan = planInWords(na.board, na.info.pv, pov);
  }

  const structure = classifyStructure(board);
  const imbs = imbalances(board, pov);
  const goal = bigGoal(board, pov, evalPov, structure, imbs, myPlan);
  const oppGoal = bigGoal(board, them, -evalPov, structure, imbalances(board, them), theirPlan);
  const look = tacticalScan(board, pov, best, second);
  const last = await lastMoveInsight(board, engine, nodes, baseStm, na);
  if (last && last.threat && board.turn === pov) {
    const t = last.threat;
    look.unshift({ kind: 'threat', priority: 0,
                   text: `Their threat: ${t.desc}` + (t.mate ? ` (mate in ${t.mate})` : '') + `. Line: ${t.line}.`,
                   hint: `Their last move created a threat: ${t.desc}.`,
                   squares: [t.to], arrows: [[t.from, t.to]], reveals: false });
  }

  const ph = phase(board);
  const urgent = look.find((x) => ['mate', 'threat', 'hanging_mine'].includes(x.kind) && x.priority <= 1);
  const youEdge = imbs.filter((i) => i.side === 'you');
  const theirEdge = imbs.filter((i) => i.side === 'them');
  let headline = `${ph[0].toUpperCase() + ph.slice(1)}: you're ${evalWords(w)} (${fmt0(w)}% win chance).`;
  if (structure) headline += ` Structure: ${structure.name}.`;
  if (youEdge.length || theirEdge.length) {
    const bits = [];
    if (youEdge.length) bits.push('your trumps: ' + youEdge.slice(0, 3).map((i) => i.label.toLowerCase()).join(', '));
    if (theirEdge.length) bits.push('their trumps: ' + theirEdge.slice(0, 3).map((i) => i.label.toLowerCase()).join(', '));
    const text = bits.join('; ');
    headline += ' ' + text[0].toUpperCase() + text.slice(1) + '.';
  }
  if (urgent && board.turn === pov) headline += ' ⚠ First deal with the urgent issue below.';

  const options = await buildOptions(board, engine, pov, best, second, evalPov, {
    threat: board.turn === pov ? (last || {}).threat ?? null : null, nodes: optionsNodes, maxNodes: optionsMaxNodes,
  });

  const candidates = [];
  for (const i of infos) {
    const pv = i.pv || [];
    if (pv.length) {
      candidates.push({ san: board.san(pv[0]), uci: moveUci(pv[0]), desc: describe(board, pv[0]),
                        eval_pov: scoreOf(i, pov), line: lineSan(board, pv, 6),
                        plan: planInWords(board, pv, board.turn, 3) });
    }
  }

  // back-compat lists
  const watchOut = look.filter((x) => ['threat', 'hanging_mine', 'pinned_mine', 'back_rank', 'king_danger', 'fork_alert', 'loose_mine'].includes(x.kind))
    .map((x) => x.text);
  const plan = [goal.why, ...goal.how];
  const ps = pawnStructure(board, pov);
  return {
    fen: board.fen(), pov: pov ? 'white' : 'black', to_move: board.turn ? 'white' : 'black',
    phase: ph, eval_pov: evalPov, win_pov: pyRound(w, 1), verdict: evalWords(w),
    headline,
    options,
    big_goal: goal, opponent_goal: oppGoal,
    look_now: look,
    last_move: last,
    structure: structure ? { name: structure.name, you: structure.plans.get(pov) || [], them: structure.plans.get(them) || [] } : null,
    imbalances: imbs,
    engine_plan: { you: myPlan, them: theirPlan },
    candidates,
    watch_out: watchOut, plan,
    king_safety: { me: kingSafety(board, pov), opponent: kingSafety(board, them) },
    pawns: { isolated: ps.isolated.map(sq), doubled: ps.doubled, passed: ps.passed.map(sq), backward: ps.backward.map(sq) },
  };
}

export async function insight(engine, { fen = 'startpos', moves = [], pov = null, ...opts } = {}) {
  const board = boardFrom(fen, moves);
  const p = pov === null || pov === undefined ? null : (pov === true || pov === 'white');
  return insightBoard(board, engine, { pov: p, ...opts });
}

export { Board, sameMove };
