// Chess Coach — single-page app (vanilla JS, no build step).
import {
  ChessBoard, EvalBar, CLASS_INFO, START_FEN, parseFen, toFen, applyUci,
  sanFor, uciForSan, normSan, firstSan, evalText,
} from './board.js';
import {
  $, $$, esc, sleep, store, toast, api, badgeHtml, classLabel, sideOf, fmtSecs, fmtClock, MOTIF_LABELS,
  mdInline, renderMarkdown, mdSection, S, llmFlag, boardLayout, mountBoard, explanationHtml, refutationUci,
  modal, ROUTINE_SHORT, updateLlmToggle, copyText, openAnalysis,
} from './ui.js';
import { viewPlay } from './play.js';
import { viewAnalysis } from './analysis.js';
import { sound } from './sound.js';
import { fetchInsight, insightHtml, threatArrows, wireInsight, focusOption } from './insight.js';

// ------------------------------------------------------------------ 1. Dashboard

const METRICS = [
  { key: 'blunders_per_game', label: 'Blunders per game', base: 1.19, target: 0.5, lower: true, fmt: (v) => v.toFixed(2) },
  { key: 'blunder_free_games_pct', label: 'Blunder-free games', base: 34.7, target: 60, unit: '%' },
  { key: 'opp_blunders_punished_pct', label: 'Opponent blunders punished', base: 47.3, target: 80, unit: '%' },
  { key: 'converted_pct', label: 'Winning positions converted', base: 67.4, target: 85, unit: '%' },
];

async function viewDashboard(root) {
  root.innerHTML = '<div class="loading-page"><div class="spinner"></div></div>';
  const d = S.dash = await api('./api/dashboard');
  window.CC_USER = d.username || window.CC_USER;
  S.llm = !!d.llm;
  updateLlmToggle();
  const r = d.ratings || {};
  const ratingCard = (k) => {
    const x = r[k];
    if (!x) return '';
    const delta = (a, b) => (a == null || b == null ? '' : `<span class="delta ${a - b >= 0 ? 'up' : 'down'}">${a - b >= 0 ? '+' : ''}${a - b}</span>`);
    const toGoal = Math.max(0, Math.min(100, ((x.current - 1000) / (1800 - 1000)) * 100));
    return `<div class="card rating">
      <div class="card-k">${k[0].toUpperCase() + k.slice(1)}</div>
      <div class="big">${x.current ?? '–'}</div>
      <div class="kv"><span>Peak</span><b>${x.peak ?? '–'}</b></div>
      <div class="kv"><span>1 year ago</span><b>${x['365d_ago'] ?? '–'}</b> ${delta(x.current, x['365d_ago'])}</div>
      <div class="kv"><span>30 days</span>${delta(x.current, x['30d_ago']) || '–'}<span class="muted small">${x.games_last_30d ?? 0} games</span></div>
      <div class="goalbar" title="Progress to 1800"><div style="width:${toGoal}%"></div></div>
      <div class="muted small">${1800 - (x.current || 0) > 0 ? `${1800 - x.current} to 1800` : 'Goal reached!'}</div>
    </div>`;
  };
  const m = d.metrics || {};
  const metricCard = (spec) => {
    const v = m[spec.key];
    const fmt = spec.fmt || ((x) => Math.round(x) + (spec.unit || ''));
    const prog = v == null ? 0 : Math.max(0, Math.min(1, (spec.lower ? spec.base - v : v - spec.base) / Math.abs(spec.target - spec.base)));
    const done = v != null && (spec.lower ? v <= spec.target : v >= spec.target);
    return `<div class="card metric ${done ? 'done' : ''}">
      <div class="card-k">${spec.label}</div>
      <div class="metric-row"><span class="big">${v == null ? '–' : fmt(v)}</span><span class="muted">→ target <b>${fmt(spec.target)}</b></span></div>
      <div class="progress"><div style="width:${(prog * 100).toFixed(0)}%"></div></div>
      <div class="muted small">baseline ${fmt(spec.base)}</div>
    </div>`;
  };
  const anatomy = d.error_anatomy || [];
  const maxPct = Math.max(1, ...anatomy.map((a) => a['%'] || 0));
  const anatomyHtml = anatomy.map((a) => `<div class="bar-row"><span class="bar-label">${esc(a.index)}</span>
      <div class="bar"><div style="width:${(a['%'] / maxPct) * 100}%"></div></div><span class="bar-val">${a['%']}% <span class="muted small">(${a.count})</span></span></div>`).join('');
  const phases = (d.phase_me || []).map((p) => `<tr><td>${esc(p.phase)}</td><td>${p.ACPL}</td><td>${p['inacc/100']}</td><td>${p['mistake/100']}</td><td><b>${p['blunder/100']}</b></td></tr>`).join('');
  const kinds = ['mistake', 'missed', 'conversion'];
  const kindName = { mistake: 'My mistakes', missed: 'Missed punishes', conversion: 'Conversions' };
  const due = d.practice_due || {}, tot = d.practice_total || {};
  const queue = kinds.map((k) => `<a class="queue-item" href="#train" data-kind="${k}"><span class="big">${due[k] || 0}</span><span>${kindName[k]}</span><span class="muted small">due of ${tot[k] || 0}</span></a>`).join('');
  const week = (d.week || []).length
    ? (d.week).map((w) => `<div class="kv"><span>${esc(w.mode)}</span><b>${w.n}</b><span class="muted small">${w.ok || 0} ok (${w.n ? Math.round((100 * (w.ok || 0)) / w.n) : 0}%)</span></div>`).join('')
    : '<p class="muted">No practice logged in the last 7 days. Start with 15 minutes in Train.</p>';
  const motifs = Object.entries(d.recent_motifs || {}).sort((a, b) => b[1] - a[1]);
  const motifsHtml = motifs.length
    ? motifs.map(([k, n]) => `<span class="chip static">${esc(MOTIF_LABELS[k] || k)} <b>${n}</b></span>`).join('')
    : '<p class="muted">No failed puzzles in the last 30 days yet.</p>';
  const routine = mdSection(d.plan_md, 'blunder-check');
  const sections = [
    ['Diagnosis', d.student_md], ['Training plan', d.plan_md], ['Repertoire', d.repertoire_md], ['Journal', d.journal_md],
  ];
  root.innerHTML = `<div class="dash">
    <div class="hero card">
      <div>
        <h1>Hi${d.display_name ? ' ' + esc(d.display_name) : ''} — road to 1800</h1>
        <p class="muted">${d.username ? esc(d.username) + ' · ' : ''}${m.analyzed_games ?? '–'} games analysed. Board vision first: fewer blunders, punish theirs, convert wins.</p>
      </div>
      <div class="btn-row"><a class="btn primary big-btn" href="#train">Start training →</a>${d.llm ? '<a class="btn big-btn" href="#coach">💬 Ask Coach</a>' : ''}</div>
    </div>
    ${routine ? `<div class="card routine"><div class="routine-h">${esc(routine.title)}</div>${renderMarkdown(routine.body)}</div>` : ''}
    <h2>Ratings</h2>
    <div class="grid3">${['blitz', 'rapid', 'bullet'].map(ratingCard).join('')}</div>
    <h2>Key metrics vs targets</h2>
    <div class="grid4">${METRICS.map(metricCard).join('')}</div>
    <div class="grid2">
      <div class="card"><h3>Error anatomy</h3><div class="bars">${anatomyHtml || '<p class="muted">No data</p>'}</div>
        ${phases ? `<div class="table-wrap"><table class="compact"><thead><tr><th>phase</th><th>ACPL</th><th>inacc/100</th><th>mist/100</th><th>blund/100</th></tr></thead><tbody>${phases}</tbody></table></div>` : ''}
      </div>
      <div class="col">
        <div class="card"><h3>Puzzle queue</h3><div class="queue">${queue}</div></div>
        <div class="card"><h3>Last 7 days</h3>${week}</div>
        <div class="card"><h3>Recent failure motifs <span class="muted small">(30 days)</span></h3><div class="chips">${motifsHtml}</div></div>
      </div>
    </div>
    <h2>Coach notes</h2>
    ${sections.map(([t, s], i) => `<details class="card md-section" ${i === 0 ? 'open' : ''}><summary>${t}</summary><div class="md">${s ? renderMarkdown(s) : '<p class="muted">Empty</p>'}</div></details>`).join('')}
  </div>`;
  $$('.queue-item', root).forEach((a) => a.addEventListener('click', () => store.set('trainKind', a.dataset.kind)));
  // "Use on iPhone" (only answered for requests from this Mac)
  api('./api/mobile', undefined, { quiet: true }).then((m) => {
    if (!m?.qr_svg || !root.isConnected) return;
    const card = document.createElement('div');
    card.className = 'card iphone-card';
    card.innerHTML = `<div class="qr" aria-label="QR code">${m.qr_svg}</div>
      <div><h3>📱 Use on iPhone</h3>
        <ol>
          <li>Put your iPhone on the <b>same Wi-Fi</b> as this Mac.</li>
          <li>Scan the code with the <b>Camera</b> app and open the link in Safari.</li>
          <li>Tap <b>Share → Add to Home Screen</b> for a full-screen app.</li>
        </ol>
        <p class="muted small">The Mac must have Chess Coach open (allow incoming connections if macOS asks). The link contains your private access key — don’t share it.</p>
        <details class="urls"><summary class="small">Show the links</summary>${(m.urls || []).map((u) => `<div><code>${esc(u)}</code></div>`).join('')}</details>
      </div>`;
    const hero = $('.hero', root);
    hero?.insertAdjacentElement('afterend', card);
  }).catch(() => {});
}

