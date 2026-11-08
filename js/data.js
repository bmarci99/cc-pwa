// The phone's personal data model: the decrypted bundle from the Mac + everything done on the phone
// (puzzle SRS state, attempts, saved practice games, synced chess.com games and their analysis).
// All writes go through to the store (IndexedDB, or memory when "remember" is off / storage is blocked).

export const BUNDLE_KIND = 'chess-coach-bundle';

const isBlunder = (m) => m.is_mine && m.classification === 'blunder';
const isHighlight = (m) => m.is_mine && (m.classification === 'brilliant' || m.classification === 'great');

/** Same rules as server.seed_practice, applied to one analysed game. Returns new practice items (no ids). */
export function practiceCandidates(game, rows) {
  const out = [];
  const item = (kind, r) => ({
    kind, game_id: game.id, ply: r.ply, fen: r.fen_before, best_uci: r.best_uci, best_san: r.best_san,
    played_san: r.san, classification: r.classification, phase: r.phase, opening: game.opening ?? null,
    url: game.url ?? null, date: game.date ?? null, win_before: r.win_before, win_after: r.win_after,
    due: 0, interval: 0, ease: 2.3, reps: 0, lapses: 0, last_result: null, last_seen: null,
  });
  const sorted = [...rows].sort((a, b) => a.ply - b.ply);
  if (game.result !== 'win') {
    const c = sorted.find((m) => m.is_mine && m.win_before >= 80 && m.win_drop >= 15 && Math.abs(m.eval_before) < 9000 && m.best_uci != null);
    if (c) out.push(item('conversion', c));
  }
  sorted.forEach((m, i) => {
    if (!(m.is_mine && m.best_uci != null && m.win_drop >= 18 && m.win_before >= 20 && m.win_before <= 97)) return;
    const prev = i > 0 ? sorted[i - 1].classification : null;
    out.push(item(prev === 'blunder' ? 'missed' : 'mistake', m));
  });
  return out;
}

/** "Convert a win" start position of one game (same rule as /api/play/start_positions), or null. */
export function startPositionOf(game, rows) {
  if (game.result === 'win') return null;
  const m = [...rows].sort((a, b) => a.ply - b.ply).find((r) => r.is_mine && r.win_before >= 85 && Math.abs(r.eval_before) < 9000);
  return m ? { id: game.id, fen: m.fen_before, opening: game.opening, date: game.date, url: game.url, win_before: m.win_before, end_time: game.end_time } : null;
}

export class LocalData {
  constructor(store) {
    this.st = store;
    this.meta = null;            // bundle metadata: created, username, dashboard, drills, start_positions, known ids
    this.practice = new Map();   // id -> item
    this.games = new Map();      // id -> game row (+ blunders/highlights)
    this.attempts = [];          // phone attempts
    this.macAttempts = [];       // attempts from the Mac (bundle)
    this.queue = [];             // game ids waiting for on-device analysis
    this.localStarts = [];
    this._moves = new Map();
  }

  get persistent() { return this.st.persistent; }

  async load() {
    this.meta = (await this.st.get('kv', 'bundle')) || null;
    this.practice = new Map((await this.st.all('practice')).map((p) => [p.id, p]));
    this.games = new Map((await this.st.all('games')).map((g) => [g.id, g]));
    this.attempts = (await this.st.all('attempts')) || [];
    this.macAttempts = (await this.st.get('kv', 'mac_attempts')) || [];
    this.queue = (await this.st.get('kv', 'queue')) || [];
    this.localStarts = (await this.st.get('kv', 'local_starts')) || [];
    return this;
  }

