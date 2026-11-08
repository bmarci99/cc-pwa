// Play tab: a real game vs the engine with clocks, the coach watching, result handling and saving.
import {
  CLASS_INFO, START_FEN, parseFen, toFen, applyUci, sanFor, firstSan, buildPgn, materialInfo,
  insufficientToMate, evalText, PIECE_VALUE,
} from './board.js';
import {
  $, $$, esc, store, toast, api, badgeHtml, sideOf, S, llmFlag, mountBoard, explanationHtml,
  refutationUci, modal, ROUTINE_SHORT, renderMarkdown, copyText, downloadText, openAnalysis, fmtClockMs,
} from './ui.js';
import { sound } from './sound.js';
import { fetchInsight, insightHtml, threatArrows, wireInsight } from './insight.js';

const TIME_CONTROLS = [
  ['180+2', '3+2'], ['300+0', '5+0'], ['300+3', '5+3'], ['600+0', '10+0'], ['600+5', '10+5'],
  ['900+10', '15+10'], ['1800+0', '30+0'], ['-', 'Unlimited'],
];
const REASON_TEXT = {
  checkmate: 'by checkmate', resignation: 'by resignation', timeout: 'on time',
  'timeout vs insufficient material': 'timeout vs insufficient material', agreed: 'by agreement',
  stalemate: 'by stalemate', 'threefold repetition': 'by threefold repetition', 'fivefold repetition': 'by fivefold repetition',
  '50-move rule': 'by the 50-move rule', '75-move rule': 'by the 75-move rule', 'insufficient material': 'by insufficient material',
};
const other = (c) => (c === 'white' ? 'black' : 'white');

