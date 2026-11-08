// Local API: a window.fetch shim that answers every /api/* call of the desktop frontend on the phone itself,
// with the same request/response shapes as chess_analyzer/server.py. Engine + coach run on-device (see impl.js).
import { Chess } from '../vendor/chess.js/chess.js';
import * as coach from './impl.js';

const DAY = 86400;
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Phone-sized search budgets (the Mac uses 500k-800k nodes).
export const NODES = { explain: 250_000, check: 150_000, analyse: 300_000, puzzle: 250_000, game: 100_000, sync: 60_000 };
const ME_FALLBACK = 'Me';

class HttpError extends Error { constructor(status, detail) { super(detail); this.status = status; } }

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const nowS = () => Date.now() / 1000;
const uciOf = (m) => m.from + m.to + (m.promotion || '');

// ------------------------------------------------------------------ board helpers (server.board_from / parse_move)

function boardFrom(fen, moves = []) {
  try {
    const c = new Chess(!fen || fen === 'startpos' ? START : fen);
    for (const u of moves || []) {
      if (!c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined })) throw new Error(`illegal move ${u}`);
    }
    return c;
  } catch (e) {
    throw new HttpError(400, `Bad position/move: ${e.message || e}`);
  }
}

/** Legal UCI for `uci` in `c` (auto-queen when the promotion suffix is missing), else 400. */
function parseMove(c, uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci || '')) throw new HttpError(400, `Bad move ${uci}`);
  const legal = c.moves({ verbose: true }).map(uciOf);
  if (legal.includes(uci)) return uci;
  if (uci.length === 4 && legal.includes(uci + 'q')) return uci + 'q';
  throw new HttpError(400, `Illegal move ${uci}`);
}

function positionJson(fen, moves = []) {
  try { return coach.positionJson(fen, moves); } catch (e) { throw new HttpError(400, `Bad position/move: ${e.message || e}`); }
}

/** Normalise engine output (array of {score:{cp,mate}|cp/mate, pv:[uci]|"uci ..."}) into side-to-move POV lines. */
function normInfos(r) {
  const arr = Array.isArray(r) ? r : (r?.lines || r?.infos || (r ? [r] : []));
  return arr.map((i) => {
    const s = i.score ?? i;
    const pv = Array.isArray(i.pv) ? i.pv : typeof i.pv === 'string' ? i.pv.split(/\s+/).filter(Boolean) : (i.uci || []);
    return { cp: s.cp ?? null, mate: s.mate ?? null, pv };
  });
}

function sanLine(fen, ucis) {
  const c = new Chess(fen);
  const out = [];
  for (const u of ucis) {
    const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
    if (!mv) break;
    out.push(mv);
  }
  // python-chess variation_san format: "1. e4 e5 2. Nf3" / "3... Nc6 4. Bb5"
  const startNo = +fen.split(' ')[5], blackFirst = fen.split(' ')[1] === 'b';
  return out.map((m, i) => {
    const ply = i + (blackFirst ? 1 : 0);
    const no = startNo + Math.floor(ply / 2);
    if (ply % 2 === 0) return `${no}. ${m.san}`;
    return i === 0 ? `${no}... ${m.san}` : m.san;
  }).join(' ');
}

// ------------------------------------------------------------------ PGN (same layout as python-chess str(game))

function clk(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const sec = s - h * 3600 - m * 60;
  const whole = Math.floor(sec);
  let frac = (Math.round((sec - whole) * 1000) / 1000).toString().replace(/^0/, '');
  if (frac === '0' || frac === '') frac = '';
  return `${h}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}${frac}`;
}

