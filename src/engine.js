// Stockfish 19 (lite, single-threaded WASM; no SharedArrayBuffer needed) behind a small promise API.
//
//   const engine = await createEngine();                       // browser: Web Worker; node: same build in-process
//   const lines = await engine.analyse(fen, { moves, nodes, multipv, searchmoves });
//   const uci = await engine.bestMove(fen, { moves, elo, movetime });
//   engine.cancel();                                           // stop the running search, drop queued ones
//
// Scores are from the side-to-move's point of view ({cp} or {mate}); `scoreOf()` converts them like python-chess's
// `score.pov(color).score(mate_score=10000)`.

export const MATE = 10_000;

/** Node budgets tuned for a phone-class single thread (Stockfish lite runs ~0.7 Mnps on an M-series core in node,
 *  roughly 2-3x slower on an iPhone). */
export const DEFAULT_NODES = {
  explain: 250_000,      // explainMove: position before (multipv 2) + after
  threat: 120_000,       // explainMove: null-move threat search
  insight: 250_000,      // insight: main multipv-3 search
  nullMove: 120_000,     // insight: null-move search (their threat / plan)
  options: 150_000,      // insight: options root search (scaled by #candidates / 4, capped)
  optionsMax: 450_000,
  game: 120_000,         // analyseGame per position (multipv 2)
};

const DEFAULT_WORKER_PATH = '../vendor/stockfish/stockfish-19-lite-single.js';
const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';

/** python-chess `PovScore.pov(color).score(mate_score=10000)`; `povIsSideToMove` false flips the sign. */
export function scoreOf(info, povIsSideToMove = true) {
  const sc = info && info.score ? info.score : info;
  let v;
  if (sc == null) return 0;
  if (sc.mate !== undefined && sc.mate !== null) {
    const m = sc.mate;
    v = m > 0 ? MATE - m : -MATE - m; // Mate(0) (being mated) -> -10000
  } else v = sc.cp;
  return povIsSideToMove ? v : -v;
}

function sideToMove(fen, nMoves) {
  const parts = (fen === 'startpos' || !fen ? 'x w' : fen).split(/\s+/);
  const w = (parts[1] || 'w') === 'w';
  return nMoves % 2 === 0 ? w : !w;
}

/** Parse one UCI `info` line into python-chess-like fields (only what we need). */
export function parseInfo(line) {
  const tok = line.trim().split(/\s+/);
  if (tok[0] !== 'info') return null;
  const info = {};
  for (let i = 1; i < tok.length; i++) {
    const t = tok[i];
    if (t === 'string') break;
    if (['depth', 'seldepth', 'nodes', 'multipv', 'currmovenumber', 'hashfull', 'nps', 'tbhits', 'cpuload', 'time'].includes(t)) {
      info[t] = parseInt(tok[++i], 10);
    } else if (t === 'score') {
      const kind = tok[++i], value = parseInt(tok[++i], 10);
      if (tok[i + 1] === 'lowerbound' || tok[i + 1] === 'upperbound') info[tok[++i]] = true;
      info.score = kind === 'mate' ? { mate: value } : { cp: value };
    } else if (t === 'currmove') {
      info.currmove = tok[++i];
    } else if (t === 'wdl') {
      i += 3;
    } else if (t === 'pv') {
      info.pv = tok.slice(i + 1);
      break;
    } else if (t === 'refutation' || t === 'currline') {
      break;
    }
  }
  return info;
}

async function nodeBackend() {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const path = require.resolve(DEFAULT_WORKER_PATH);
  delete require.cache[path]; // the emscripten node glue keeps per-module state: one instance per load
  const factory = require(path);
  const eng = factory();
  let onLine = () => {};
  eng.listener = (line) => { if (process.env.SF_DEBUG) console.error("SF", String(line).slice(0, 100)); onLine(String(line)); };
  return {
    send: (cmd) => eng.processCommand(cmd),
    onLine: (fn) => { onLine = fn; },
    terminate: () => { onLine = () => {}; eng.listener = () => {}; },
  };
}

function workerBackend(workerUrl) {
  const url = workerUrl || new URL(DEFAULT_WORKER_PATH, import.meta.url).href;
  const worker = new Worker(url);
  let onLine = () => {};
  worker.onmessage = (ev) => { if (typeof ev.data === 'string') onLine(ev.data); };
  worker.onerror = (ev) => { onLine(`error ${ev.message || ev}`); };
  return {
    send: (cmd) => worker.postMessage(cmd),
    onLine: (fn) => { onLine = fn; },
    terminate: () => worker.terminate(),
  };
}

class AbortError extends Error {
  constructor(msg = 'search cancelled') { super(msg); this.name = 'AbortError'; }
}

