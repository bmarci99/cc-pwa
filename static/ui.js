// Shared UI utilities for Chess Coach views.
import { CLASS_INFO, parseFen, uciForSan, firstSan, normSan, ChessBoard, EvalBar } from './board.js';

// ------------------------------------------------------------------ utilities

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const store = {
  get(k, d) { try { const v = localStorage.getItem('cc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cc.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

export function toast(msg, kind = 'error', ms = 4200, action = null) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-btn';
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { t.remove(); action.run(); });
    t.appendChild(b);
  }
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

let offlineToast = null;
/** Network failure: the Mac is asleep / the app is closed / different Wi-Fi. One toast at a time, with Retry. */
function networkDown() {
  if (offlineToast && document.body.contains(offlineToast)) return;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  offlineToast = toast(local ? 'Cannot reach the Chess Coach server. Is it running?' : 'Can’t reach your Mac — is Chess Coach open on it and are you on the same Wi-Fi?',
    'error', 9000, { label: 'Retry', run: () => window.dispatchEvent(new HashChangeEvent('hashchange')) });
}

/** 401 from the server: this device has no access key (cookie) yet. */
function notConnected(detail) {
  if (document.querySelector('.offline-card')) return;
  const d = document.createElement('div');
  d.className = 'offline-card';
  d.innerHTML = `<div class="card"><div class="big-ic">📱</div>
    <h2>This device isn’t connected</h2>
    <p>Scan the QR code on your Mac (<b>Dashboard → Use on iPhone</b>) with the Camera app and open the link in Safari.</p>
    <p class="muted small">${esc(detail || '')}</p>
    <button class="btn" type="button">Try again</button></div>`;
  d.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(d);
}

export async function api(path, body, { method, quiet = false } = {}) {
  const opts = { method: method || (body !== undefined ? 'POST' : 'GET'), headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    if (!quiet) networkDown();
    throw e;
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { /* ignore */ }
    const err = new Error(detail);
    err.status = res.status;
    if (res.status === 401) notConnected(detail);
    else if (!quiet) toast(`${res.status}: ${detail}`);
    throw err;
  }
  return res.json();
}

export const badgeHtml = (cls) => {
  const i = CLASS_INFO[cls];
  return i ? `<span class="mini-badge" style="background:${i.color}" title="${i.label}">${i.sym}</span>` : '';
};
export const classLabel = (cls) => CLASS_INFO[cls] ? `<span class="cls-label" style="color:${CLASS_INFO[cls].color}">${CLASS_INFO[cls].label}</span>` : '';
export const sideOf = (fen) => (parseFen(fen).turn === 'w' ? 'white' : 'black');
export const fmtSecs = (s) => (s == null ? '' : s < 10 ? s.toFixed(1) + 's' : Math.round(s) + 's');
export const fmtClock = (s) => { if (s == null) return ''; const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

export const MOTIF_LABELS = {
  allowed_mate: 'Allowed mate', hung_piece: 'Hung a piece', moved_into_attack: 'Moved into attack',
  allowed_fork: 'Allowed a fork', allowed_pin: 'Allowed a pin', allowed_discovered: 'Allowed a discovered attack',
  trapped_piece: 'Trapped piece', ignored_threat: 'Ignored a threat', missed_mate: 'Missed mate',
  missed_win_material: 'Missed free material', missed_fork: 'Missed a fork', material_loss: 'Lost material in a line',
  positional: 'Positional', good: 'Good',
};

// ------------------------------------------------------------------ tiny markdown renderer

export function mdInline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, '%22')}" target="_blank" rel="noopener">${t}</a>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) { const n = hm[1].length; out.push(`<h${n}>${mdInline(hm[2])}</h${n}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      out.push('<div class="table-wrap"><table><thead><tr>' + head.map((c) => `<th>${mdInline(c)}</th>`).join('') +
        '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>');
      continue;
    }
    if (listRe.test(line)) {
      // nested lists by indentation
      const stack = [];
      let html = '';
      while (i < lines.length) {
        const l = lines[i];
        const m = listRe.exec(l);
        if (!m) {
          if (l.trim() && /^\s+/.test(l) && stack.length) { html = html.replace(/<\/li>$/, ' ' + mdInline(l.trim()) + '</li>'); i++; continue; }
          break;
        }
        const indent = m[1].length;
        const type = /\d/.test(m[2]) ? 'ol' : 'ul';
        while (stack.length && indent < stack[stack.length - 1].indent) html += `</${stack.pop().type}></li>`;
        const top = stack[stack.length - 1];
        if (!top || indent > top.indent) {
          if (top) html = html.replace(/<\/li>$/, '');
          html += `<${type}>`;
          stack.push({ type, indent });
        }
        html += `<li>${mdInline(m[3])}</li>`;
        i++;
      }
      while (stack.length) { html += `</${stack.pop().type}>`; if (stack.length) html += '</li>'; }
      out.push(html);
      continue;
    }
    const buf = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*\|)/.test(lines[i]) && !listRe.test(lines[i])) buf.push(lines[i++].trim());
    out.push(`<p>${mdInline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

/** Extract one "## heading" section (by keyword) from markdown. */
export function mdSection(src, keyword) {
  const lines = String(src || '').split('\n');
  const start = lines.findIndex((l) => /^##\s/.test(l) && l.toLowerCase().includes(keyword));
  if (start < 0) return null;
  let end = lines.findIndex((l, j) => j > start && /^#{1,2}\s/.test(l));
  if (end < 0) end = lines.length;
  return { title: lines[start].replace(/^#+\s*/, ''), body: lines.slice(start + 1, end).join('\n') };
}

// ------------------------------------------------------------------ shared UI pieces

export const S = {
  dash: null,
  llm: false,
  llmOn: store.get('llmOn', true),
  lastContext: null,   // {fen, explanation, source}
  chat: [],
  session: store.get('session', { attempted: 0, solved: 0, streak: 0, best: 0 }),
};
export const llmFlag = () => S.llm && S.llmOn;

export function boardLayout(panelHtml, { under = '' } = {}) {
  return `<div class="layout">
    <section class="board-col">
      <div class="board-wrap">
        <div class="evalbar-host"></div>
        <div class="board-host">
          <div class="board-el"></div>
          <div class="board-overlay hidden"><div class="spinner"></div><span class="ov-text">Engine is thinking…</span></div>
        </div>
      </div>
      <div class="under-board">${under}</div>
    </section>
    <aside class="panel">${panelHtml}</aside>
  </div>`;
}

export function mountBoard(root, opts) {
  const board = new ChessBoard($('.board-el', root), opts);
  const evalbar = new EvalBar($('.evalbar-host', root));
  evalbar.setOrientation(opts.orientation || 'white');
  const overlay = $('.board-overlay', root);
  let busyCount = 0;
  const busy = (on, text = 'Engine is thinking…') => {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    $('.ov-text', overlay).textContent = text;
    overlay.classList.toggle('hidden', busyCount === 0);
  };
  return { board, evalbar, busy };
}

export function explanationHtml(info, { gameMove = null, title = null } = {}) {
  if (!info) return '';
  const facts = (info.facts || []).map((f) => `<li>${esc(f)}</li>`).join('');
  const threat = info.threat
    ? `<div class="callout threat"><b>Their threat was ${esc(info.threat.san)}</b>${info.threat.desc ? ' — ' + esc(info.threat.desc) : ''}${info.threat.mate ? ` (mate in ${info.threat.mate})` : ''}${info.threat.line ? `<div class="line">${esc(info.threat.line)}</div>` : ''}</div>`
    : '';
  const coach = info.coach_text ? `<div class="callout coach"><div class="callout-h">Coach</div>${renderMarkdown(info.coach_text)}</div>` : '';
  const coachErr = info.coach_text_error ? `<div class="muted small">LLM coach unavailable: ${esc(info.coach_text_error)}</div>` : '';
  return `<div class="explain">
    ${title ? `<h3>${title}</h3>` : ''}
    <div class="ex-row">
      <span>You played <b>${esc(info.played_san)}</b> ${badgeHtml(info.classification)} ${classLabel(info.classification)}</span>
      <span class="muted small">win% ${info.win_before} → ${info.win_after}</span>
    </div>
    ${gameMove ? `<div class="ex-row"><span>In the real game you played <b>${esc(gameMove)}</b>${normSan(gameMove) === normSan(info.best_san) ? ' <span class="muted small">(the right move — the win slipped away later)</span>' : ''}</span></div>` : ''}
    ${info.best_san && info.best !== info.played ? `<div class="ex-row"><span>Best: <b class="good-text">${esc(info.best_san)}</b></span></div>` : ''}
    ${facts ? `<ul class="facts">${facts}</ul>` : ''}
    ${info.tip ? `<div class="callout habit"><div class="callout-h">Habit</div>${esc(info.tip)}</div>` : ''}
    ${threat}
    ${info.best_line ? `<div class="line-box"><span class="muted small">Engine line</span><div class="line">${esc(info.best_line)}</div></div>` : ''}
    ${info.refutation_line && ['mistake', 'blunder', 'inaccuracy'].includes(info.classification) ? `<div class="line-box"><span class="muted small">Their best reply</span><div class="line">${esc(info.refutation_line)}</div></div>` : ''}
    ${coach}${coachErr}
  </div>`;
}

/** UCI of the opponent's refutation (first move of refutation_line from fen_after). */
export async function refutationUci(info) {
  if (info?.refutation_uci?.length) return info.refutation_uci[0];
  const san = firstSan(info?.refutation_line);
  if (!san || !info.fen_after) return null;
  try {
    const p = await api('./api/position', { fen: info.fen_after, moves: [] }, { quiet: true });
    return uciForSan(p.fen, san, p.legal);
  } catch { return null; }
}

export function modal(html, buttons) {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal-bg';
    m.innerHTML = `<div class="modal" role="dialog">${html}<div class="modal-btns">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      m.remove();
      resolve(buttons[+b.dataset.i].value);
    });
    $('button', m)?.focus();
  });
}