function buildPgn({ fen, moves, clocks, headers }) {
  const startFen = !fen || fen === 'startpos' || fen === START ? null : fen;
  const c = new Chess(startFen || START);
  const tags = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
  const h = { Round: '?', ...headers };
  let out = tags.map((t) => `[${t} "${h[t] ?? '?'}"]`);
  if (startFen) out.push(`[FEN "${startFen}"]`, '[SetUp "1"]');
  for (const [k, v] of Object.entries(h)) if (!tags.includes(k)) out.push(`[${k} "${v}"]`);
  const toks = [];
  const startNo = +(startFen || START).split(' ')[5];
  const blackFirst = (startFen || START).split(' ')[1] === 'b';
  moves.forEach((u, i) => {
    const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
    const ply = i + (blackFirst ? 1 : 0);
    const no = startNo + Math.floor(ply / 2);
    const needNo = ply % 2 === 0 || i === 0 || (i > 0 && clocks[i - 1] != null);
    toks.push(needNo ? (ply % 2 === 0 ? `${no}. ${mv.san}` : `${no}... ${mv.san}`) : mv.san);
    if (clocks[i] != null) toks.push(`{ [%clk ${clk(clocks[i])}] }`);
  });
  toks.push(h.Result || '*');
  const lines = [];
  let cur = '';
  for (const t of toks.join(' ').split(' ')) {
    if (cur && cur.length + 1 + t.length > 79) { lines.push(cur); cur = t; } else cur = cur ? cur + ' ' + t : t;
  }
  if (cur) lines.push(cur);
  return out.join('\n') + '\n\n' + lines.join('\n');
}

// ------------------------------------------------------------------ the API

export class LocalApi {
  constructor(data, { workerUrl }) {
    this.data = data;
    this.workerUrl = workerUrl;
    this._engine = null;
    this._bg = null;
    this.analysis = { running: false, current: null, done: 0, ply: 0, plies: 0 };
    this.routes = [
      ['POST', /^position$/, (b) => positionJson(b.fen ?? 'startpos', b.moves || [])],
      ['POST', /^explain$/, (b) => this.explain(b)],
      ['POST', /^analyse$/, (b) => this.analyse(b)],
      ['POST', /^insight$/, (b) => this.insight(b)],
      ['GET', /^dashboard$/, () => this.dashboard()],
      ['GET', /^mobile$/, () => { throw new HttpError(403, 'Only available on the Mac'); }],
      ['GET', /^puzzles\/next$/, (_, q) => this.puzzleNext(q.get('kind') || 'any')],
      ['GET', /^puzzles\/stats$/, () => this.puzzleStats()],
      ['POST', /^puzzles\/(\d+)\/attempt$/, (b, q, m) => this.puzzleAttempt(+m[1], b)],
      ['POST', /^play\/engine_move$/, (b) => this.engineMove(b)],
      ['POST', /^play\/check$/, (b) => this.playCheck(b)],
      ['POST', /^play\/save$/, (b) => this.saveGame(b)],
      ['GET', /^play\/start_positions$/, () => this.startPositions()],
      ['GET', /^games$/, (_, q) => this.gamesList(q)],
      ['GET', /^games\/([^/]+)$/, (_, q, m) => this.gameDetail(decodeURIComponent(m[1]))],
      ['GET', /^drills$/, () => this.drills()],
      ['GET', /^drills\/([^/]+)$/, (_, q, m) => this.drill(decodeURIComponent(m[1]))],
      ['POST', /^drills\/([^/]+)\/result$/, (b, q, m) => this.drillResult(decodeURIComponent(m[1]), b)],
      ['POST', /^coach\/ask$/, () => { throw new HttpError(503, 'Ask Coach needs the internet and an API key on your Mac — not available in the offline iPhone app.'); }],
      ['GET', /^random_puzzle_fen$/, () => this.randomFen()],
    ];
  }

  /** Interactive engine (createEngine may be async: cache the promise; retry after a failed start). */
  eng() {
    this._engine ||= Promise.resolve(coach.createEngine({ workerUrl: this.workerUrl })).catch((e) => { this._engine = null; throw e; });
    return this._engine;
  }
  /** Separate engine for background game analysis, so live play/puzzles never wait behind it. */
  bgEng() {
    this._bg ||= Promise.resolve(coach.createEngine({ workerUrl: this.workerUrl })).catch((e) => { this._bg = null; throw e; });
    return this._bg;
  }

  async handle(method, path, query, body) {
    for (const [m, re, fn] of this.routes) {
      const mm = path.match(re);
      if (mm && m === method) return fn(body || {}, query, mm);
    }
    throw new HttpError(path.match(/^(position|explain|analyse|insight|puzzles|play|drills|coach)/) ? 405 : 404, 'Not Found');
  }