export async function viewPlay(root) {
  const cfg = { color: 'white', elo: 1500, mode: 'normal', start: 'initial', tc: '600+5', hints: 'full', ...store.get('playCfg', {}) };
  const view = { threatArrow: store.get('insThreatArrow', true), suggest: false };
  root.innerHTML = `<div class="layout play">
    <section class="board-col">
      <div class="player-bar" data-pos="top"></div>
      <div class="board-wrap">
        <div class="evalbar-host"></div>
        <div class="board-host">
          <div class="board-el"></div>
          <div class="board-overlay hidden"><div class="spinner"></div><span class="ov-text"></span></div>
          <div class="view-banner hidden"><span>Viewing an earlier position</span><button class="btn small-btn" id="pl-live">Back to game</button></div>
        </div>
      </div>
      <div class="player-bar" data-pos="bottom"></div>
      <div class="under-board"><div class="routine-line">${ROUTINE_SHORT}</div></div>
    </section>
    <aside class="panel">
      <details class="card" id="play-setup" open>
        <summary>New game <span class="muted small" id="pl-sum"></span></summary>
        <div class="setup-body">
          <div class="form-row"><label>Time control</label>
            <div class="tc-grid" id="pl-tc">${TIME_CONTROLS.map(([v, l]) => `<button data-v="${v}" class="${cfg.tc === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
          <div class="form-row"><label>Your colour</label>
            <div class="seg" id="pl-color">${['white', 'black', 'random'].map((c) => `<button data-v="${c}" class="${cfg.color === c ? 'on' : ''}">${c}</button>`).join('')}</div></div>
          <div class="form-row"><label>Engine Elo <b id="pl-elo-v">${cfg.elo}</b></label>
            <input type="range" id="pl-elo" min="1320" max="2400" step="20" value="${cfg.elo}"></div>
          <div class="form-row"><label>Start from</label>
            <select id="pl-start"><option value="initial">Initial position</option></select></div>
          <div class="form-row"><label>Coach mode</label>
            <div class="seg" id="pl-mode">${[['strict', 'Strict'], ['normal', 'Normal'], ['off', 'Off']].map(([v, l]) => `<button data-v="${v}" class="${cfg.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
          <p class="muted small" id="pl-mode-help"></p>
          <div class="form-row"><label>Coach's view (hints)</label>
            <div class="seg" id="pl-hints">${[['off', 'Off'], ['threats', 'Threats only'], ['full', 'Full']].map(([v, l]) => `<button data-v="${v}" class="${cfg.hints === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
          <button class="btn primary" id="pl-new">Start game</button>
        </div>
      </details>
      <div class="card ins-card hidden" id="pl-ins">
        <div class="ins-bar"><h3>Coach's view</h3><span class="ins-spin hidden"><span class="spinner sm"></span></span>
          <label class="mini-toggle" title="Draw the opponent's threat on the board"><input type="checkbox" id="pl-ins-arrow"> threat arrow</label>
          <label class="mini-toggle" id="pl-ins-sugg-wrap" title="Engine move suggestions (gives the answer away!)"><input type="checkbox" id="pl-ins-sugg"> engine suggestions</label>
        </div>
        <div id="pl-ins-body"><p class="muted small">Appears when it's your move.</p></div>
      </div>
      <div class="card" id="pl-game">
        <div class="pl-status" id="pl-status">Pick a time control and press “Start game”.</div>
        <div class="note-slot" id="pl-note"></div>
        <div class="movelist review" id="pl-moves"></div>
        <div class="btn-row">
          <button class="btn" id="pl-takeback" title="Take back your last move">↶ Takeback</button>
          <button class="btn" id="pl-draw">½ Offer draw</button>
          <button class="btn danger" id="pl-resign">⚑ Resign</button>
          <button class="btn" id="pl-hint">Hint</button>
          <button class="btn" id="pl-flip" title="Flip board (F)">⇅ Flip</button>
        </div>
      </div>
      <div class="card hidden" id="pl-over"></div>
      <div class="card hidden" id="pl-explain"></div>
    </aside>
  </div>`;

  const ui = mountBoard(root, { onMove: (u) => studentMove(u) });
  const modeHelp = { strict: 'Coach stops you on mistakes and blunders (clocks pause while it talks).', normal: 'Coach stops you on blunders (clocks pause while it talks).', off: 'No coach: a plain game. Review it afterwards in My Games.' };
  const saveCfg = () => store.set('playCfg', cfg);
  const setModeHelp = () => { $('#pl-mode-help').textContent = modeHelp[cfg.mode]; };
  setModeHelp();
  const seg = (id, key, after) => $$(`#${id} button`, root).forEach((b) => b.addEventListener('click', () => {
    cfg[key] = b.dataset.v; saveCfg();
    $$(`#${id} button`, root).forEach((x) => x.classList.toggle('on', x === b));
    after?.();
  }));
  seg('pl-color', 'color');
  seg('pl-mode', 'mode', () => { setModeHelp(); if (!G.started || G.over) G.mode = cfg.mode; syncInsUi(); renderInsight(); });
  seg('pl-hints', 'hints', () => { syncInsUi(); refreshInsight(); });
  seg('pl-tc', 'tc', () => { if (!G.started || G.over) renderBars(); });
  $('#pl-elo').addEventListener('input', (e) => { cfg.elo = +e.target.value; $('#pl-elo-v').textContent = cfg.elo; saveCfg(); });
  let startPositions = [];
  api('./api/play/start_positions', undefined, { quiet: true }).then((list) => {
    startPositions = list;
    $('#pl-start').innerHTML = '<option value="initial">Initial position</option>' +
      (list.length ? `<optgroup label="Convert a win (your games)">${list.map((p) => `<option value="${esc(p.id)}">${esc(p.date)} · ${esc((p.opening || '').slice(0, 38))} · ${Math.round(p.win_before)}%</option>`).join('')}</optgroup>` : '');
    $('#pl-start').value = list.some((p) => String(p.id) === String(cfg.start)) ? cfg.start : 'initial';
  }).catch(() => {});
  $('#pl-start').addEventListener('change', (e) => { cfg.start = e.target.value; saveCfg(); });

  // ------------------------------------------------------------ game state
  let gameNo = 0;
  const G = {
    started: false, over: false, busy: false, startFen: START_FEN, color: 'white', elo: 1500, mode: 'normal',
    moves: [], sans: [], cls: [], fens: [START_FEN], clockHist: [], clocksAfter: [], pos: null,
    tc: '-', base: 0, inc: 0, unlimited: true, clock: { white: 0, black: 0 }, running: null, lastTs: 0,
    viewPly: null, result: null, reason: null, savedId: null, pgn: null, reviewReady: false, lowWarned: false,
  };
  const engineColor = () => other(G.color);
  const myTurn = () => G.started && !G.over && G.pos && G.pos.turn === G.color;
  const lowThreshold = () => Math.max(10000, Math.min(30000, G.base * 100));

  // ------------------------------------------------------------ clocks
  const now = () => performance.now();
  function settle() {
    if (!G.running || G.unlimited) return;
    const t = now();
    G.clock[G.running] -= t - G.lastTs;
    G.lastTs = t;
  }
  function startClock(side) { settle(); G.running = side; G.lastTs = now(); renderBars(); }
  function stopClock() { settle(); G.running = null; renderBars(); }
  function addInc(side) { if (!G.unlimited) G.clock[side] += G.inc * 1000; }
  const timer = setInterval(() => {
    if (!G.running || G.over || G.unlimited) return;
    settle();
    const side = G.running;
    if (side === G.color && !G.lowWarned && G.clock[side] < lowThreshold()) { G.lowWarned = true; sound.play('low'); }
    if (G.clock[side] <= 0) { G.clock[side] = 0; flag(side); return; }
    renderClocks();
  }, 100);

  function flag(side) {
    const winner = other(side);
    if (insufficientToMate(G.fens[G.fens.length - 1], winner)) endGame('1/2-1/2', 'timeout vs insufficient material');
    else endGame(winner === 'white' ? '1-0' : '0-1', 'timeout');
  }

  // ------------------------------------------------------------ rendering
  function barHtml(color) {
    const isMe = color === G.color;
    const fen = G.viewPly != null ? G.fens[G.viewPly] : G.fens[G.fens.length - 1];
    const mat = materialInfo(fen);
    const caps = mat[color];
    const lead = color === 'white' ? mat.diff : -mat.diff;
    const name = isMe ? `You${window.CC_USER ? ` (${window.CC_USER})` : ''}` : `Stockfish ${G.elo}`;
    const capsHtml = caps.map((t) => `<img src="pieces/${color === 'white' ? 'b' : 'w'}${t}.svg" alt="${t}" class="cap">`).join('');
    const preview = !G.started && cfg.tc !== '-' ? +cfg.tc.split('+')[0] * 1000 : null;
    const ms = !G.started ? preview : G.unlimited ? null : G.clock[color];
    const active = G.running === color && !G.over;
    const low = !G.unlimited && G.started && ms < lowThreshold();
    return `<div class="pb-who"><span class="side-dot ${color}"></span><b>${esc(name)}</b></div>
      <div class="pb-caps">${capsHtml}${lead > 0 ? `<span class="pb-lead">+${lead}</span>` : ''}</div>
      <div class="clock ${active ? 'active' : ''} ${low ? 'low' : ''} ${G.unlimited ? 'unl' : ''}" data-clock="${color}">${fmtClockMs(ms)}</div>`;
  }
  function renderBars() {
    const bottom = ui.board.orientation;
    $('.player-bar[data-pos="bottom"]', root).innerHTML = barHtml(bottom);
    $('.player-bar[data-pos="top"]', root).innerHTML = barHtml(other(bottom));
  }
  function renderClocks() {
    for (const c of ['white', 'black']) {
      const el = $(`.clock[data-clock="${c}"]`, root);
      if (!el) continue;
      el.textContent = fmtClockMs(G.unlimited ? null : G.clock[c]);
      el.classList.toggle('active', G.running === c && !G.over);
      el.classList.toggle('low', !G.unlimited && G.clock[c] < lowThreshold());
    }
  }
  function renderMoves() {
    const st = parseFen(G.startFen);
    let n = st.full, white = st.turn === 'w', html = '';
    if (!white && G.sans.length) html += `<span class="mv-no">${n}.</span><span class="mv empty">…</span>`;
    G.sans.forEach((san, i) => {
      if (white) html += `<span class="mv-no">${n}.</span>`;
      const cur = (G.viewPly ?? G.sans.length) === i + 1;
      html += `<span class="mv ${G.cls[i] ? 'cls-' + G.cls[i] : ''} ${cur ? 'cur' : ''}" data-ply="${i + 1}">${esc(san)}${G.cls[i] ? badgeHtml(G.cls[i]) : ''}</span>`;
      if (!white) n++;
      white = !white;
    });
    const el = $('#pl-moves');
    el.innerHTML = html || '<span class="muted small" style="grid-column:1/-1">No moves yet.</span>';
    el.querySelector('.mv.cur')?.scrollIntoView({ block: 'nearest' });
  }
  const status = (t) => { $('#pl-status').innerHTML = t; };
  const note = (t, kind = '') => { $('#pl-note').innerHTML = t ? `<div class="note ${kind}">${t}</div>` : ''; };
  function showLive(animate = false) {
    G.viewPly = null;
    $('.view-banner', root).classList.add('hidden');
    const p = G.pos;
    ui.board.setPosition(p.fen, { legal: myTurn() && !G.busy ? p.legal : [], lastMove: p.last_move, check: p.check, movable: G.color, animate });
    renderMoves();
    renderBars();
    if (!animate) applyInsArrows();
  }
  function viewAt(ply) {
    const live = G.fens.length - 1;
    if (ply >= live || ply < 0 && live === 0) { showLive(); return; }
    G.viewPly = Math.max(0, ply);
    const i = G.viewPly;
    ui.board.setPosition(G.fens[i], { lastMove: i ? G.moves[i - 1] : null, check: i ? /[+#]$/.test(G.sans[i - 1]) : false, legal: [], animate: false, sound: true });
    $('.view-banner', root).classList.remove('hidden');
    renderMoves();
    renderBars();
  }
  $('#pl-live').addEventListener('click', () => showLive());
  $('#pl-moves').addEventListener('click', (e) => { const t = e.target.closest('[data-ply]'); if (t && G.started) viewAt(+t.dataset.ply); });

  // ------------------------------------------------------------ coach's view (insight)
  let insNo = 0, insInfo = null;
  $('#pl-ins-arrow').checked = view.threatArrow;
  function syncInsUi() {
    $('#pl-ins').classList.toggle('hidden', cfg.hints === 'off' || !G.started);
    const allowSugg = G.mode !== 'strict' && cfg.hints === 'full';
    $('#pl-ins-sugg-wrap').classList.toggle('hidden', !allowSugg);
    if (!allowSugg) { view.suggest = false; $('#pl-ins-sugg').checked = false; }
  }
  function renderInsight() {
    const body = $('#pl-ins-body');
    if (!insInfo) return;
    body.innerHTML = insightHtml(insInfo, { level: cfg.hints === 'threats' ? 'threats' : 'full', suggest: view.suggest, allowMoves: G.mode !== 'strict' });
    applyInsArrows();
  }
  function applyInsArrows() {
    if (!insInfo || G.viewPly != null || !myTurn()) return;
    const arrows = [];
    if (view.threatArrow) arrows.push(...threatArrows(insInfo).map((a) => ({ ...a, color: 'rgba(235,120,40,.85)' })));
    if (view.suggest && insInfo.candidates?.[0]) arrows.push({ uci: insInfo.candidates[0].uci, color: 'blue' });
    ui.board.setArrows(arrows);
  }
  function clearInsight(msg) {
    insNo++;
    insInfo = null;
    $('.ins-spin', root).classList.add('hidden');
    $('#pl-ins-body').classList.remove('stale');
    $('#pl-ins-body').innerHTML = `<p class="muted small">${msg}</p>`;
  }
  async function refreshInsight() {
    syncInsUi();
    if (cfg.hints === 'off' || !myTurn()) return;
    const my = ++insNo;
    const ply = G.moves.length, game = gameNo;
    $('.ins-spin', root).classList.remove('hidden');
    const info = await fetchInsight({ fen: G.startFen, moves: G.moves.slice(), pov: G.color },
      () => my !== insNo || game !== gameNo || ply !== G.moves.length || G.over);
    if (my !== insNo) return;
    $('.ins-spin', root).classList.add('hidden');
    if (!info) return;
    insInfo = info;
    renderInsight();
  }
  $('#pl-ins-arrow').addEventListener('change', (e) => { view.threatArrow = e.target.checked; store.set('insThreatArrow', view.threatArrow); if (view.threatArrow) applyInsArrows(); else if (myTurn()) ui.board.setArrows([]); });
  $('#pl-ins-sugg').addEventListener('change', (e) => { view.suggest = e.target.checked; renderInsight(); if (!view.suggest && myTurn()) applyInsArrows(); });
  wireInsight($('#pl-ins-body'), {
    board: ui.board, getInfo: () => (G.viewPly == null && myTurn() ? insInfo : null), getSuggest: () => view.suggest,
    onCandidate: (uci) => { if (myTurn()) ui.board.setArrows([{ uci, color: 'blue' }]); },
  });

  // ------------------------------------------------------------ game flow
  async function newGame() {
    const sp = startPositions.find((p) => String(p.id) === String(cfg.start));
    gameNo++;
    closeResult();
    G.startFen = sp ? sp.fen : START_FEN;
    G.color = sp ? sideOf(sp.fen) : cfg.color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : cfg.color;
    G.elo = cfg.elo; G.mode = cfg.mode; G.tc = cfg.tc;
    G.unlimited = cfg.tc === '-';
    const [b, inc] = cfg.tc.split('+').map(Number);
    G.base = G.unlimited ? 0 : b; G.inc = G.unlimited ? 0 : inc || 0;
    Object.assign(G, {
      started: true, over: false, busy: false, moves: [], sans: [], cls: [], fens: [toFen(parseFen(G.startFen))], clocksAfter: [],
      clock: { white: G.base * 1000, black: G.base * 1000 }, running: null, viewPly: null, result: null, reason: null,
      savedId: null, pgn: null, reviewReady: false, lowWarned: false, saveState: null,
    });
    G.clockHist = [{ ...G.clock }];
    ui.board.setOrientation(G.color);
    ui.evalbar.setOrientation(G.color);
    ui.evalbar.set(sp ? (G.color === 'white' ? 1 : -1) * 250 : 20);
    $('#play-setup').open = false;
    clearInsight('Appears when it\'s your move.');
    syncInsUi();
    $('#pl-sum').textContent = `· ${TIME_CONTROLS.find(([v]) => v === G.tc)?.[1]} · you ${G.color} · Elo ${G.elo} · coach ${G.mode}`;
    $('#pl-explain').classList.add('hidden');
    $('#pl-over').classList.add('hidden');
    note(sp ? `From your game (${esc(sp.date)}): you were ${Math.round(sp.win_before)}% to win. Trade pieces, kill counterplay, ask “what's their only threat?”` : '');
    try { G.pos = await api('./api/position', { fen: G.startFen, moves: [] }); } catch { G.started = false; return; }
    showLive();
    if (G.pos.turn !== G.color) { startClock(engineColor()); await engineMove(); }
    else { status(`You play <b>${G.color}</b>. Your move.`); startClock(G.color); refreshInsight(); }
  }

  async function engineMove() {
    const my = gameNo;
    G.busy = true;
    status('Engine is thinking…');
    let r;
    try {
      r = await api('./api/play/engine_move', { fen: G.startFen, moves: G.moves, elo: G.elo });
    } catch {
      if (my !== gameNo || G.over) return;
      G.busy = false;
      stopClock();
      status('Engine error. Press “Takeback” or start a new game.');
      return;
    }
    if (my !== gameNo || G.over) return;
    stopClock();
    G.busy = false;
    if (r.uci) {
      const san = sanFor(G.pos.fen, r.uci, G.pos.legal) || r.san;
      addInc(engineColor());
      G.moves.push(r.uci);
      G.sans.push(bare(r.san || san) + suffix(r));
      G.cls.push(null);
      G.fens.push(r.fen);
      G.clocksAfter.push(G.unlimited ? null : G.clock[engineColor()] / 1000);
      G.clockHist.push({ ...G.clock });
    }
    G.pos = r;
    showLive(!!r.uci);
    if (r.game_over) { endGame(r.result, r.reason); return; }
    status(`Your move${r.check ? ' — <b>you are in check</b>' : ''}.`);
    startClock(G.color);
    refreshInsight();
  }
  const suffix = (p) => (p.check ? (p.game_over && p.reason === 'checkmate' ? '#' : '+') : '');
  const bare = (san) => String(san || '').replace(/[+#]+$/, '');

  async function studentMove(uci) {
    if (!myTurn() || G.busy || G.viewPly != null) { showLive(); return; }
    stopClock();
    const snap = { ...G.clock };
    G.busy = true;
    note('');
    clearInsight('Updating after the engine replies…');
    const my = gameNo;
    const beforePos = G.pos;
    let info = null;
    if (G.mode !== 'off') {
      ui.busy(true, 'Coach is looking…');
      try {
        info = await api('./api/play/check', { fen: G.startFen, moves: G.moves, uci, coach: 'warn', llm: llmFlag() });
      } catch { info = null; }
      ui.busy(false);
      if (my !== gameNo) return;
      if (info) {
        S.lastContext = { fen: info.fen_before, source: 'Play vs Coach', explanation: info };
        const c = info.classification;
        ui.board.setBadge(uci.slice(2, 4), c);
        const blocking = G.mode === 'strict' ? ['mistake', 'blunder'] : ['blunder'];
        if (blocking.includes(c)) {
          const ref = await refutationUci(info);
          if (ref) ui.board.setArrows([{ uci: ref, color: 'red' }]);
          sound.play('bad');
          const choice = await modal(`
            <div class="modal-h" style="color:${CLASS_INFO[c].color}">${badgeHtml(c)} Hold on — that's a ${c}</div>
            <p>${esc(info.facts?.[0] || 'This move loses a lot.')}</p>
            ${info.threat ? `<p class="muted">Their threat was <b>${esc(info.threat.san)}</b>${info.threat.desc ? ' — ' + esc(info.threat.desc) : ''}.</p>` : ''}
            ${info.coach_text ? `<div class="callout coach">${renderMarkdown(info.coach_text)}</div>` : ''}
            <p class="muted small">${esc(info.tip || '')}</p>
            <p class="muted small">⏸ Clocks are paused.</p>`,
          [{ label: 'Take it back', value: 'back', cls: 'primary' }, { label: 'Play it anyway', value: 'play' }]);
          if (my !== gameNo) return;
          if (choice === 'back') {
            G.clock = { ...snap };
            G.busy = false;
            showLive();
            if (info.threat?.uci) ui.board.setArrows([{ uci: info.threat.uci, color: 'red' }]);
            note(`Taken back. ${info.threat ? `Watch their threat <b>${esc(info.threat.san)}</b> (red arrow). ` : ''}Press “Hint” for the best move.`, 'warn');
            startClock(G.color);
            refreshInsight();
            return;
          }
        } else if (c === 'inaccuracy') {
          note(`${badgeHtml(c)} Inaccuracy. ${esc(info.facts?.[0] || '')} <span class="muted">Best was ${esc(info.best_san)}.</span>`, 'inacc');
        } else if (c === 'mistake') {
          note(`${badgeHtml(c)} Mistake. ${esc(info.facts?.[0] || '')}`, 'warn');
        } else if (c === 'brilliant' || c === 'great') {
          note(`${badgeHtml(c)} <b>${c === 'brilliant' ? 'Brilliant!!' : 'Great move!'}</b> ${esc(info.facts?.[0] || '')}`, 'celebrate');
          celebrate(c);
        }
        const ev = info.eval_after;
        ui.evalbar.set(G.color === 'white' ? ev : -ev);
        $('#pl-explain').classList.remove('hidden');
        $('#pl-explain').innerHTML = explanationHtml(info, { title: 'Your last move' });
      }
    }
    // commit the move
    G.clock = { ...snap };
    addInc(G.color);
    const real = beforePos.legal.includes(uci) ? uci : uci + 'q';
    const san = info?.played_san || sanFor(beforePos.fen, real, beforePos.legal);
    G.moves.push(real);
    G.cls.push(info?.classification || null);
    G.clocksAfter.push(G.unlimited ? null : G.clock[G.color] / 1000);
    G.clockHist.push({ ...G.clock });
    let after;
    try { after = await api('./api/position', { fen: G.startFen, moves: G.moves }); } catch { after = null; }
    if (my !== gameNo) return;
    if (!after) { // network trouble: undo
      G.moves.pop(); G.cls.pop(); G.clocksAfter.pop(); G.clockHist.pop();
      G.clock = { ...snap }; G.busy = false; showLive(); startClock(G.color); return;
    }
    G.sans.push(bare(san) + suffix(after));
    G.fens.push(after.fen);
    G.pos = after;
    if (after.check) sound.play('check');
    renderMoves();
    renderBars();
    if (after.game_over) { G.busy = false; endGame(after.result, after.reason); return; }
    startClock(engineColor());
    await engineMove();
  }

  function celebrate(c) {
    const el = document.createElement('div');
    el.className = 'celebrate';
    el.style.color = CLASS_INFO[c].color;
    el.textContent = CLASS_INFO[c].sym;
    $('.board-host', root).appendChild(el);
    sound.play('good');
    setTimeout(() => el.remove(), 1400);
  }

  // ------------------------------------------------------------ game end, saving, review polling
  function resultInfo() {
    const r = G.result;
    const won = (r === '1-0' && G.color === 'white') || (r === '0-1' && G.color === 'black');
    const title = r === '1/2-1/2' ? 'Draw' : won ? 'You won!' : 'You lost';
    return { title, won, sub: REASON_TEXT[G.reason] || G.reason || '' };
  }
  function localPgn() {
    return buildPgn({
      startFen: G.startFen, sans: G.sans, result: G.result || '*',
      headers: { White: G.color === 'white' ? (window.CC_USER || 'Me') : `Stockfish ${G.elo}`, Black: G.color === 'black' ? (window.CC_USER || 'Me') : `Stockfish ${G.elo}`, TimeControl: G.unlimited ? '-' : G.tc, Termination: G.reason || '' },
    });
  }
  const pgnText = () => G.pgn || localPgn();
  const pgnName = () => `chess-coach-${new Date().toISOString().slice(0, 10)}-${G.color}-vs-stockfish${G.elo}.pgn`;

  function overActionsHtml() {
    const saved = G.savedId
      ? (G.reviewReady ? '<span class="good-text">✓ Coach review ready</span>' : '<span class="row-spin small"><span class="spinner sm"></span> Game saved — coach review in progress…</span>')
      : G.saveState === 'saving' ? '<span class="row-spin small"><span class="spinner sm"></span> Saving…</span>'
        : G.saveState === 'skipped' ? '<span class="muted small">Too short to save.</span>'
          : G.saveState === 'failed' ? '<span class="muted small">Could not save the game.</span>' : '';
    return `<div class="save-line">${saved}</div>
      <div class="btn-row">
        ${G.savedId ? `<button class="btn primary" data-act="review" ${G.reviewReady ? '' : 'disabled'}>Review with coach</button>` : ''}
        <button class="btn" data-act="rematch">Rematch</button>
        <button class="btn" data-act="new">New game</button>
      </div>
      <div class="btn-row" style="margin-top:.5rem">
        <button class="btn small-btn" data-act="copy">Copy PGN</button>
        <button class="btn small-btn" data-act="download">Download PGN</button>
        <button class="btn small-btn" data-act="analyse">Analyse</button>
      </div>`;
  }
  function renderOver() {
    const { title, sub, won } = resultInfo();
    const box = $('#pl-over');
    box.classList.remove('hidden');
    box.innerHTML = `<div class="over-h ${won ? 'ok' : G.result === '1/2-1/2' ? '' : 'bad'}">${title} <span class="muted">${esc(G.result)} · ${esc(sub)}</span></div>${overActionsHtml()}`;
    const m = $('.result-modal');
    if (m) $('.rm-actions', m).innerHTML = overActionsHtml();
  }
  function onOverAction(act) {
    if (act === 'review' && G.savedId) { closeResult(); location.hash = '#games/' + encodeURIComponent(G.savedId); }
    else if (act === 'rematch') { closeResult(); newGame(); }
    else if (act === 'new') { closeResult(); $('#play-setup').open = true; $('#play-setup').scrollIntoView({ block: 'nearest' }); }
    else if (act === 'copy') copyText(pgnText(), 'PGN copied');
    else if (act === 'download') downloadText(pgnText(), pgnName());
    else if (act === 'analyse') { closeResult(); openAnalysis(G.startFen, G.moves); }
    else if (act === 'close') closeResult();
  }
  root.addEventListener('click', (e) => { const b = e.target.closest('#pl-over [data-act]'); if (b) onOverAction(b.dataset.act); });
  function closeResult() { $('.result-modal')?.remove(); }
  function showResultModal() {
    closeResult();
    const { title, sub, won } = resultInfo();
    const counts = {};
    G.cls.forEach((c) => { if (c) counts[c] = (counts[c] || 0) + 1; });
    const summary = Object.keys(CLASS_INFO).filter((k) => counts[k]).map((k) => `<span class="sum-item">${badgeHtml(k)} ${counts[k]}</span>`).join('');
    const m = document.createElement('div');
    m.className = 'modal-bg result-modal';
    m.innerHTML = `<div class="modal result" role="dialog">
      <div class="result-h ${won ? 'ok' : G.result === '1/2-1/2' ? 'draw' : 'bad'}">${title}</div>
      <div class="result-sub">${esc(G.result)} · ${esc(sub)}</div>
      ${summary ? `<div class="result-sum">${summary}</div>` : ''}
      <div class="rm-actions">${overActionsHtml()}</div>
      <button class="icon-btn rm-close" data-act="close" aria-label="Close">✕</button>
    </div>`;
    m.addEventListener('click', (e) => {
      if (e.target === m) { closeResult(); return; }
      const b = e.target.closest('[data-act]');
      if (b) onOverAction(b.dataset.act);
    });
    document.body.appendChild(m);
  }

  let pollTimer = null;
  async function saveGame() {
    if (!G.moves.some((_, i) => (parseFen(G.fens[i]).turn === 'w' ? 'white' : 'black') === G.color)) { G.saveState = 'skipped'; renderOver(); return; }
    G.saveState = 'saving';
    renderOver();
    const payload = buildSavePayload(G);
    try {
      const r = await api('./api/play/save', payload);
      G.savedId = r.id;
      G.pgn = r.pgn;
      G.saveState = 'saved';
      renderOver();
      poll(r.id);
    } catch { G.saveState = 'failed'; renderOver(); }
  }
  function poll(id) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try {
        const d = await api(`./api/games/${encodeURIComponent(id)}`, undefined, { quiet: true });
        if (!d.pending) {
          if (G.savedId === id) { G.reviewReady = true; renderOver(); toast('Coach review is ready', 'info', 2500); }
          return;
        }
      } catch { /* retry */ }
      poll(id);
    }, 5000);
  }

  function endGame(result, reason) {
    if (G.over) return;
    G.over = true;
    G.result = result;
    G.reason = reason;
    stopClock();
    G.busy = false;
    sound.play('end');
    clearInsight('Game over — open the coach review or the Analysis tab for the full picture.');
    showLive();
    const { title, sub } = resultInfo();
    status(`<b>${title}</b> ${esc(result)} — ${esc(sub)}`);
    renderOver();
    showResultModal();
    saveGame();
  }

  // ------------------------------------------------------------ buttons
  $('#pl-new').addEventListener('click', () => newGame());
  const flip = () => { ui.board.flip(); ui.evalbar.setOrientation(ui.board.orientation); renderBars(); };
  $('#pl-flip').addEventListener('click', flip);
  $('#pl-resign').addEventListener('click', async () => {
    if (!G.started || G.over) return;
    const ok = await modal('<div class="modal-h">Resign this game?</div>', [{ label: 'Resign', value: true, cls: 'primary' }, { label: 'Cancel', value: false }]);
    if (ok && !G.over) endGame(G.color === 'white' ? '0-1' : '1-0', 'resignation');
  });
  $('#pl-draw').addEventListener('click', async () => {
    if (!myTurn() || G.busy) { if (G.started && !G.over) toast('Offer a draw on your move.', 'info', 2000); return; }
    const full = parseFen(G.pos.fen).full;
    if (full < 30) { note(`½ The engine declines: draw offers are considered from move 30 (now move ${full}).`); return; }
    G.busy = true;
    const my = gameNo;
    note('<span class="row-spin small"><span class="spinner sm"></span> The engine is considering your draw offer…</span>');
    try {
      const r = await api('./api/analyse', { fen: G.startFen, moves: G.moves });
      if (my !== gameNo || G.over) return;
      const cp = r.lines[0]?.eval_white_cp ?? 0;
      const forEngine = engineColor() === 'white' ? cp : -cp;
      G.busy = false;
      if (forEngine <= 30) { note(''); endGame('1/2-1/2', 'agreed'); }
      else { note(`½ The engine declines the draw (it thinks it is better: ${evalText(forEngine)}).`); showLive(); }
    } catch { G.busy = false; note(''); }
  });
  $('#pl-takeback').addEventListener('click', async () => {
    if (!G.started || G.over || G.busy || !G.moves.length) return;
    const my = gameNo;
    stopClock();
    // pop back to the latest position where it's my move (at least one ply)
    do {
      G.moves.pop(); G.sans.pop(); G.cls.pop(); G.fens.pop(); G.clocksAfter.pop(); G.clockHist.pop();
    } while (G.moves.length && sideOf(G.fens[G.fens.length - 1]) !== G.color);
    G.clock = { ...G.clockHist[G.clockHist.length - 1] };
    G.busy = true;
    try { G.pos = await api('./api/position', { fen: G.startFen, moves: G.moves }); } finally { G.busy = false; }
    if (my !== gameNo) return;
    note('↶ Move taken back.');
    $('#pl-explain').classList.add('hidden');
    showLive();
    if (G.pos.turn !== G.color) { startClock(engineColor()); await engineMove(); }
    else { status('Your move.'); startClock(G.color); refreshInsight(); }
  });
  $('#pl-hint').addEventListener('click', async () => {
    if (!myTurn() || G.busy) return;
    ui.busy(true, 'Looking for a hint…');
    try {
      const r = await api('./api/analyse', { fen: G.startFen, moves: G.moves });
      const u = r.lines[0]?.uci?.[0];
      if (u && myTurn()) { ui.board.setArrows([{ uci: u, color: 'blue' }]); note(`Hint: <b>${esc(firstSan(r.lines[0].line))}</b>.`); }
    } finally { ui.busy(false); }
  });

  renderBars();
  renderMoves();
  ui.board.setPosition(START_FEN, { legal: [] });

  return {
    key(e) {
      if (e.target.matches('input, textarea, select')) return;
      if (!G.started) return;
      const live = G.fens.length - 1;
      const cur = G.viewPly ?? live;
      if (e.key === 'ArrowLeft') { e.preventDefault(); viewAt(cur - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (cur + 1 >= live) showLive(); else viewAt(cur + 1); }
      else if (e.key === 'Home') viewAt(0);
      else if (e.key === 'End') showLive();
    },
    flip,
    destroy() { clearInterval(timer); clearTimeout(pollTimer); gameNo++; closeResult(); },
  };
}

/** Payload for POST /api/play/save (exported for the smoke test). */
export function buildSavePayload(G) {
  return {
    fen: G.startFen === START_FEN ? 'startpos' : G.startFen,
    moves: G.moves.slice(),
    color: G.color,
    elo: G.elo,
    result: G.result,
    reason: G.reason || '',
    time_control: G.unlimited ? '-' : G.tc,
    clocks: G.unlimited ? [] : G.clocksAfter.map((c) => Math.max(0, Math.round((c ?? 0) * 10) / 10)),
  };
}

export { TIME_CONTROLS, REASON_TEXT, PIECE_VALUE };