  /** Merge a freshly decrypted bundle (first unlock or a newer export from the Mac). */
  async importBundle(b) {
    if (!b || b.kind !== BUNDLE_KIND || b.v !== 1) throw new Error('Not a Chess Coach data bundle');
    await this.load();
    // games + moves (the Mac's analysis wins; phone-only games stay)
    const gEntries = [], mEntries = [];
    for (const arr of b.games) {
      const g = Object.fromEntries(b.game_cols.map((c, i) => [c, arr[i]]));
      const rows = (b.moves[g.id] || []).map((r) => Object.fromEntries(b.move_cols.map((c, i) => [c, r[i]])));
      g.blunders = rows.filter(isBlunder).length;
      g.highlights = rows.filter(isHighlight).length;
      gEntries.push([g.id, g]);
      mEntries.push([g.id, rows]);
      this.games.set(g.id, g);
      this._moves.set(g.id, rows);
    }
    await this.st.putMany('games', gEntries);
    await this.st.putMany('moves', mEntries);
    // practice: bundle ids are authoritative; keep the phone's SRS state where it is newer
    const byFen = new Map([...this.practice.values()].map((p) => [p.fen, p]));
    const next = new Map();
    for (const p of b.practice) {
      const local = byFen.get(p.fen);
      if (local && (local.last_seen || 0) > (p.last_seen || 0)) {
        for (const k of ['due', 'interval', 'ease', 'reps', 'lapses', 'last_result', 'last_seen']) p[k] = local[k];
      }
      next.set(p.id, p);
      byFen.delete(p.fen);
    }
    let nid = Math.max(0, ...next.keys()) + 1;
    for (const p of byFen.values()) { next.set(nid, { ...p, id: nid }); nid++; } // phone-only items
    await this.st.clear('practice');
    await this.st.putMany('practice', [...next.values()].map((p) => [p.id, p]));
    this.practice = next;
    this.macAttempts = b.attempts || [];
    await this.st.put('kv', 'mac_attempts', this.macAttempts);
    this.meta = {
      created: b.created, username: b.username, dashboard: b.dashboard, drills: b.drills,
      start_positions: b.start_positions || [], known_game_ids: b.known_game_ids || [], imported: Date.now(),
    };
    await this.st.put('kv', 'bundle', this.meta);
    this.queue = this.queue.filter((id) => this.games.get(id)?.analyzed !== 1);
    await this.st.put('kv', 'queue', this.queue);
    return this;
  }

  // ---------------------------------------------------------------- practice / attempts
  async putPractice(p) { this.practice.set(p.id, p); await this.st.put('practice', p.id, p); }

  async logAttempt(mode, ref, correct, info) {
    const a = { ts: Date.now() / 1000, mode, ref: String(ref), correct: correct ? 1 : 0,
      classification: info?.classification ?? null, motifs: info?.motifs || [] };
    const key = `${Math.round(a.ts * 1000)}-${Math.random().toString(36).slice(2, 7)}`;
    this.attempts.push(a);
    try { await this.st.put('attempts', key, a); } catch (e) { console.warn('attempt not saved', e); }
  }

  allAttempts() {
    const norm = (a) => ({ ...a, motifs: typeof a.motifs === 'string' ? JSON.parse(a.motifs || '[]') : a.motifs || [] });
    return [...this.macAttempts.map(norm), ...this.attempts.map(norm)];
  }

  // ---------------------------------------------------------------- games / moves
  async movesFor(gid) {
    if (this._moves.has(gid)) return this._moves.get(gid);
    const rows = (await this.st.get('moves', gid)) || [];
    this._moves.set(gid, rows);
    return rows;
  }

  async putGame(g) { this.games.set(g.id, g); await this.st.put('games', g.id, g); }

  knows(gid) { return this.games.has(gid) || (this.meta?.known_game_ids || []).includes(gid); }

  async enqueue(gid, front = false) {
    this.queue = this.queue.filter((x) => x !== gid);
    if (front) this.queue.unshift(gid); else this.queue.push(gid);
    await this.st.put('kv', 'queue', this.queue);
  }

  async dequeue(gid) {
    this.queue = this.queue.filter((x) => x !== gid);
    await this.st.put('kv', 'queue', this.queue);
  }

  /** Store finished analysis of one game; adds its mistakes to the practice pool. Returns #new puzzles. */
  async saveAnalysis(gid, rows) {
    const g = this.games.get(gid);
    rows = rows.map(({ game_id, cp_loss, second_gap, sacrificed, ...r }) => r); // the /api/games/{id} columns
    rows.sort((a, b) => a.ply - b.ply);
    await this.st.put('moves', gid, rows);
    this._moves.set(gid, rows);
    g.analyzed = 1;
    g.blunders = rows.filter(isBlunder).length;
    g.highlights = rows.filter(isHighlight).length;
    await this.putGame(g);
    const fens = new Set([...this.practice.values()].map((p) => p.fen));
    let nid = Math.max(0, ...this.practice.keys()) + 1, added = 0;
    for (const c of practiceCandidates(g, rows)) {
      if (fens.has(c.fen)) continue;
      fens.add(c.fen);
      await this.putPractice({ ...c, id: nid++ });
      added++;
    }
    if (g.time_class !== 'coach') {
      const sp = startPositionOf(g, rows);
      if (sp) {
        this.localStarts = [sp, ...this.localStarts.filter((x) => x.id !== gid)].slice(0, 60);
        await this.st.put('kv', 'local_starts', this.localStarts);
      }
    }
    await this.dequeue(gid);
    return added;
  }

  async markFailed(gid) {
    const g = this.games.get(gid);
    if (g) { g.analyzed = -1; await this.putGame(g); }
    await this.dequeue(gid);
  }

  async getKv(k) { return this.st.get('kv', k); }
  async setKv(k, v) { return this.st.put('kv', k, v); }
}