export async function createEngine({ workerUrl, hash = 32, initTimeout = 30_000 } = {}) {
  const backend = isNode && !workerUrl ? await nodeBackend() : workerBackend(workerUrl);
  let waiter = null;      // {match: (line) => bool, resolve}
  let current = null;     // running job {onLine, resolve, reject, cancelled}
  const queue = [];
  let busy = false;
  let limited = false;    // UCI_LimitStrength currently on
  let multipv = 1;
  // node: WebAssembly compilation doesn't keep the event loop alive; hold a timer while we wait for the engine
  let keep = null;
  const hold = () => { if (isNode && !keep) keep = setInterval(() => {}, 1 << 30); };
  const release = () => { if (keep && !busy && !queue.length && !waiter) { clearInterval(keep); keep = null; } };

  backend.onLine((line) => {
    if (current) current.onLine(line);
    if (waiter && waiter.match(line)) { const w = waiter; waiter = null; w.resolve(line); }
  });
  const expect = (match) => new Promise((resolve) => { hold(); waiter = { match, resolve }; }).then((l) => { release(); return l; });

  // register the waiter before sending: once loaded, the engine may answer synchronously
  let ready = expect((l) => l.startsWith('uciok'));
  backend.send('uci');
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Stockfish failed to start')), initTimeout); });
  try { await Promise.race([ready, timeout]); } catch (e) { waiter = null; release(); backend.terminate(); throw e; }
  finally { clearTimeout(timer); }
  backend.send(`setoption name Hash value ${hash}`);
  ready = expect((l) => l.startsWith('readyok'));
  backend.send('isready');
  await ready;

  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    current = job;
    hold();
    job.start();
  }
  function finish(job) {
    if (current === job) current = null;
    busy = false;
    // defer: never re-enter the engine from inside its own output callback
    setTimeout(() => { pump(); release(); }, 0);
  }

  function search({ setup, go, collect }) {
    return new Promise((resolve, reject) => {
      const job = { cancelled: false, reject };
      job.onLine = (line) => {
        if (line.startsWith('bestmove')) {
          const result = collect.done(line);
          finish(job);
          if (job.cancelled) reject(new AbortError());
          else resolve(result);
        } else collect.line(line);
      };
      job.start = () => {
        if (job.cancelled) { finish(job); reject(new AbortError()); return; }
        for (const c of setup) backend.send(c);
        backend.send(go);
      };
      queue.push(job);
      pump();
    });
  }

  function positionCmd(fen, moves) {
    const base = !fen || fen === 'startpos' ? 'position startpos' : `position fen ${fen}`;
    return moves && moves.length ? `${base} moves ${moves.join(' ')}` : base;
  }

  const api = {
    MATE,
    DEFAULT_NODES,
    /** Search `fen` (+ moves). Resolves to multipv lines sorted by index: {score, pv, depth, multipv, nodes, turn}. */
    analyse(fen, { moves = [], nodes = 300_000, multipv: mpv = 1, searchmoves = null } = {}) {
      const turn = sideToMove(fen, moves.length);
      const lines = [];
      const setup = [];
      if (limited) { setup.push('setoption name UCI_LimitStrength value false'); limited = false; }
      if (mpv !== multipv) { setup.push(`setoption name MultiPV value ${mpv}`); multipv = mpv; }
      setup.push(positionCmd(fen, moves));
      const sm = searchmoves && searchmoves.length ? ` searchmoves ${searchmoves.join(' ')}` : '';
      return search({
        setup,
        go: `go nodes ${Math.max(1, Math.floor(nodes))}${sm}`,
        collect: {
          line(l) {
            if (!l.startsWith('info')) return;
            const info = parseInfo(l);
            if (!info || (info.score === undefined && info.pv === undefined)) return;
            const k = (info.multipv || 1) - 1;
            while (lines.length <= k) lines.push({});
            Object.assign(lines[k], info); // python-chess merges successive info lines per multipv slot
          },
          done() {
            return lines.filter((x) => x.score !== undefined).map((x, i) => ({
              score: x.score, pv: x.pv || [], depth: x.depth ?? 0, seldepth: x.seldepth, multipv: x.multipv || i + 1,
              nodes: x.nodes, turn, lowerbound: x.lowerbound, upperbound: x.upperbound,
            }));
          },
        },
      });
    },
    /** Sparring move at a limited strength (UCI_Elo clamped to 1320..3190). */
    bestMove(fen, { moves = [], elo = 1500, movetime = 400 } = {}) {
      const e = Math.max(1320, Math.min(3190, Math.floor(elo)));
      const setup = [];
      if (multipv !== 1) { setup.push('setoption name MultiPV value 1'); multipv = 1; }
      setup.push('setoption name UCI_LimitStrength value true', `setoption name UCI_Elo value ${e}`);
      limited = true;
      setup.push(positionCmd(fen, moves));
      return search({
        setup,
        go: `go movetime ${Math.max(10, Math.floor(movetime))}`,
        collect: { line() {}, done: (l) => { const m = l.split(/\s+/)[1]; return m && m !== '(none)' ? m : null; } },
      });
    },
    /** Stop the running search and drop everything queued. Their promises reject with an AbortError. */
    cancel() {
      while (queue.length) { const j = queue.shift(); j.cancelled = true; j.reject(new AbortError()); }
      if (current) { current.cancelled = true; backend.send('stop'); }
    },
    /** Stop only the running search (queued requests still run). */
    stop() {
      if (current) { current.cancelled = true; backend.send('stop'); }
    },
    get busy() { return busy || queue.length > 0; },
    newGame() { queue.push({ cancelled: false, reject() {}, onLine() {}, start() { backend.send('ucinewgame'); finish(this); } }); pump(); },
    terminate() { api.cancel(); backend.terminate(); },
    scoreOf,
  };
  return api;
}