// ------------------------------------------------------------------ 2. Train (my mistakes)

async function viewTrain(root) {
  const kinds = [['any', 'All'], ['mistake', 'My mistakes'], ['missed', 'Punish their blunder'], ['conversion', 'Convert a win']];
  let kind = store.get('trainKind', 'any');
  root.innerHTML = boardLayout(`
    <div class="chips filter">${kinds.map(([k, l]) => `<button class="chip ${k === kind ? 'on' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
    <div class="session card tight">
      <div><span class="muted small">Solved</span><b id="s-solved">0</b></div>
      <div><span class="muted small">Attempted</span><b id="s-att">0</b></div>
      <div><span class="muted small">Streak</span><b id="s-streak">0</b></div>
      <div><span class="muted small">Due</span><b id="s-due">–</b></div>
    </div>
    <div class="card" id="pz-info"><div class="muted">Loading puzzle…</div></div>
    <div class="card hidden" id="pz-result"></div>
    <div class="btn-row">
      <button class="btn" id="pz-show">Show best move</button>
      <button class="btn" id="pz-retry">Try again</button>
      <button class="btn primary" id="pz-next">Next ⏎</button>
      <button class="btn" id="pz-an" title="Open on the analysis board">Analyse</button>
    </div>`, { under: `<div class="routine-line">${ROUTINE_SHORT}</div>` });
  const ui = mountBoard(root, { onMove: (u) => attempt(u) });
  let pz = null, state = 'idle', lastRes = null, retried = false;
  const updSession = () => {
    $('#s-solved').textContent = S.session.solved;
    $('#s-att').textContent = S.session.attempted;
    $('#s-streak').textContent = S.session.streak;
    store.set('session', S.session);
  };
  updSession();

  async function load() {
    state = 'loading';
    $('#pz-result').classList.add('hidden');
    ui.busy(true, 'Loading puzzle…');
    try {
      pz = await api(`./api/puzzles/next?kind=${kind}`);
    } catch (e) {
      $('#pz-info').innerHTML = `<div class="muted">${esc(e.message)}</div>`;
      return;
    } finally { ui.busy(false); }
    retried = false;
    lastRes = null;
    ui.board.setOrientation(pz.side);
    ui.evalbar.setOrientation(pz.side);
    ui.evalbar.set(null);
    ui.board.setPosition(pz.fen, { legal: pz.legal, check: pz.check, movable: pz.side, lastMove: pz.last_move });
    $('#s-due').textContent = pz.due_left;
    const kindTag = { mistake: 'My mistake', missed: 'Punish', conversion: 'Conversion' }[pz.kind] || pz.kind;
    $('#pz-info').innerHTML = `
      <div class="pz-head"><span class="tag tag-${pz.kind}">${kindTag}</span><span class="side-dot ${pz.side}"></span><b>${pz.side === 'white' ? 'White' : 'Black'} to move</b></div>
      <p class="prompt">${esc(pz.prompt)}</p>
      <div class="meta muted small">${esc(pz.opening || '')}${pz.date ? ' · ' + esc(pz.date) : ''}${pz.phase ? ' · ' + esc(pz.phase) : ''}${pz.win_before != null ? ` · you were ${Math.round(pz.win_before)}% to win` : ''}${pz.reps ? ` · seen ${pz.reps}×` : ''}</div>
      ${pz.url ? `<a class="small" href="${esc(pz.url)}" target="_blank" rel="noopener">Open the original game ↗</a>` : ''}`;
    S.lastContext = { fen: pz.fen, source: 'Train puzzle', explanation: null };
    state = 'solving';
  }

  async function attempt(uci) {
    if (state !== 'solving') return;
    state = 'checking';
    ui.busy(true, 'Checking your move…');
    let res;
    try {
      res = await api(`./api/puzzles/${pz.id}/attempt`, { uci, llm: llmFlag() });
    } catch {
      ui.board.setPosition(pz.fen, { legal: pz.legal, check: pz.check, movable: pz.side });
      state = 'solving';
      return;
    } finally { ui.busy(false); }
    lastRes = res;
    const ex = res.explanation;
    if (!retried) {
      S.session.attempted++;
      if (res.correct) { S.session.solved++; S.session.streak++; } else S.session.streak = 0;
      updSession();
    }
    const dest = ex.played.slice(2, 4);
    ui.board.setBadge(dest, ex.classification);
    const arrows = [];
    if (!res.correct || ex.best !== ex.played) arrows.push({ uci: ex.best, color: 'green' });
    ui.board.setArrows(arrows);
    const meCp = ex.eval_after;
    ui.evalbar.set(pz.side === 'white' ? meCp : -meCp);
    if (!res.correct) refutationUci(ex).then((u) => { if (u && lastRes === res) ui.board.setArrows([...arrows, { uci: u, color: 'red' }]); });
    S.lastContext = { fen: pz.fen, source: 'Train puzzle', explanation: ex };
    $('#pz-result').classList.remove('hidden');
    $('#pz-result').innerHTML = `<div class="verdict ${res.correct ? 'ok' : 'bad'}">${res.correct ? '✓ Correct!' : '✗ Not quite'}
        <span class="muted small">${res.correct ? `next review in ${res.next_due_days >= 1 ? Math.round(res.next_due_days) + ' day(s)' : Math.round(res.next_due_days * 1440) + ' min'}` : 'back in 10 min'}</span></div>
      ${explanationHtml(ex, { gameMove: res.game_move })}
      <details class="ins-details" id="pz-ins"><summary>🧭 Understand the position</summary><div id="pz-ins-body"><div class="row-spin small"><span class="spinner sm"></span> Coach is looking at the position…</div></div></details>`;
    const thisPz = pz;
    $('#pz-ins').addEventListener('toggle', async (e) => {
      if (!e.target.open || e.target.dataset.loaded) return;
      e.target.dataset.loaded = '1';
      const info = await fetchInsight({ fen: thisPz.fen, moves: [], pov: thisPz.side }, () => pz !== thisPz);
      if (pz !== thisPz) return;
      $('#pz-ins-body').innerHTML = info ? insightHtml(info, { level: 'full', suggest: true }) : '<p class="muted small">Not available.</p>';
      if (info) wireInsight($('#pz-ins-body'), { board: ui.board, getInfo: () => info, getSuggest: () => true, onCandidate: (uci) => ui.board.setArrows([{ uci, color: 'blue' }]) });
    });
    state = 'done';
  }

  $('#pz-next').addEventListener('click', () => load());
  $('#pz-an').addEventListener('click', () => { if (pz) openAnalysis(pz.fen, [], pz.side); });
  $('#pz-retry').addEventListener('click', () => {
    if (!pz) return;
    retried = true;
    $('#pz-result').classList.add('hidden');
    ui.board.setPosition(pz.fen, { legal: pz.legal, check: pz.check, movable: pz.side });
    state = 'solving';
  });
  $('#pz-show').addEventListener('click', async () => {
    if (!pz) return;
    const best = lastRes?.explanation?.best || (await (async () => {
      // not attempted yet: ask the engine without scoring the puzzle
      ui.busy(true);
      try { return (await api('./api/analyse', { fen: pz.fen, moves: [] })).lines[0]?.uci[0]; } finally { ui.busy(false); }
    })());
    if (!best) return;
    if (state === 'solving') { retried = true; state = 'done'; }
    ui.board.setPosition(pz.fen, { legal: [] });
    await sleep(250);
    ui.board.setPosition(toFen(applyUci(pz.fen, best)), { lastMove: best, animate: true });
    ui.board.setArrows([{ uci: best, color: 'green' }]);
    ui.board.setBadge(best.slice(2, 4), 'best');
  });
  $$('.chip[data-k]', root).forEach((c) => c.addEventListener('click', () => {
    kind = c.dataset.k;
    store.set('trainKind', kind);
    $$('.chip[data-k]', root).forEach((x) => x.classList.toggle('on', x === c));
    load();
  }));
  load();
  return {
    key(e) {
      if (e.key === 'Enter' && state !== 'checking') { e.preventDefault(); load(); }
    },
    flip() { ui.board.flip(); ui.evalbar.setOrientation(ui.board.orientation); },
  };
}

// ------------------------------------------------------------------ 4. My Games

async function viewGames(root, arg) {
  if (arg) return viewGameDetail(root, arg);
  const f = { result: '', q: '', source: 'chesscom', ...store.get('gamesFilter', {}) };
  root.innerHTML = `<div class="games">
    <div class="toolbar">
      <div class="seg nocap" id="g-src">${[['chesscom', 'chess.com games'], ['coach', 'My practice games']].map(([v, l]) => `<button data-v="${v}" class="${f.source === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" id="g-res">${[['', 'All'], ['win', 'Wins'], ['loss', 'Losses'], ['draw', 'Draws']].map(([v, l]) => `<button data-v="${v}" class="${f.result === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <input type="search" id="g-q" placeholder="Search opening or opponent…" value="${esc(f.q)}">
    </div>
    <div id="g-list" class="game-list"><div class="loading-page"><div class="spinner"></div></div></div>
  </div>`;
  async function load() {
    store.set('gamesFilter', f);
    const qs = new URLSearchParams();
    if (f.result) qs.set('result', f.result);
    if (f.q) qs.set('q', f.q);
    if (f.source === 'coach') qs.set('source', 'coach');
    let list;
    try { list = await api('./api/games?' + qs); } catch { $('#g-list').innerHTML = '<p class="muted">Could not load games.</p>'; return; }
    $('#g-list').innerHTML = list.length ? list.map((g) => `
      <a class="game-row" href="#games/${encodeURIComponent(g.id)}">
        <span class="g-date muted small">${esc(g.date)}</span>
        <span class="side-dot ${g.color}" title="${g.color}"></span>
        <span class="res res-${g.result}">${g.result === 'win' ? 'W' : g.result === 'loss' ? 'L' : '½'}</span>
        <span class="g-opp"><b>${esc(g.opp_name)}</b> <span class="muted small">${g.opp_rating ?? ''}</span></span>
        <span class="g-open muted small">${esc(g.opening || '')}</span>
        <span class="g-tc muted small">${g.time_control ? esc(fmtTc(g.time_control)) : ''}</span>
        <span class="g-badges">${g.analyzed ? '' : '<span class="pill pending">analysing…</span>'}${g.blunders ? `<span class="pill" style="background:${CLASS_INFO.blunder.color}">${g.blunders} ??</span>` : ''}${g.highlights ? `<span class="pill" style="background:${CLASS_INFO.great.color}">${g.highlights} !</span>` : ''}</span>
      </a>`).join('') : `<p class="muted">${f.source === 'coach' ? 'No practice games yet. Finish a game in the Play tab and it shows up here with a coach review.' : 'No games match.'}</p>`;
  }
  $$('#g-src button', root).forEach((b) => b.addEventListener('click', () => {
    f.source = b.dataset.v;
    $$('#g-src button', root).forEach((x) => x.classList.toggle('on', x === b));
    load();
  }));
  $$('#g-res button', root).forEach((b) => b.addEventListener('click', () => {
    f.result = b.dataset.v;
    $$('#g-res button', root).forEach((x) => x.classList.toggle('on', x === b));
    load();
  }));
  let t;
  $('#g-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 300); });
  load();
}

const fmtTc = (tc) => { const [b, inc] = String(tc).split('+'); const m = +b / 60; return (Number.isInteger(m) ? m : m.toFixed(1)) + (inc ? '+' + inc : '+0'); };

async function viewGameDetail(root, gid) {
  root.innerHTML = boardLayout(`<div class="loading-page"><div class="spinner"></div><p class="muted">Loading game (unanalysed games are analysed now, may take a while)…</p></div>`);
  const ui = mountBoard(root, { movable: 'none' });
  let data;
  try { data = await api(`./api/games/${encodeURIComponent(gid)}`); } catch { $('.panel', root).innerHTML = '<p class="muted">Game not found.</p><a href="#games">← Back</a>'; return; }
  const { meta, moves } = data;
  if (data.error && !moves.length) {
    $('.panel', root).innerHTML = `<div class="card">
      <a href="#games" class="small">← All games</a>
      <div class="g-title">${esc({ win: 'Won', loss: 'Lost', draw: 'Draw' }[meta?.result] || meta?.result || '')} vs <b>${esc(meta?.opp_name || '')}</b></div>
      <div class="callout threat" style="margin-top:.8rem">${esc(data.error)}</div>
      ${data.pgn ? `<pre class="pgn">${esc(data.pgn)}</pre><div class="btn-row"><button class="btn small-btn" id="g-cpgn">Copy PGN</button><button class="btn small-btn" id="g-an">Open in Analysis</button></div>` : ''}
    </div>`;
    $('#g-cpgn')?.addEventListener('click', () => copyText(data.pgn, 'PGN copied'));
    $('#g-an')?.addEventListener('click', () => { S.pendingAnalysis = { pgn: data.pgn }; location.hash = '#analysis'; });
    return {};
  }
  if (data.pending || !moves.length) {
    ui.board.setOrientation(meta.color || 'white');
    $('.panel', root).innerHTML = `<div class="card">
      <a href="#games" class="small">← All games</a>
      <div class="g-title">${esc({ win: 'Won', loss: 'Lost', draw: 'Draw' }[meta.result] || meta.result || '')} vs <b>${esc(meta.opp_name || '')}</b></div>
      <div class="muted small">${esc(meta.date || '')} · ${esc(meta.my_code || '')}</div>
      ${data.pending ? '<div class="row-spin" style="margin:.8rem 0"><span class="spinner sm"></span> Coach review in progress… this page refreshes by itself.</div>' : '<p class="muted">No moves in this game.</p>'}
      ${data.pgn ? `<pre class="pgn">${esc(data.pgn)}</pre><div class="btn-row"><button class="btn small-btn" id="g-cpgn">Copy PGN</button></div>` : ''}
    </div>`;
    $('#g-cpgn')?.addEventListener('click', () => copyText(data.pgn, 'PGN copied'));
    let timer = null;
    if (data.pending) {
      const tick = async () => {
        try {
          const d = await api(`./api/games/${encodeURIComponent(gid)}`, undefined, { quiet: true });
          if (!d.pending) { if (location.hash === '#games/' + encodeURIComponent(gid) || decodeURIComponent(location.hash) === '#games/' + gid) route(); return; }
        } catch { /* retry */ }
        timer = setTimeout(tick, 5000);
      };
      timer = setTimeout(tick, 5000);
    }
    return { destroy() { clearTimeout(timer); } };
  }
  const N = moves.length;
  let finalPos = null;
  if (N) {
    try { finalPos = await api('./api/position', { fen: moves[N - 1].fen_before, moves: [moves[N - 1].uci] }, { quiet: true }); } catch { /* fall back to local */ }
  }
  const fenAt = (i) => (i < N ? moves[i].fen_before : finalPos?.fen || toFen(applyUci(moves[N - 1].fen_before, moves[N - 1].uci)));
  let ply = 0;
  ui.board.setOrientation(meta.color);
  ui.evalbar.setOrientation(meta.color);
  const resTxt = { win: 'Won', loss: 'Lost', draw: 'Draw' }[meta.result] || meta.result;
  $('.panel', root).innerHTML = `
    <div class="card tight">
      <a href="#games" class="small">← All games</a>
      <div class="g-title"><span class="res res-${meta.result}">${esc(resTxt)}</span> vs <b>${esc(meta.opp_name)}</b> <span class="muted">(${meta.opp_rating ?? '?'})</span></div>
      <div class="muted small">${esc(meta.date)} · ${meta.time_control ? esc(fmtTc(meta.time_control)) : ''} · you ${esc(meta.color)}${meta.my_rating ? ` (${meta.my_rating})` : ''} · ${esc(meta.my_code || '')}${meta.url ? ` · <a href="${esc(meta.url)}" target="_blank" rel="noopener">chess.com ↗</a>` : ' · practice game'}</div>
      <div class="muted small">${esc(meta.opening || '')}</div>
    </div>
    <div class="evalgraph card tight" id="gr"></div>
    <div class="tabs2" id="rv-tabs"><button data-tab="move">Move</button><button data-tab="coach">Coach's view</button></div>
    <div class="card" id="cur"></div>
    <div class="card hidden" id="why"></div>
    <div class="card ins-card hidden" id="g-ins"><div class="ins-bar"><h3>Coach's view</h3><span class="ins-spin hidden"><span class="spinner sm"></span></span><span class="muted small" id="g-ins-for"></span></div><div id="g-ins-body"></div></div>
    <div class="card"><div class="movelist review" id="mlist"></div></div>`;
  $('.under-board', root).innerHTML = `<div class="btn-row nav">
      <button class="btn" id="n-first" title="Start (Home)">⏮</button><button class="btn" id="n-prev" title="Previous (←)">◀</button>
      <button class="btn" id="n-next" title="Next (→)">▶</button><button class="btn" id="n-last" title="End">⏭</button>
      <button class="btn" id="n-mist" title="Jump to my next mistake or blunder (m)">My next mistake ▸</button>
      <button class="btn" id="n-an" title="Open this position on the analysis board">Analyse</button>
      <button class="btn" id="n-flip" title="Flip (F)">⇅</button>
    </div>`;

  // move list
  const first = parseFen(moves[0]?.fen_before || START_FEN);
  let html = '';
  if (first.turn === 'b' && N) html += `<span class="mv-no">${moves[0].move_no}.</span><span class="mv empty">…</span>`;
  moves.forEach((m, i) => {
    const white = / w /.test(m.fen_before);
    if (white) html += `<span class="mv-no">${m.move_no}.</span>`;
    const showCls = m.classification && (m.is_mine || ['blunder', 'mistake', 'brilliant', 'great'].includes(m.classification));
    html += `<span class="mv ${m.is_mine ? 'mine' : ''} ${showCls ? 'cls-' + m.classification : ''}" data-ply="${i + 1}">${esc(m.san)}${showCls ? badgeHtml(m.classification) : ''}</span>`;
  });
  $('#mlist').innerHTML = html;
  $('#mlist').addEventListener('click', (e) => { const t = e.target.closest('[data-ply]'); if (t) go(+t.dataset.ply); });

  // eval graph
  const W = 600, H = 120, clip = (v) => Math.max(-1000, Math.min(1000, v ?? 0));
  const y = (v) => H / 2 - (clip(v) / 1000) * (H / 2 - 4);
  const x = (i) => (N ? (i / N) * W : 0);
  const pts = [[0, y(20)], ...moves.map((m, i) => [x(i + 1), y(m.eval_white_after)])];
  const area = `M0,${H} ` + pts.map(([a, b]) => `L${a.toFixed(1)},${b.toFixed(1)}`).join(' ') + ` L${W},${H} Z`;
  const line = 'M' + pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' L');
  const dots = moves.map((m, i) => (m.is_mine && ['mistake', 'blunder', 'brilliant', 'great'].includes(m.classification)
    ? `<circle cx="${x(i + 1).toFixed(1)}" cy="${y(m.eval_white_after).toFixed(1)}" r="4" fill="${CLASS_INFO[m.classification].color}"/>` : '')).join('');
  $('#gr').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="graph">
      <rect width="${W}" height="${H}" class="g-bg"/><path d="${area}" class="g-area"/><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="g-mid"/>
      <path d="${line}" class="g-line" fill="none"/>${dots}<line id="g-cur" x1="0" x2="0" y1="0" y2="${H}" class="g-cur"/></svg>`;
  $('#gr svg').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    go(Math.round(((e.clientX - r.left) / r.width) * N));
  });

  let tab = store.get('reviewTab', 'move'), insTimer = null, insNo = 0, gInsInfo = null;
  function setTab(t) {
    tab = t;
    store.set('reviewTab', t);
    $$('#rv-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $('#cur').classList.toggle('hidden', t !== 'move');
    $('#g-ins').classList.toggle('hidden', t !== 'coach');
    if (t !== 'move') $('#why').classList.add('hidden');
    if (t === 'coach') scheduleIns(0);
  }
  function scheduleIns(delay = 400) {
    clearTimeout(insTimer);
    // options are for the student's decisions: on a ply showing my move, look at the position before it
    const myColor = meta.color;
    const turnAt = (k) => (/ w /.test(k < N ? moves[k].fen_before : fenAt(N)) ? 'white' : 'black');
    let at = ply;
    if (ply > 0 && turnAt(ply) !== myColor && moves[ply - 1].is_mine) at = ply - 1;
    const my = ++insNo;
    gInsInfo = null;
    $('#g-ins-body').classList.add('stale');
    $('#g-ins .ins-spin').classList.remove('hidden');
    const label = (k) => `${moves[k].move_no}${/ w /.test(moves[k].fen_before) ? '.' : '...'} ${moves[k].san}`;
    $('#g-ins-for').textContent = at !== ply ? `your options before ${label(ply - 1)}` : at ? `after ${label(at - 1)}` : 'start position';
    insTimer = setTimeout(async () => {
      const info = await fetchInsight({ fen: moves[0].fen_before, moves: moves.slice(0, at).map((mv) => mv.uci), pov: meta.color }, () => my !== insNo);
      if (my !== insNo) return;
      $('#g-ins .ins-spin').classList.add('hidden');
      $('#g-ins-body').classList.remove('stale');
      gInsInfo = info;
      $('#g-ins-body').innerHTML = info ? insightHtml(info, { level: 'full', suggest: true, optionsNote: turnAt(at) !== myColor ? 'Options appear on your moves — step to a position where you are to move (or onto one of your moves).' : '' }) : '<p class="muted small">Coach\'s view unavailable.</p>';
      if (info && at !== ply && moves[at]) {
        const played = moves[at];
        $('#g-ins-body').insertAdjacentHTML('afterbegin', `<p class="small muted">In the game you played <b>${esc(played.san)}</b> ${badgeHtml(played.classification)}. Compare with the options below.</p>`);
      }
      if (info) {
        const t = threatArrows(info).map((a) => ({ ...a, color: 'rgba(235,120,40,.85)' }));
        if (t.length) ui.board.setArrows([...ui.board.arrows, ...t]);
      }
    }, delay);
  }
  $$('#rv-tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  wireInsight($('#g-ins-body'), { board: ui.board, getInfo: () => gInsInfo, getSuggest: () => true, onCandidate: (uci) => ui.board.setArrows([{ uci, color: 'blue' }]) });
  function go(i) {
    const animate = i === ply + 1;
    ply = Math.max(0, Math.min(N, i));
    const m = ply > 0 ? moves[ply - 1] : null;
    const fen = fenAt(ply);
    const check = m ? /[+#]$/.test(m.san) : false;
    ui.board.setPosition(fen, { lastMove: m?.uci || null, check, legal: [], animate: animate && !!m });
    if (m) {
      ui.board.setBadge(m.uci.slice(2, 4), m.classification);
      if (m.best_uci && m.best_uci !== m.uci && ['inaccuracy', 'mistake', 'blunder'].includes(m.classification)) {
        ui.board.setArrows([{ uci: m.best_uci, color: 'green' }]);
      }
      ui.evalbar.set(m.eval_white_after);
    } else ui.evalbar.set(20);
    $('#g-cur').setAttribute('x1', x(ply)); $('#g-cur').setAttribute('x2', x(ply));
    $$('#mlist .mv').forEach((n) => n.classList.toggle('cur', +n.dataset.ply === ply));
    $(`#mlist [data-ply="${ply}"]`)?.scrollIntoView({ block: 'nearest' });
    $('#why').classList.add('hidden');
    if (tab === 'coach') scheduleIns();
    if (!m) { $('#cur').innerHTML = '<span class="muted">Start position. Use ← → or click a move.</span>'; return; }
    const dot = / w /.test(m.fen_before) ? '.' : '...';
    const bad = ['inaccuracy', 'mistake', 'blunder'].includes(m.classification);
    $('#cur').innerHTML = `
      <div class="cur-h"><b>${m.move_no}${dot} ${esc(m.san)}</b> ${badgeHtml(m.classification)} ${classLabel(m.classification)}
        <span class="muted small">${m.is_mine ? 'you' : 'opponent'}</span></div>
      <div class="kv"><span>Eval</span><b>${evalText(m.eval_white_after)}</b><span class="muted small">win% ${Math.round(m.win_before)} → ${Math.round(m.win_after)} (mover)</span></div>
      <div class="kv"><span>Time spent</span><b>${fmtSecs(m.time_spent)}</b><span class="muted small">${m.clock != null ? 'clock ' + fmtClock(m.clock) : ''}</span></div>
      ${m.best_san && m.best_uci !== m.uci ? `<div class="kv"><span>Best</span><b class="good-text">${esc(m.best_san)}</b></div>` : ''}
      ${m.pv ? `<div class="line-box"><span class="muted small">Engine line (before the move)</span><div class="line">${esc(m.pv)}</div></div>` : ''}
      <button class="btn small-btn" id="why-btn">${bad ? 'Why is this bad?' : 'Why?'}</button>`;
    $('#why-btn').addEventListener('click', () => why(m));
  }
  async function why(m) {
    const box = $('#why');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="row-spin"><div class="spinner sm"></div> Coach is analysing…</div>';
    const myPly = ply;
    try {
      const info = await api('./api/explain', { fen: m.fen_before, moves: [], uci: m.uci, llm: llmFlag() });
      if (ply !== myPly) return;
      S.lastContext = { fen: m.fen_before, source: `Game vs ${meta.opp_name}`, explanation: info };
      box.innerHTML = explanationHtml(info);
      const arrows = [];
      if (info.best && info.best !== m.uci) arrows.push({ uci: info.best, color: 'green' });
      const ref = ['inaccuracy', 'mistake', 'blunder'].includes(info.classification) ? await refutationUci(info) : null;
      if (ply !== myPly) return;
      if (ref) arrows.push({ uci: ref, color: 'red' });
      ui.board.setArrows(arrows);
    } catch { box.innerHTML = '<span class="muted">Could not explain this move.</span>'; }
  }
  const nextMistake = () => {
    for (let i = ply; i < N; i++) if (moves[i].is_mine && ['mistake', 'blunder'].includes(moves[i].classification)) { go(i + 1); return; }
    toast('No more mistakes in this game 🎉', 'info', 2000);
  };
  $('#n-first').onclick = () => go(0);
  $('#n-prev').onclick = () => go(ply - 1);
  $('#n-next').onclick = () => go(ply + 1);
  $('#n-last').onclick = () => go(N);
  $('#n-mist').onclick = nextMistake;
  const flip = () => { ui.board.flip(); ui.evalbar.setOrientation(ui.board.orientation); };
  $('#n-flip').onclick = flip;
  setTab(tab);
  $('#n-an').onclick = () => openAnalysis(moves[0].fen_before, moves.slice(0, ply).map((m) => m.uci), ui.board.orientation);
  go(0);
  return {
    key(e) {
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(ply - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(ply + 1); }
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(N);
      else if (e.key === 'm') nextMistake();
      else if (tab === 'coach' && /^[1-6]$/.test(e.key) && !e.metaKey && !e.ctrlKey && focusOption($('#g-ins-body'), +e.key)) e.preventDefault();
    },
    flip,
    destroy() { clearTimeout(insTimer); insNo++; },
  };
}

// ------------------------------------------------------------------ 5. Openings

async function viewOpenings(root, arg) {
  if (arg) return viewDrill(root, arg);
  root.innerHTML = '<div class="loading-page"><div class="spinner"></div></div>';
  const list = await api('./api/drills');
  root.innerHTML = `<div class="dash"><h1>Opening drills</h1>
    <p class="muted">Play your repertoire moves; the app plays the opponent. Study mode walks you through the notes, Test mode checks you.</p>
    <div class="grid3">${list.map((d) => `<a class="card drill-card" href="#openings/${encodeURIComponent(d.id)}">
      <span class="side-dot ${d.color} lg"></span><div><b>${esc(d.name)}</b><div class="muted small">${d.lines} lines · you play ${esc(d.color)}</div></div></a>`).join('')}</div></div>`;
}

async function viewDrill(root, did) {
  root.innerHTML = boardLayout('<div class="loading-page"><div class="spinner"></div></div>');
  const D = await api(`./api/drills/${encodeURIComponent(did)}`);
  const ui = mountBoard(root, { orientation: D.color, movable: D.color, onMove: (u) => onStudent(u) });
  $('.evalbar-host', root).classList.add('hidden');
  let mode = store.get('drillMode', 'test');
  $('.panel', root).innerHTML = `
    <div class="card tight"><a href="#openings" class="small">← All drills</a>
      <div class="g-title">${esc(D.name)}</div><div class="muted small">You play ${esc(D.color)}</div></div>
    <div class="card">
      <div class="form-row"><label>Mode</label><div class="seg" id="d-mode">
        <button data-v="study" class="${mode === 'study' ? 'on' : ''}">Study</button><button data-v="test" class="${mode === 'test' ? 'on' : ''}">Test</button></div></div>
      <div class="form-row"><label>Line</label><select id="d-line">
        <option value="random">🎲 Random line</option>
        <optgroup label="Lines">${D.lines.map((l, i) => `<option value="L${i}">${esc(l.name)}</option>`).join('')}</optgroup>
        ${(D.traps || []).length ? `<optgroup label="Traps">${D.traps.map((t, i) => `<option value="T${i}">⚠ ${esc(t.name)}</option>`).join('')}</optgroup>` : ''}
      </select></div>
      <div class="btn-row"><button class="btn primary" id="d-start">Start</button><button class="btn" id="d-restart">Restart line</button></div>
    </div>
    <div class="card" id="d-stage"><span class="muted">Choose a line and press Start.</span></div>
    <div class="btn-row nav hidden" id="d-nav"><button class="btn" id="d-prev">◀ Prev</button><button class="btn" id="d-next">Next ▶</button></div>
    ${(D.ideas || []).length ? `<details class="card" open><summary>Key ideas</summary><ul class="facts">${D.ideas.map((x) => `<li>${mdInline(x)}</li>`).join('')}</ul></details>` : ''}
    ${(D.traps || []).length ? `<details class="card"><summary>Traps</summary>${D.traps.map((t, i) => `<div class="trap"><b>${esc(t.name)}</b><p class="small">${esc(t.explanation)}</p><button class="btn small-btn" data-trap="${i}">Study this trap</button></div>`).join('')}</details>` : ''}`;

  let L = null; // {name, moves, notes, ucis, pos[], isTrap}
  let k = 0, errors = 0, phase = 'idle';
  const myColorChar = D.color[0];

  async function prepare(line, isTrap) {
    ui.busy(true, 'Preparing line…');
    try {
      const pos = [await api('./api/position', { fen: 'startpos', moves: [] })];
      const ucis = [];
      for (let i = 0; i < line.moves.length; i++) {
        const u = uciForSan(pos[i].fen, line.moves[i], pos[i].legal);
        if (!u) { toast(`Drill data: cannot play “${line.moves[i]}” at ply ${i + 1}`); break; }
        ucis.push(u);
        pos.push(await api('./api/position', { fen: 'startpos', moves: ucis }));
      }
      return { name: line.name, moves: line.moves.slice(0, ucis.length), notes: line.notes || {}, explanation: line.explanation, ucis, pos, isTrap };
    } finally { ui.busy(false); }
  }
  const moveLabel = (i) => `${Math.floor(i / 2) + 1}${i % 2 === 0 ? '.' : '...'} ${L.moves[i]}`;
  const noteFor = (i) => L.notes[String(i)];
  function lineHtml(upto) {
    const shown = mode === 'study' || L.isTrap ? L.moves.length : upto;
    const rest = L.moves.length - shown;
    return L.moves.slice(0, shown).map((s, i) => `${i % 2 === 0 ? `<span class="mv-no">${i / 2 + 1}.</span>` : ''}<span class="mv ${i < upto ? '' : 'future'} ${i === upto - 1 ? 'cur' : ''}">${esc(s)}</span>`).join('') +
      (rest > 0 ? `<span class="muted small">… ${rest} more</span>` : '');
  }
  function stage(extra = '') {
    const done = k >= L.moves.length;
    // notes for the last two plies (your move + their reply)
    const recent = [k - 2, k - 1].filter((i) => i >= 0 && noteFor(i));
    $('#d-stage').innerHTML = `
      <div class="pz-head"><b>${esc(L.name)}</b>${L.isTrap ? ' <span class="tag tag-missed">trap</span>' : ''}<span class="muted small">${Math.min(k, L.moves.length)}/${L.moves.length}</span></div>
      <div class="movelist inline">${lineHtml(k)}</div>
      ${recent.map((i) => `<div class="note info"><b>${esc(moveLabel(i))}</b> — ${mdInline(noteFor(i))}</div>`).join('')}
      ${extra}
      ${done && L.isTrap && L.explanation ? `<div class="callout habit">${esc(L.explanation)}</div>` : ''}`;
  }
  function showStudy() {
    const p = L.pos[k];
    ui.board.setPosition(p.fen, { lastMove: k ? L.ucis[k - 1] : null, check: p.check, legal: [] });
    if (k < L.ucis.length) ui.board.setArrows([{ uci: L.ucis[k], color: (k % 2 === 0) === (myColorChar === 'w') ? 'green' : 'blue' }]);
    stage(k < L.moves.length ? `<div class="muted small">Next: <b>${esc(moveLabel(k))}</b> ${(k % 2 === 0) === (myColorChar === 'w') ? '(your move)' : '(opponent)'}</div>` : '<div class="verdict ok">End of line.</div>');
  }
  const isMine = (i) => (i % 2 === 0) === (myColorChar === 'w');

  async function advanceTest() {
    while (k < L.moves.length && !isMine(k)) {
      await sleep(k === 0 ? 300 : 450);
      if (phase !== 'test') return;
      k++;
      const p = L.pos[k];
      ui.board.setPosition(p.fen, { lastMove: L.ucis[k - 1], check: p.check, legal: [], animate: true });
      stage();
    }
    if (k >= L.moves.length) {
      phase = 'done';
      const ok = errors === 0;
      stage(`<div class="verdict ${ok ? 'ok' : 'bad'}">${ok ? '✓ Line complete, no mistakes!' : `Line complete with ${errors} mistake(s). Try it again.`}</div>`);
      if (!L.isTrap) api(`./api/drills/${encodeURIComponent(did)}/result`, { line: L.name, correct: ok }, { quiet: true }).catch(() => {});
      return;
    }
    const p = L.pos[k];
    ui.board.setPosition(p.fen, { lastMove: k ? L.ucis[k - 1] : null, check: p.check, legal: p.legal, movable: D.color });
    stage(`<div class="muted small">Your move.</div>`);
  }

  async function onStudent(uci) {
    if (phase !== 'test' || !isMine(k)) return;
    const p = L.pos[k];
    const played = normSan(sanFor(p.fen, uci, p.legal));
    const expected = normSan(L.moves[k]);
    if (played === expected) {
      ui.board.setBadge(uci.slice(2, 4), 'best');
      k++;
      stage();
      await sleep(250);
      advanceTest();
    } else {
      errors++;
      ui.board.setBadge(uci.slice(2, 4), 'mistake');
      const n = noteFor(k);
      phase = 'wrong';
      stage(`<div class="verdict bad">✗ ${esc(played)} — expected <b>${esc(L.moves[k])}</b></div>${n ? `<div class="note info">${mdInline(n)}</div>` : ''}<div class="muted small">Play the expected move to continue.</div>`);
      await sleep(900);
      if (phase !== 'wrong') return;
      phase = 'test';
      ui.board.setPosition(p.fen, { lastMove: k ? L.ucis[k - 1] : null, check: p.check, legal: p.legal, movable: D.color });
      ui.board.setArrows([{ uci: L.ucis[k], color: 'green' }]);
    }
  }

  async function start(sel) {
    let line, isTrap = false;
    if (sel === 'random') line = D.lines[Math.floor(Math.random() * D.lines.length)];
    else if (sel[0] === 'T') { line = D.traps[+sel.slice(1)]; isTrap = true; }
    else line = D.lines[+sel.slice(1)];
    phase = 'loading';
    L = await prepare(line, isTrap);
    k = 0; errors = 0;
    const study = mode === 'study' || isTrap;
    $('#d-nav').classList.toggle('hidden', !study);
    if (study) { phase = 'study'; showStudy(); } else { phase = 'test'; stage(); advanceTest(); }
  }
  let lastSel = 'random';
  $('#d-start').onclick = () => { lastSel = $('#d-line').value; start(lastSel); };
  $('#d-restart').onclick = () => { if (L) start(lastSel === 'random' ? 'L' + D.lines.findIndex((l) => l.name === L.name) : lastSel); };
  $$('#d-mode button', root).forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.v; store.set('drillMode', mode);
    $$('#d-mode button', root).forEach((x) => x.classList.toggle('on', x === b));
    if (L) $('#d-restart').click();
  }));
  $$('[data-trap]', root).forEach((b) => b.addEventListener('click', () => { lastSel = 'T' + b.dataset.trap; $('#d-line').value = lastSel; start(lastSel); }));
  const step = (d) => { if (phase !== 'study') return; k = Math.max(0, Math.min(L.moves.length, k + d)); showStudy(); };
  $('#d-prev').onclick = () => step(-1);
  $('#d-next').onclick = () => step(1);
  ui.board.setPosition(START_FEN, { legal: [] });
  return {
    key(e) {
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    },
    flip() { ui.board.flip(); },
  };
}

// ------------------------------------------------------------------ 6. Ask Coach

async function viewCoach(root) {
  if (!S.dash) { try { S.dash = await api('./api/dashboard'); S.llm = !!S.dash.llm; updateLlmToggle(); } catch { /* ignore */ } }
  if (!S.llm) {
    root.innerHTML = `<div class="dash narrow"><div class="card">
      <h2>Ask Coach is off</h2>
      <p>The conversational coach uses Claude. To enable it, add your API key to <code>.env</code> in the project folder and restart the app:</p>
      <pre><code>ANTHROPIC_API_KEY=sk-ant-...</code></pre>
      <p class="muted">Everything else (puzzles from your games, sparring with the coach, game review, opening drills) works without it — the move explanations come from Stockfish + rules.</p>
    </div></div>`;
    return;
  }
  root.innerHTML = `<div class="dash narrow"><div class="card chat">
    <h2>Ask Coach</h2>
    <div id="ctx" class="muted small"></div>
    <div class="chat-log" id="log"></div>
    <form id="ask" class="chat-form"><textarea id="q" rows="2" placeholder="Ask about your games, a position, your plan…"></textarea>
      <button class="btn primary" type="submit">Send</button></form>
    <label class="small muted"><input type="checkbox" id="use-ctx" checked> include the last position/explanation</label>
  </div></div>`;
  const ctx = S.lastContext;
  $('#ctx').innerHTML = ctx ? `Context: ${esc(ctx.source)} — <code>${esc(ctx.fen)}</code>` : 'No position context yet (solve a puzzle or review a game first).';
  const draw = () => {
    $('#log').innerHTML = S.chat.length ? S.chat.map((m) => `<div class="msg ${m.role}">${m.role === 'assistant' ? renderMarkdown(m.content) : esc(m.content)}</div>`).join('') : '<p class="muted">E.g. “Why do I keep hanging pieces in the middlegame?” or “What should I do this week?”</p>';
    $('#log').scrollTop = 1e6;
  };
  draw();
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask').requestSubmit(); } });
  $('#ask').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#q').value.trim();
    if (!q) return;
    const history = S.chat.slice(-10);
    S.chat.push({ role: 'user', content: q });
    $('#q').value = '';
    draw();
    $('#log').insertAdjacentHTML('beforeend', '<div class="msg assistant pending"><div class="spinner sm"></div></div>');
    const c = $('#use-ctx').checked && ctx ? { fen: ctx.fen, last_explanation: ctx.explanation, source: ctx.source } : null;
    try {
      const r = await api('./api/coach/ask', { question: q, context: c, history });
      S.chat.push({ role: 'assistant', content: r.answer });
    } catch (err) {
      S.chat.pop();
      $('#q').value = q;
    }
    draw();
  });
}

