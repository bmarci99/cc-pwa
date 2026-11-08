// TEMPORARY stand-in for mobile/src/engine.js + mobile/src/coach/index.js (the on-device coach port).
// Same exported contract, minimal behaviour: a real Stockfish worker for analyse/bestMove, rule-correct positions
// via chess.js, but no coaching (every move is "good", no Coach's view). Switch in js/impl.js.
import { Chess } from '../vendor/chess.js/chess.js';

export const IS_STUB = true;
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function boardFrom(fen, moves = []) {
  const c = new Chess(!fen || fen === 'startpos' ? START : fen);
  for (const u of moves || []) {
    const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
    if (!mv) throw new Error(`illegal move ${u}`);
  }
  return c;
}
const uciOf = (m) => m.from + m.to + (m.promotion || '');

export function positionJson(fen, moves = []) {
  const c = boardFrom(fen, moves);
  let result = null, reason = null;
  if (c.isCheckmate()) { result = c.turn() === 'w' ? '0-1' : '1-0'; reason = 'checkmate'; } else if (c.isStalemate()) { result = '1/2-1/2'; reason = 'stalemate'; } else if (c.isInsufficientMaterial()) { result = '1/2-1/2'; reason = 'insufficient material'; } else if (c.isThreefoldRepetition()) { result = '1/2-1/2'; reason = 'threefold repetition'; } else if (c.isDrawByFiftyMoves?.()) { result = '1/2-1/2'; reason = '50-move rule'; }
  const hist = c.history({ verbose: true });
  return {
    fen: c.fen(), turn: c.turn() === 'w' ? 'white' : 'black',
    legal: result ? [] : c.moves({ verbose: true }).map(uciOf), check: c.inCheck(),
    game_over: !!result, result, reason, last_move: hist.length ? uciOf(hist[hist.length - 1]) : null,
  };
}

// ------------------------------------------------------------------ engine (plain UCI over a Web Worker)

export function createEngine({ workerUrl }) {
  let worker = null, listener = null, chain = Promise.resolve();
  const send = (cmd) => worker.postMessage(cmd);
  const waitFor = (pred, collect) => new Promise((resolve) => {
    listener = (line) => { collect?.(line); if (pred(line)) { listener = null; resolve(); } };
  });
  async function boot() {
    if (worker) return;
    worker = new Worker(workerUrl);
    worker.onmessage = (e) => listener?.(String(e.data));
    const ok = waitFor((l) => l === 'uciok'); send('uci'); await ok;
    const rd = waitFor((l) => l === 'readyok'); send('isready'); await rd;
  }
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const posCmd = (fen, moves) => `position ${!fen || fen === 'startpos' ? 'startpos' : 'fen ' + fen}${moves?.length ? ' moves ' + moves.join(' ') : ''}`;

  return {
    analyse(fen, { moves = [], nodes = 200000, multipv = 1, searchmoves = null } = {}) {
      return serial(async () => {
        await boot();
        const lines = {};
        send('setoption name UCI_LimitStrength value false');
        send(`setoption name MultiPV value ${multipv}`);
        send(posCmd(fen, moves));
        const done = waitFor((l) => l.startsWith('bestmove'), (l) => {
          if (!l.startsWith('info') || !l.includes(' pv ')) return;
          const k = +(l.match(/ multipv (\d+)/)?.[1] || 1);
          const cp = l.match(/ score cp (-?\d+)/), mate = l.match(/ score mate (-?\d+)/);
          lines[k] = { multipv: k, score: { cp: cp ? +cp[1] : null, mate: mate ? +mate[1] : null }, pv: l.split(' pv ')[1].trim().split(/\s+/) };
        });
        send(`go nodes ${nodes}${searchmoves?.length ? ' searchmoves ' + searchmoves.join(' ') : ''}`);
        await done;
        return Object.keys(lines).sort((a, b) => a - b).map((k) => lines[k]);
      });
    },
    bestMove(fen, { moves = [], elo = null, movetime = 400 } = {}) {
      return serial(async () => {
        await boot();
        let best = null;
        send('setoption name MultiPV value 1');
        send(`setoption name UCI_LimitStrength value ${elo ? 'true' : 'false'}`);
        if (elo) send(`setoption name UCI_Elo value ${Math.max(1320, Math.min(3190, elo))}`);
        send(posCmd(fen, moves));
        const done = waitFor((l) => l.startsWith('bestmove'), (l) => { if (l.startsWith('bestmove')) best = l.split(/\s+/)[1]; });
        send(`go movetime ${movetime}`);
        await done;
        return best && best !== '(none)' ? best : null;
      });
    },
    cancel() { if (worker) send('stop'); },
    terminate() { worker?.terminate(); worker = null; },
  };
}

// ------------------------------------------------------------------ coach (no real coaching yet)

export async function explainMove(engine, { fen, moves = [], uci }) {
  const c = boardFrom(fen, moves);
  const fenBefore = c.fen();
  const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
  return {
    played: uci, played_san: mv.san, classification: 'good', best: uci, best_san: mv.san, best_line: '',
    refutation_line: '', refutation_uci: [], best_line_uci: [], eval_before: 0, eval_after: 0,
    win_before: 50, win_after: 50, win_drop: 0, threat: null, motifs: [],
    facts: ['On-device coach not installed yet (stub build).'], tip: '', fen_before: fenBefore, fen_after: c.fen(),
  };
}

export async function isCorrectSolution(engine, { fen, moves = [], uci, bestUci }) {
  const info = await explainMove(engine, { fen, moves, uci });
  const correct = uci === bestUci || (uci.length === 4 && uci + 'q' === bestUci);
  if (!correct) {
    const c = boardFrom(fen, moves);
    const b = c.move({ from: bestUci.slice(0, 2), to: bestUci.slice(2, 4), promotion: bestUci[4] || undefined });
    Object.assign(info, { classification: 'mistake', best: bestUci, best_san: b?.san || bestUci, motifs: ['positional'] });
  } else info.classification = 'best';
  return { correct, info };
}

export async function insight() {
  const e = new Error('Coach’s view needs the on-device coach (not in this build yet).');
  e.status = 503;
  throw e;
}

export async function analyseGame(engine, { pgn, startFen, moves, myColor = 'white', onProgress }) {
  const c = new Chess();
  let ucis = moves;
  if (pgn) {
    c.loadPgn(pgn);
    ucis = c.history({ verbose: true }).map(uciOf);
    const hdr = c.getHeaders?.() || c.header?.() || {};
    startFen = hdr.FEN || START;
  }
  const b = boardFrom(startFen, []);
  const rows = [];
  for (let i = 0; i < ucis.length; i++) {
    const fenBefore = b.fen();
    const mover = b.turn() === 'w' ? 'white' : 'black';
    const mv = b.move({ from: ucis[i].slice(0, 2), to: ucis[i].slice(2, 4), promotion: ucis[i][4] || undefined });
    rows.push({
      ply: i + 1, move_no: +fenBefore.split(' ')[5], is_mine: mover === myColor ? 1 : 0, san: mv.san, uci: ucis[i],
      fen_before: fenBefore, best_uci: ucis[i], best_san: mv.san, pv: '', eval_before: 0, eval_after: 0, cp_loss: 0,
      win_before: 50, win_after: 50, win_drop: 0, classification: 'good', second_gap: 0, sacrificed: 0,
      phase: i < 24 ? 'opening' : 'middlegame', clock: null, time_spent: null,
    });
    onProgress?.(i + 1, ucis.length);
  }
  return rows;
}