  // -------------------------------------------------------------- coach / engine
  async explain(b) {
    const c = boardFrom(b.fen, b.moves);
    const uci = parseMove(c, b.uci);
    return coach.explainMove(await this.eng(), { fen: b.fen ?? 'startpos', moves: b.moves || [], uci, nodes: Math.min(b.nodes || NODES.explain, NODES.explain) });
  }

  async analyse(b) {
    const c = boardFrom(b.fen, b.moves);
    const fen = c.fen();
    const infos = normInfos(await (await this.eng()).analyse(b.fen ?? 'startpos', { moves: b.moves || [], nodes: NODES.analyse, multipv: 3 }));
    const whiteToMove = c.turn() === 'w';
    return {
      lines: infos.map((i) => {
        const cpStm = i.mate != null ? (i.mate > 0 ? 10000 - i.mate : -10000 - i.mate) : i.cp;
        const sign = whiteToMove ? 1 : -1;
        const pv = i.pv.slice(0, 10);
        return { eval_white_cp: cpStm == null ? null : sign * cpStm, mate: i.mate == null ? null : sign * i.mate, line: sanLine(fen, pv), uci: pv };
      }),
    };
  }

  async insight(b) {
    boardFrom(b.fen, b.moves);
    try {
      return await coach.insight(await this.eng(), { fen: b.fen ?? 'startpos', moves: b.moves || [], pov: b.pov ?? null });
    } catch (e) {
      if (e.status) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  // -------------------------------------------------------------- dashboard
  dashboard() {
    const D = this.data, d = D.meta?.dashboard || {};
    const t = nowS();
    const due = {}, total = {};
    for (const p of D.practice.values()) {
      total[p.kind] = (total[p.kind] || 0) + 1;
      if ((p.due || 0) <= t) due[p.kind] = (due[p.kind] || 0) + 1;
    }
    const week = {}, motifs = {};
    for (const a of D.allAttempts()) {
      if (a.ts > t - 7 * DAY) {
        const w = (week[a.mode] ||= { mode: a.mode, n: 0, ok: 0 });
        w.n++; w.ok += a.correct ? 1 : 0;
      }
      if (!a.correct && a.ts > t - 30 * DAY) for (const x of a.motifs || []) motifs[x] = (motifs[x] || 0) + 1;
    }
    // ratings: newer synced chess.com games update "current"
    const ratings = JSON.parse(JSON.stringify(d.ratings || {}));
    const created = Date.parse(D.meta?.created || 0) / 1000 || 0;
    for (const tc of ['blitz', 'rapid']) {
      let latest = null;
      for (const g of D.games.values()) if (g.time_class === tc && g.end_time > created && (!latest || g.end_time > latest.end_time)) latest = g;
      if (latest?.my_rating && ratings[tc]) ratings[tc].current = latest.my_rating;
    }
    return {
      ratings, metrics: d.metrics || {}, error_anatomy: d.error_anatomy || [], phase_me: d.phase_me || [],
      practice_due: due, practice_total: total, week: Object.values(week), recent_motifs: motifs,
      student_md: d.student_md || '', plan_md: d.plan_md || '', repertoire_md: d.repertoire_md || '', journal_md: d.journal_md || '',
      username: D.meta?.username || '', display_name: D.meta?.display_name || '',
      llm: false,
    };
  }

  // -------------------------------------------------------------- puzzles (spaced repetition, as server.py)
  puzzleNext(kind) {
    const all = [...this.data.practice.values()].filter((p) => kind === 'any' || p.kind === kind);
    const t = nowS();
    const due = all.filter((p) => (p.due || 0) <= t);
    let row;
    if (due.length) {
      // ORDER BY reps > 0 DESC, due, random()
      const shuffled = due.map((p) => [p, Math.random()]);
      shuffled.sort((a, b) => ((b[0].reps > 0) - (a[0].reps > 0)) || ((a[0].due || 0) - (b[0].due || 0)) || (a[1] - b[1]));
      row = shuffled[0][0];
    } else {
      row = [...all].sort((a, b) => (a.due || 0) - (b.due || 0))[0];
    }
    if (!row) throw new HttpError(404, 'No puzzles yet: run analysis first');
    const pos = positionJson(row.fen, []);
    return {
      id: row.id, kind: row.kind, fen: row.fen, side: pos.turn, phase: row.phase, opening: row.opening, date: row.date,
      url: row.url, reps: row.reps, due_left: due.length, win_before: row.win_before,
      prompt: { missed: 'Your opponent just blundered. Punish it!',
        conversion: "You are winning here (you didn't win the game). Find the move that keeps control." }[row.kind]
        || 'You went wrong here in a real game. Find the best move.',
      ...pos,
    };
  }

  async puzzleAttempt(pid, b) {
    const row = this.data.practice.get(pid);
    if (!row) throw new HttpError(404, 'Not Found');
    const c = boardFrom(row.fen, []);
    const uci = parseMove(c, b.uci);
    const { correct: ok, info } = await coach.isCorrectSolution(await this.eng(), { fen: row.fen, moves: [], uci, bestUci: row.best_uci, nodes: NODES.puzzle });
    // SM-2-style scheduling (identical to server.puzzle_attempt)
    let { ease, interval, lapses } = row;
    if (ok) {
      interval = row.reps === 0 || interval < 1 ? 1.0 : interval * ease;
      ease = Math.min(3.0, ease + 0.1);
    } else {
      interval = 10 / 1440;
      ease = Math.max(1.3, ease - 0.2);
      lapses = lapses + 1;
    }
    const t = nowS();
    await this.data.putPractice({ ...row, due: t + interval * DAY, interval, ease, reps: row.reps + 1, lapses, last_result: ok ? 1 : 0, last_seen: t });
    await this.data.logAttempt('puzzle', String(pid), ok, info);
    return { correct: ok, explanation: info, game_move: row.played_san, best_san: row.best_san, url: row.url,
      next_due_days: Math.round(interval * 1000) / 1000 };
  }

  puzzleStats() {
    const t = nowS(), by = {};
    for (const p of this.data.practice.values()) {
      const s = (by[p.kind] ||= { kind: p.kind, total: 0, seen: 0, solved: 0, due: 0 });
      s.total++; s.seen += p.reps > 0 ? 1 : 0; s.solved += p.last_result === 1 ? 1 : 0; s.due += (p.due || 0) <= t ? 1 : 0;
    }
    return Object.values(by).sort((a, b) => a.kind.localeCompare(b.kind));
  }

  randomFen() {
    const all = [...this.data.practice.values()];
    return { fen: all.length ? all[Math.floor(Math.random() * all.length)].fen : START, n: Math.random() };
  }

  // -------------------------------------------------------------- sparring
  async engineMove(b) {
    const pos = positionJson(b.fen ?? 'startpos', b.moves || []);
    if (pos.game_over) return { uci: null, ...pos };
    let mv = await (await this.eng()).bestMove(b.fen ?? 'startpos', { moves: b.moves || [], elo: b.elo ?? 1500 });
    mv = typeof mv === 'string' ? mv : mv?.uci || mv?.bestmove;
    const c = boardFrom(pos.fen, []);
    if (!mv || !c.moves({ verbose: true }).some((m) => uciOf(m) === mv)) {
      const legal = c.moves({ verbose: true }); // engine failed: never hang the game
      mv = uciOf(legal[Math.floor(Math.random() * legal.length)]);
    }
    const san = c.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] || undefined }).san;
    return { uci: mv, san, ...positionJson(b.fen ?? 'startpos', [...(b.moves || []), mv]) };
  }

  async playCheck(b) {
    const c = boardFrom(b.fen, b.moves);
    const uci = parseMove(c, b.uci);
    const info = await coach.explainMove(await this.eng(), { fen: b.fen ?? 'startpos', moves: b.moves || [], uci, nodes: NODES.check });
    if (info.classification === 'mistake' || info.classification === 'blunder') await this.data.logAttempt('play', info.played_san, false, info);
    return info;
  }

  async saveGame(b) {
    if (!Array.isArray(b.moves) || !b.color || !b.result) throw new HttpError(422, 'moves, color and result are required');
    boardFrom(b.fen, b.moves);
    const now = new Date();
    const me = this.data.meta?.username || ME_FALLBACK, bot = `Stockfish ${b.elo ?? 1500}`;
    const tc = b.time_control || '-';
    const pgn = buildPgn({
      fen: b.fen, moves: b.moves, clocks: b.clocks || [],
      headers: { Event: 'Chess Coach practice', Site: 'Chess Coach', Date: now.toISOString().slice(0, 10).replace(/-/g, '.'),
        White: b.color === 'white' ? me : bot, Black: b.color === 'white' ? bot : me, Result: b.result, TimeControl: tc,
        Termination: b.reason || '' },
    });
    const gid = `coach-${now.getTime()}`;
    const res = { '1-0': 'white', '0-1': 'black' }[b.result];
    const result = b.result === '1/2-1/2' ? 'draw' : (res === b.color ? 'win' : (res ? 'loss' : 'draw'));
    const [base, inc = '0'] = tc.split('+');
    await this.data.putGame({
      id: gid, url: '', end_time: Math.floor(now.getTime() / 1000), date: now.toISOString().slice(0, 10),
      hour: now.getUTCHours(), weekday: (now.getUTCDay() + 6) % 7, time_class: 'coach', time_control: tc,
      base_seconds: /^\d+$/.test(base) ? +base : null, increment: /^\d+$/.test(inc) ? +inc : 0, rated: 0, color: b.color,
      my_rating: null, opp_rating: b.elo ?? 1500, opp_name: bot, result, my_code: b.reason || '', opp_code: '',
      termination: b.reason || '', eco: null, opening: null, opening_family: null, n_plies: b.moves.length, my_accuracy: null,
      opp_accuracy: null, pgn, analyzed: 0, blunders: 0, highlights: 0,
    });
    await this.data.enqueue(gid, true);
    this.runQueue();
    return { id: gid, pgn, result };
  }

  startPositions() {
    const seen = new Set(), out = [];
    const all = [...this.data.localStarts, ...(this.data.meta?.start_positions || [])];
    all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    for (const p of all) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const { end_time, ...row } = p;
      out.push(row);
      if (out.length >= 40) break;
    }
    return out;
  }

  // -------------------------------------------------------------- games
  gamesList(q) {
    const source = q.get('source') || 'chesscom', result = q.get('result'), text = (q.get('q') || '').toLowerCase();
    const analyzed = !['false', '0'].includes(q.get('analyzed'));
    const limit = +(q.get('limit') || 60);
    let list = [...this.data.games.values()].filter((g) => (source === 'coach' ? g.time_class === 'coach' : g.time_class === 'blitz' || g.time_class === 'rapid'));
    if (analyzed && source !== 'coach') list = list.filter((g) => g.analyzed === 1);
    if (['win', 'loss', 'draw'].includes(result)) list = list.filter((g) => g.result === result);
    if (text) list = list.filter((g) => (g.opening || '').toLowerCase().includes(text) || (g.opp_name || '').toLowerCase().includes(text));
    list.sort((a, b) => b.end_time - a.end_time);
    return list.slice(0, limit).map((g) => ({
      id: g.id, date: g.date, color: g.color, result: g.result, my_code: g.my_code, opp_code: g.opp_code, opp_name: g.opp_name,
      opp_rating: g.opp_rating, my_rating: g.my_rating, time_control: g.time_control, opening: g.opening, url: g.url,
      analyzed: g.analyzed, blunders: g.blunders || 0, highlights: g.highlights || 0,
    }));
  }

  async gameDetail(gid) {
    const g = this.data.games.get(gid);
    if (!g) throw new HttpError(404, 'Not Found');
    if (g.analyzed !== 1) {
      const meta = Object.fromEntries(['id', 'date', 'color', 'result', 'my_code', 'opp_name', 'opp_rating', 'time_control'].map((k) => [k, g[k]]));
      if (g.analyzed === -1) return { meta, moves: [], pending: false, error: 'Engine analysis failed for this game.', pgn: g.pgn };
      if (this.analysis.current !== gid) { await this.data.enqueue(gid, true); this.runQueue(); }
      return { meta, moves: [], pending: true, pgn: g.pgn };
    }
    const moves = (await this.data.movesFor(gid)).map((m) => ({
      ...m, eval_white_after: m.fen_before.includes(' w ') ? m.eval_after : -m.eval_after,
    }));
    const meta = Object.fromEntries(['id', 'url', 'date', 'color', 'result', 'my_code', 'opp_code', 'opp_name', 'opp_rating',
      'my_rating', 'time_control', 'opening', 'my_accuracy', 'opp_accuracy'].map((k) => [k, g[k] ?? null]));
    return { meta, moves, pgn: g.pgn };
  }

  // -------------------------------------------------------------- drills
  drills() {
    const d = this.data.meta?.drills || {};
    return Object.keys(d).sort().map((id) => ({ id, name: d[id].name, color: d[id].color, lines: (d[id].lines || []).length }));
  }
  drill(did) {
    const d = this.data.meta?.drills?.[did];
    if (!d || did.includes('/')) throw new HttpError(404, 'Not Found');
    return d;
  }
  async drillResult(did, r) {
    await this.data.logAttempt('drill', `${did}:${r.line}`, !!r.correct, null);
    return { ok: true };
  }

  // -------------------------------------------------------------- background analysis queue (sequential, resumable)
  runQueue() {
    if (this.analysis.running) return this._queueP;
    this.analysis.running = true;
    this._queueP = (async () => {
      try {
        while (this.data.queue.length) {
          const gid = this.data.queue[0];
          const g = this.data.games.get(gid);
          if (!g || g.analyzed === 1) { await this.data.dequeue(gid); continue; }
          this.analysis.current = gid;
          this.analysis.ply = 0; this.analysis.plies = g.n_plies || 0;
          this._emit();
          try {
            const rows = await coach.analyseGame(await this.bgEng(), {
              pgn: g.pgn, myColor: g.color, increment: g.increment || 0,
              nodes: g.time_class === 'coach' ? NODES.game : NODES.sync,
              onProgress: (i, n) => { this.analysis.ply = i; this.analysis.plies = n || this.analysis.plies; this._emit(); },
            });
            await this.data.saveAnalysis(gid, rows);
            this.analysis.done++;
          } catch (e) {
            console.error('analysis failed', gid, e);
            await this.data.markFailed(gid);
          }
        }
      } finally {
        this.analysis.running = false;
        this.analysis.current = null;
        this._emit();
        const bg = this._bg;
        this._bg = null;
        bg?.then((e) => e.terminate?.()).catch(() => {});
      }
    })();
    return this._queueP;
  }

  _emit() { window.dispatchEvent(new CustomEvent('cc-analysis', { detail: { ...this.analysis, left: this.data.queue.length } })); }
}