// ------------------------------------------------------------------ shell: routing, theme, LLM toggle

const VIEWS = { dashboard: viewDashboard, train: viewTrain, play: viewPlay, analysis: viewAnalysis, games: viewGames, openings: viewOpenings, coach: viewCoach };
let current = null;

async function route() {
  const [name, ...rest] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  const view = VIEWS[name] ? name : 'dashboard';
  $$('a[data-view]').forEach((a) => a.classList.toggle('on', a.dataset.view === view));
  const root = $('#view');
  try { current?.destroy?.(); } catch (e) { console.error(e); }
  current = null;
  root.innerHTML = '';
  const token = Symbol(view);
  route.token = token;
  try {
    const handle = await VIEWS[view](root, rest.length ? decodeURIComponent(rest.join('/')) : null);
    if (route.token === token) current = handle || null;
    else handle?.destroy?.();
  } catch (e) {
    console.error(e);
    if (route.token === token && !root.innerHTML.trim()) root.innerHTML = `<div class="card"><p>Something went wrong: ${esc(e.message)}</p></div>`;
  }
  window.scrollTo(0, 0);
}


function initTheme() {
  const saved = store.get('theme', null);
  if (saved) document.documentElement.dataset.theme = saved;
  $('#theme-btn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
  });
}

function initSound() {
  ChessBoard.sound = (kind) => sound.play(kind);
  const btn = $('#mute-btn');
  const upd = () => { btn.textContent = sound.muted ? '🔇' : '🔊'; btn.title = sound.muted ? 'Sound off' : 'Sound on'; };
  upd();
  btn.addEventListener('click', () => { sound.setMuted(!sound.muted); upd(); if (!sound.muted) sound.play('move'); });
}

function init() {
  initTheme();
  initSound();
  $('#llm-cb').addEventListener('change', (e) => { S.llmOn = e.target.checked; store.set('llmOn', S.llmOn); });
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-bg')) return;
    if (e.target.matches?.('textarea, input[type=search], input[type=text]')) return;
    if (e.key === 'Enter' && e.target.closest?.('button, a, select, summary')) return; // native activation handles it
    if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.matches?.('input, select')) {
      if (current?.flip) { e.preventDefault(); current.flip(); return; }
    }
    current?.key?.(e);
  });
  // background: learn whether the LLM layer is available (for the header toggle)
  api('./api/dashboard', undefined, { quiet: true }).then((d) => { if (!S.dash) S.dash = d; window.CC_USER = d.username || window.CC_USER; S.llm = !!d.llm; updateLlmToggle(); }).catch(() => {});
  route();
}

init();