export const ROUTINE_SHORT = '<b>Blunder-check:</b> What does their last move want? · Checks, captures, threats after my move?';


export function updateLlmToggle() {
  const t = $('#llm-toggle');
  t.classList.toggle('hidden', !S.llm);
  $('#llm-cb').checked = S.llmOn;
}

/** Copy text to the clipboard (falls back to execCommand for WKWebView / insecure contexts). */
export async function copyText(text, label = 'Copied') {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); toast(label, 'info', 1600); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) { toast(label, 'info', 1600); return true; }
  } catch { /* ignore */ }
  toast('Copy failed — select the text manually.');
  return false;
}

/** Offer a text file for download (blob link). */
export function downloadText(text, filename, type = 'application/x-chess-pgn') {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch {
    toast('Download not available here — use Copy PGN instead.');
  }
}

/** Open the Analysis tab with a position (start fen + optional UCI history). */
export function openAnalysis(fen, moves = [], orientation = null) {
  S.pendingAnalysis = { fen: fen || 'startpos', moves: moves || [], orientation };
  location.hash = '#analysis';
}

export function fmtClockMs(ms) {
  if (ms == null) return '∞';
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000), sec = Math.floor((t % 60000) / 1000);
  if (t < 20000) return `${m}:${String(sec).padStart(2, '0')}.${Math.floor((t % 1000) / 100)}`;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