// ------------------------------------------------------------------ fetch shim

/** Route /api/* (absolute or relative to the app) to `api`; everything else goes to the network. */
export function installFetchShim(api, appBase) {
  const realFetch = window.fetch.bind(window);
  const base = new URL(appBase);
  window.fetch = async function (input, init = {}) {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const u = new URL(raw, document.baseURI);
    let path = null;
    if (u.origin === location.origin) {
      if (u.pathname.startsWith(base.pathname + 'api/')) path = u.pathname.slice(base.pathname.length + 4);
      else if (u.pathname.startsWith('/api/')) path = u.pathname.slice(5);
    }
    if (path === null) return realFetch(input, init);
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    let body;
    try {
      const txt = init.body ?? (typeof input === 'object' && input.text ? await input.text() : undefined);
      body = txt ? JSON.parse(txt) : undefined;
    } catch { return json({ detail: 'Invalid JSON body' }, 422); }
    try {
      return json(await api.handle(method, path, u.searchParams, body));
    } catch (e) {
      if (e instanceof HttpError) return json({ detail: e.message }, e.status);
      // engine.cancel() rejects stale searches with AbortError: answer quietly (the UI has moved on)
      if (e?.name === 'AbortError') return json({ detail: 'cancelled', cancelled: true }, 409);
      console.error('local api', path, e);
      return json({ detail: String(e?.message || e) }, 500);
    }
  };
  return realFetch;
}
