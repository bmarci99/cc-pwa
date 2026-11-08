// Analysis tab: free board for both sides, engine lines, "why is this move bad?", FEN/PGN import & export.
import { START_FEN, parseFen, sanFor, uciForSan, parsePgn, buildPgn, evalText } from './board.js';
import {
  $, $$, esc, store, toast, api, S, llmFlag, mountBoard, explanationHtml, refutationUci, copyText, downloadText,
} from './ui.js';
import { fetchInsight, insightHtml, threatArrows, wireInsight, focusOption } from './insight.js';

export async function viewAnalysis(root) {
  root.innerHTML = `<div class="layout">
    <section class="board-col">
      <div class="board-wrap">
        <div class="evalbar-host"></div>
        <div class="board-host">
          <div class="board-el"></div>
          <div class="board-overlay hidden"><div class="spinner"></div><span class="ov-text"></span></div>
        </div>
      </div>
      <div class="under-board">
        <div class="btn-row nav">
          <button class="btn" id="a-first" title="Start (Home)">⏮</button><button class="btn" id="a-prev" title="Back (←)">◀</button>
          <button class="btn" id="a-next" title="Forward (→)">▶</button><button class="btn" id="a-last" title="End">⏭</button>
          <button class="btn" id="a-flip" title="Flip (F)">⇅</button>
        </div>
      </div>
    </section>
    <aside class="panel">
      <div class="card">
        <div class="eng-head"><h3>Engine</h3>
          <label class="switch" title="Run Stockfish on every position"><input type="checkbox" id="a-eng"><span class="sw"></span><span class="sw-label">on</span></label></div>
        <div id="a-lines" class="eng-lines"><span class="muted small">Make a move or load a position.</span></div>
      </div>
      <div class="card ins-card" id="a-ins">
        <div class="ins-bar"><h3>Coach's view</h3><span class="ins-spin hidden"><span class="spinner sm"></span></span>
          <div class="seg small-seg nocap" id="a-pov">${[['auto', 'Side to move'], ['white', 'White'], ['black', 'Black']].map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}</div>
        </div>
        <div id="a-ins-body"><p class="muted small">Loading…</p></div>
      </div>
      <div class="card">
        <div class="movelist review" id="a-moves"></div>
        <div class="btn-row" style="margin-top:.6rem">
          <button class="btn small-btn" id="a-why">Why is this move bad?</button>
          <button class="btn small-btn" id="a-undo">Delete last move</button>
          <button class="btn small-btn" id="a-reset">Reset board</button>
        </div>
      </div>
      <div class="card hidden" id="a-why-box"></div>
      <details class="card" id="a-io">
        <summary>Load / export FEN or PGN</summary>
        <textarea id="a-text" rows="4" placeholder="Paste a FEN or a PGN, then press Load"></textarea>
        <div class="btn-row" style="margin-top:.5rem">
          <button class="btn primary small-btn" id="a-load">Load</button>
          <button class="btn small-btn" id="a-cfen">Copy FEN</button>
          <button class="btn small-btn" id="a-cpgn">Copy PGN</button>
          <button class="btn small-btn" id="a-dpgn">Download PGN</button>
        </div>
        <div class="muted small" id="a-fen" style="margin-top:.5rem;overflow-wrap:anywhere"></div>
      </details>
    </aside>
  </div>`;
  const ui = mountBoard(root, { movable: 'both', onMove: (u) => play(u) });
  const A = { startFen: START_FEN, moves: [], positions: [], sans: [], cursor: 0 };
  let engineOn = store.get('analysisEngine', true);
  $('#a-eng').checked = engineOn;

  const suffix = (p) => (p.check ? (p.reason === 'checkmate' ? '#' : '+') : '');
  const posAt = (i) => A.positions[i];

  let loadNo = 0;
  async function load(startFen, moves, cursor = null) {
    const my = ++loadNo;
    ui.busy(true, 'Loading…');
    const B = { positions: [], moves: [], sans: [] };
    try {
      const first = await api('./api/position', { fen: startFen || 'startpos', moves: [] });
      B.startFen = first.fen;
      B.positions = [first];
      for (const u of moves) {
        const prev = B.positions[B.positions.length - 1];
        const real = prev.legal.includes(u) ? u : prev.legal.find((m) => m.startsWith(u)) || null;
        if (!real) { toast(`Illegal move ${u} at ply ${B.moves.length + 1}; stopped there.`); break; }
        const p = await api('./api/position', { fen: B.startFen, moves: [...B.moves, real] });
        if (my !== loadNo) return;
        B.sans.push(sanFor(prev.fen, real, prev.legal) + suffix(p));
        B.moves.push(real);
        B.positions.push(p);
      }
    } catch { return; } finally { ui.busy(false); }
    if (my !== loadNo) return;
    Object.assign(A, B);
    A.cursor = cursor == null ? A.moves.length : Math.min(cursor, A.moves.length);
    render();
  }

  async function play(uci) {
    const prev = posAt(A.cursor);
    const nextMoves = [...A.moves.slice(0, A.cursor), uci];
    let p;
    try { p = await api('./api/position', { fen: A.startFen, moves: nextMoves }); } catch { render(); return; }
    const san = sanFor(prev.fen, uci, prev.legal) + suffix(p);
    // continuing the main line? keep the rest
    if (A.moves[A.cursor] === uci) { A.cursor++; render(false, true); return; }
    A.moves = nextMoves;
    A.sans = [...A.sans.slice(0, A.cursor), san];
    A.positions = [...A.positions.slice(0, A.cursor + 1), p];
    A.cursor++;
    render(false, true);
  }

  function go(i, animate = false) {
    A.cursor = Math.max(0, Math.min(A.moves.length, i));
    render(animate);
  }

  function render(animate = false, alreadyShown = false) {
    const p = posAt(A.cursor);
    const last = A.cursor ? A.moves[A.cursor - 1] : null;
    if (alreadyShown) {
      // board already shows the move (preview); just refresh legal moves / check
      ui.board.setPosition(p.fen, { legal: p.legal, lastMove: last, check: p.check, movable: 'both', sound: false });
      if (p.check) ui.board.constructor.sound?.('check');
    } else {
      ui.board.setPosition(p.fen, { legal: p.legal, lastMove: last, check: p.check, movable: 'both', animate });
    }
    const st = parseFen(A.startFen);
    let n = st.full, white = st.turn === 'w', html = '';
    if (!white && A.sans.length) html += `<span class="mv-no">${n}.</span><span class="mv empty">…</span>`;
    A.sans.forEach((san, i) => {
      if (white) html += `<span class="mv-no">${n}.</span>`;
      html += `<span class="mv ${A.cursor === i + 1 ? 'cur' : ''}" data-ply="${i + 1}">${esc(san)}</span>`;
      if (!white) n++;
      white = !white;
    });
    $('#a-moves').innerHTML = html || '<span class="muted small" style="grid-column:1/-1">No moves. Drag pieces for either side.</span>';
    $('#a-moves .mv.cur')?.scrollIntoView({ block: 'nearest' });
    $('#a-fen').textContent = p.fen;
    $('#a-why').disabled = !A.cursor;
    $('#a-why-box').classList.add('hidden');
    S.lastContext = { fen: p.fen, source: 'Analysis board', explanation: null };
    engArrows = []; insArrows = [];
    scheduleEngine();
    scheduleInsight();
  }

  let povSel = store.get('analysisPov', 'auto');
  const syncPov = () => $$('#a-pov button').forEach((b) => b.classList.toggle('on', b.dataset.v === povSel));
  syncPov();
  $$('#a-pov button').forEach((b) => b.addEventListener('click', () => { povSel = b.dataset.v; store.set('analysisPov', povSel); syncPov(); scheduleInsight(); }));
  let insTimer = null, insNo = 0, insInfo = null;
  function scheduleInsight() {
    clearTimeout(insTimer);
    const my = ++insNo;
    const cursor = A.cursor, moves = A.moves.slice(0, cursor);
    insInfo = null;
    $('#a-ins-body').classList.add('stale');
    $('#a-ins .ins-spin').classList.remove('hidden');
    insTimer = setTimeout(async () => {
      const info = await fetchInsight({ fen: A.startFen, moves, pov: povSel === 'auto' ? null : povSel }, () => my !== insNo);
      if (my !== insNo) return;
      $('#a-ins .ins-spin').classList.add('hidden');
      $('#a-ins-body').classList.remove('stale');
      if (!info) { $('#a-ins-body').innerHTML = '<p class="muted small">Coach\'s view unavailable for this position.</p>'; return; }
      insInfo = info;
      $('#a-ins-body').innerHTML = insightHtml(info, { level: 'full', suggest: true });
      insArrows = threatArrows(info).map((a) => ({ ...a, color: 'rgba(235,120,40,.85)' }));
      drawArrows();
    }, 450);
  }
  wireInsight($('#a-ins-body'), {
    board: ui.board, getInfo: () => insInfo, getSuggest: () => true,
    onCandidate: (uci) => {
      const p = posAt(A.cursor);
      if (!p.legal.includes(uci)) return;
      ui.board.previewMove(uci);
      play(uci);
    },
  });

  let engTimer = null, engToken = 0;
  let engArrows = [], insArrows = [];
  const drawArrows = () => ui.board.setArrows([...engArrows, ...insArrows]);
  function scheduleEngine() {
    clearTimeout(engTimer);
    const p = posAt(A.cursor);
    if (p.game_over) {
      engToken++;
      $('#a-lines').innerHTML = `<div class="over-h">${esc(p.result)} <span class="muted">${esc(p.reason || '')}</span></div>`;
      ui.evalbar.set(p.result === '1-0' ? 10000 : p.result === '0-1' ? -10000 : 0);
      return;
    }
    if (!engineOn) { engToken++; $('#a-lines').innerHTML = '<span class="muted small">Engine off.</span>'; ui.evalbar.set(null); return; }
    $('#a-lines').innerHTML = '<div class="row-spin small"><span class="spinner sm"></span> Analysing…</div>';
    engTimer = setTimeout(async () => {
      const my = ++engToken;
      const cursor = A.cursor;
      let r;
      try { r = await api('./api/analyse', { fen: A.startFen, moves: A.moves.slice(0, cursor) }, { quiet: true }); } catch { r = null; }
      if (my !== engToken) return;
      if (!r) { $('#a-lines').innerHTML = '<span class="muted small">Engine unavailable.</span>'; return; }
      const lines = r.lines || [];
      ui.evalbar.set(lines[0]?.eval_white_cp ?? null);
      $('#a-lines').innerHTML = lines.map((l, i) => `<button class="eng-line" data-i="${i}" title="Play ${esc(l.uci?.[0] || '')}">
          <span class="eng-ev ${l.eval_white_cp >= 0 ? 'w' : 'b'}">${l.mate != null ? (l.mate < 0 ? '-' : '') + 'M' + Math.abs(l.mate) : evalText(l.eval_white_cp)}</span><span class="line-txt">${esc(l.line)}</span></button>`).join('') || '<span class="muted small">No lines.</span>';
      $$('#a-lines .eng-line').forEach((b) => b.addEventListener('click', () => { const u = lines[+b.dataset.i].uci?.[0]; if (u) { ui.board.previewMove(u); play(u); } }));
      engArrows = lines[0]?.uci?.[0] ? [{ uci: lines[0].uci[0], color: 'blue' }] : [];
      drawArrows();
    }, 350);
  }

  $('#a-eng').addEventListener('change', (e) => { engineOn = e.target.checked; store.set('analysisEngine', engineOn); scheduleEngine(); });
  $('#a-moves').addEventListener('click', (e) => { const t = e.target.closest('[data-ply]'); if (t) go(+t.dataset.ply); });
  $('#a-first').onclick = () => go(0);
  $('#a-prev').onclick = () => go(A.cursor - 1);
  $('#a-next').onclick = () => go(A.cursor + 1, true);
  $('#a-last').onclick = () => go(A.moves.length);
  const flip = () => { ui.board.flip(); ui.evalbar.setOrientation(ui.board.orientation); };
  $('#a-flip').onclick = flip;
  $('#a-reset').onclick = () => load('startpos', []);
  $('#a-undo').onclick = () => {
    if (!A.moves.length) return;
    A.moves.pop(); A.sans.pop(); A.positions.pop();
    A.cursor = Math.min(A.cursor, A.moves.length);
    render();
  };
  $('#a-why').onclick = async () => {
    if (!A.cursor) return;
    const box = $('#a-why-box');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="row-spin"><span class="spinner sm"></span> Coach is analysing the last move…</div>';
    const cursor = A.cursor;
    try {
      const info = await api('./api/explain', { fen: A.startFen, moves: A.moves.slice(0, cursor - 1), uci: A.moves[cursor - 1], llm: llmFlag() });
      if (cursor !== A.cursor) return;
      S.lastContext = { fen: info.fen_before, source: 'Analysis board', explanation: info };
      box.innerHTML = explanationHtml(info, { title: 'Last move' });
      const arrows = [];
      if (info.best && info.best !== info.played) arrows.push({ uci: info.best, color: 'green' });
      const ref = ['inaccuracy', 'mistake', 'blunder'].includes(info.classification) ? await refutationUci(info) : null;
      if (ref) arrows.push({ uci: ref, color: 'red' });
      ui.board.setArrows(arrows);
      ui.board.setBadge(info.played.slice(2, 4), info.classification);
    } catch { box.innerHTML = '<span class="muted">Could not explain this move.</span>'; }
  };
  const pgn = () => buildPgn({ startFen: A.startFen, sans: A.sans, headers: { Event: 'Chess Coach analysis' } });
  $('#a-cfen').onclick = () => copyText(posAt(A.cursor).fen, 'FEN copied');
  $('#a-cpgn').onclick = () => copyText(pgn(), 'PGN copied');
  $('#a-dpgn').onclick = () => downloadText(pgn(), 'chess-coach-analysis.pgn');
  $('#a-load').onclick = async () => {
    const text = $('#a-text').value.trim();
    if (!text) return;
    const looksFen = /^([rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+(\s|$)/.test(text);
    if (looksFen) {
      try { await api('./api/position', { fen: text, moves: [] }, { quiet: true }); } catch { toast('That FEN is not valid.'); return; }
      await load(text, []);
      return;
    }
    const { headers, sans } = parsePgn(text);
    if (!sans.length && !headers.FEN) { toast('No moves found. Paste a PGN (or a FEN).'); return; }
    const start = headers.FEN || 'startpos';
    ui.busy(true, 'Reading PGN…');
    try {
      let p = await api('./api/position', { fen: start, moves: [] });
      const ucis = [];
      for (const san of sans) {
        const u = uciForSan(p.fen, san, p.legal);
        if (!u) { toast(`Could not read move “${san}” (ply ${ucis.length + 1}); loaded up to there.`); break; }
        ucis.push(u);
        p = await api('./api/position', { fen: start, moves: ucis });
      }
      ui.busy(false);
      await load(start, ucis);
    } catch { ui.busy(false); toast('Could not read that PGN.'); }
  };

  const pending = S.pendingAnalysis;
  S.pendingAnalysis = null;
  if (pending?.pgn) {
    await load('startpos', []);
    $('#a-io').open = true;
    $('#a-text').value = pending.pgn;
    $('#a-load').click();
  } else if (pending) {
    const o = pending.orientation || (parseFen(pending.fen === 'startpos' ? START_FEN : pending.fen).turn === 'w' ? 'white' : 'black');
    ui.board.setOrientation(o);
    ui.evalbar.setOrientation(o);
    await load(pending.fen, pending.moves);
  } else await load('startpos', []);

  return {
    key(e) {
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(A.cursor - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(A.cursor + 1, true); }
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(A.moves.length);
      else if (/^[1-6]$/.test(e.key) && !e.metaKey && !e.ctrlKey && focusOption($('#a-ins-body'), +e.key)) e.preventDefault();
    },
    flip,
    destroy() { clearTimeout(engTimer); clearTimeout(insTimer); engToken++; insNo++; },
  };
}
