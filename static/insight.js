// "Coach's view" v2: renders POST /api/insight (headline, look-now list, last move intent, big goals, trumps, engine).
import { evalText } from './board.js';
import { esc, mdInline, renderMarkdown, api, llmFlag } from './ui.js';

const ENGINE_PLAN = /^engine'?s plan for you:\s*/i;
const ENGINE_IDEA = /^engine'?s idea:/i;
const THREAT_POINT = /^\*\*threat:?\*\*/i;
const URGENT_TAIL = /\s*⚠\s*First deal with the urgent issue below\.?\s*$/;

const DANGER = new Set(['threat', 'hanging_mine', 'back_rank', 'king_danger', 'fork_alert', 'pinned_mine']);
const OPPORTUNITY = new Set(['tactic', 'win_material', 'fork_chance', 'overload', 'pin', 'loose_enemy']);
const KIND_ICON = {
  mate: '♚', threat: '⚔', tactic: '✦', win_material: '＋', fork_chance: '⑂', hanging_mine: '⚠', back_rank: '▁',
  king_danger: '♔', overload: '⚖', pinned_mine: '📌', pin: '📌', fork_alert: '⑂', loose_enemy: '◎', loose_mine: '◌',
};
const TONE_COLOR = { danger: 'rgba(214,72,52,.55)', opp: 'rgba(110,180,70,.55)', info: 'rgba(150,150,150,.45)' };
const TONE_ARROW = { danger: 'rgba(225,95,45,.88)', opp: 'rgba(110,175,60,.88)', info: 'rgba(150,150,150,.8)' };

/** danger | opp | info for a look_now item */
export function lookTone(item, info) {
  if (item.kind === 'mate') return (info?.eval_pov ?? 0) >= 0 ? 'opp' : 'danger';
  if (DANGER.has(item.kind)) return 'danger';
  if (OPPORTUNITY.has(item.kind)) return 'opp';
  return 'info';
}

/** Text/squares/arrows actually shown for an item, honouring `reveals`. */
export function lookView(item, suggest) {
  const hide = item.reveals && !suggest;
  return { text: hide ? item.hint || item.text : item.text, squares: hide ? [] : item.squares || [], arrows: hide ? [] : item.arrows || [] };
}

/** Fetch insight; returns null when superseded (`isStale()` true) or on error. */
export async function fetchInsight({ fen = 'startpos', moves = [], pov = null }, isStale = () => false) {
  try {
    const r = await api('./api/insight', { fen, moves, pov, llm: llmFlag() }, { quiet: true });
    return isStale() ? null : r;
  } catch {
    return null;
  }
}

/** Base arrows for the opponent's threat (if any). */
export function threatArrows(info) {
  const t = info?.last_move?.threat;
  if (t?.uci && info.last_move.by !== info.pov) return [{ uci: t.uci, color: TONE_ARROW.danger }];
  const it = (info?.look_now || []).find((x) => x.kind === 'threat' && !x.reveals && x.arrows?.length);
  return it ? it.arrows.map(([from, to]) => ({ from, to, color: TONE_ARROW.danger })) : [];
}

/** "Nxf7 (knight takes pawn on f7)" -> "knight takes pawn on f7" */
export const prettyDesc = (desc, san) => String(desc || '').replace(new RegExp('^' + String(san || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*'), '').replace(/^\((.*)\)$/, '$1');

const evalLabel = (cp) => (Math.abs(cp) >= 9000 ? (cp > 0 ? 'mating' : 'getting mated') : evalText(cp));
const li = (t, cls = '') => `<li${cls ? ` class="${cls}"` : ''}>${mdInline(t)}</li>`;

function goalHow(how, suggest, theirs) {
  return (how || []).flatMap((h) => {
    if (!ENGINE_PLAN.test(h)) return [li(h)];
    if (!suggest) return [];
    return [li((theirs ? 'Engine sees their plan: ' : 'Engine’s plan for you: ') + h.replace(ENGINE_PLAN, ''), 'eng-idea')];
  }).join('');
}

/**
 * @param o.level 'full' | 'threats'
 * @param o.suggest engine-revealing content (engine plans, candidates, `reveals` items) allowed
 * @param o.candidates show candidate moves when `suggest` is on (default true)
 * @param o.lookMax items shown before "more"
 */
// ------------------------------------------------------------------ "Your options" menu

const VERDICT = {
  excellent: ['Best plan', 'v-best'], good: ['Good plan', 'v-good'], slower: ['Slower', 'v-slow'],
  'not now': ['Doesn’t work now', 'v-no'], idea: ['Long-term idea', 'v-idea'],
};
const URGENT_OPTS = new Set(['parry', 'tactic', 'grab']);
const MINE_OPTS = new Set(['fix_weakness', 'parry']);
const SPACE_OPTS = new Set(['outpost', 'open_file', 'develop', 'improve_piece', 'king_activity']);
const ringFor = (kind) => (MINE_OPTS.has(kind) ? 'ring-orange' : SPACE_OPTS.has(kind) ? 'ring-blue' : 'ring-red');

/** Board overlay for one option (targets ring + pieces glow + optional example arrow). */
export function optionOverlay(opt, { suggest = false, showMove = false } = {}) {
  if (!opt) return { squares: [], arrows: [] };
  const targets = opt.reveals_targets && !suggest && !showMove ? [] : opt.targets || [];
  const squares = [...targets.map((sq) => ({ sq, cls: ringFor(opt.kind) })), ...(opt.pieces || []).filter((p) => !targets.includes(p)).map((sq) => ({ sq, cls: 'glow' }))];
  const ex = opt.example;
  const arrows = showMove && ex?.from && ex?.to ? [{ from: ex.from, to: ex.to, color: opt.verdict === 'not now' ? 'rgba(212,64,58,.85)' : 'rgba(110,175,60,.9)' }] : [];
  return { squares, arrows };
}

export function optionsHtml(info, { allowMoves = true, max = 6 } = {}) {
  const opts = (info?.options || []).slice(0, max);
  if (!opts.length) return '';
  return `<section class="opts">
    <div class="opts-h">Your options</div>
    <p class="opts-intro">Here’s what you could do. <span class="hover-word">Hover</span><span class="tap-word">Tap</span> an option to see it on the board.</p>
    <ol class="opt-list">${opts.map((o, i) => {
    const [vl, vc] = VERDICT[o.verdict] || [o.verdict || '', 'v-idea'];
    const ex = o.example;
    return `<li class="opt ${URGENT_OPTS.has(o.kind) ? 'opt-urgent' : ''} ${o.verdict === 'not now' ? 'nogo' : ''}" data-opt="${i}">
      <div class="opt-head" role="button" tabindex="0" aria-expanded="false">
        <span class="opt-n">${i + 1}</span><span class="opt-ic" aria-hidden="true">${esc(o.icon || '•')}</span>
        <span class="opt-title">${mdInline(o.title)}</span><span class="vbadge ${vc}">${esc(vl)}</span>
      </div>
      <div class="opt-body">
        ${o.why ? `<p class="opt-why">${mdInline(o.why)}</p>` : ''}
        ${o.how ? `<p class="opt-how"><b>How:</b> ${mdInline(o.how)}</p>` : ''}
        ${o.verdict === 'not now' && o.not_now_reason ? `<p class="opt-no">✋ ${mdInline(o.not_now_reason)}</p>` : ''}
        ${allowMoves && ex ? `<button type="button" class="btn small-btn opt-show">Show me a move</button>
          <div class="opt-move hidden"><b class="san">${esc(ex.san)}</b> <span class="muted small">${esc(prettyDesc(ex.desc, ex.san))}</span>
            ${ex.is_engine_best ? '<span class="pill eng-best">engine’s top move</span>' : ''}
            ${ex.line ? `<div class="line">${esc(ex.line)}</div>` : ''}
            ${o.verdict_text ? `<p class="small muted opt-vt">${mdInline(o.verdict_text)}</p>` : ''}</div>` : ''}
      </div></li>`;
  }).join('')}</ol>
  </section>`;
}

export function insightHtml(info, { level = 'full', suggest = false, candidates = true, lookMax = 4, options = true, allowMoves = true, optionsNote = '' } = {}) {
  if (!info) return '<p class="muted small">No coach view for this position.</p>';
  const looks = (info.look_now || []).map((it, i) => ({ it, i, tone: lookTone(it, info) }));
  const shownLooks = level === 'threats' ? looks.filter((x) => x.tone === 'danger' || (x.it.kind === 'mate' && x.tone === 'danger')) : looks;
  const lookItem = ({ it, i, tone }, extra) => {
    const v = lookView(it, suggest);
    return `<li class="look ${tone} ${extra ? 'more' : ''}" data-look="${i}" tabindex="0" role="button" title="Show on the board">
      <span class="look-ic">${KIND_ICON[it.kind] || '•'}</span><span class="look-tx">${mdInline(v.text)}</span></li>`;
  };
  const lookHtml = `<section class="ins-sec look-sec">
      <div class="ins-h">⚡ Look now</div>
      ${shownLooks.length ? `<ul class="looks">${shownLooks.map((x, n) => lookItem(x, n >= lookMax)).join('')}</ul>
        ${shownLooks.length > lookMax ? `<button class="link-btn look-more" type="button">+${shownLooks.length - lookMax} more</button>` : ''}`
        : `<p class="muted small calm-line">${level === 'threats' ? 'No direct danger. Still: checks, captures, threats.' : 'Nothing forcing right now — follow your plan.'}</p>`}
    </section>`;
  if (level === 'threats') return `<div class="insight v2">${lookHtml}</div>`;

  // headline
  const w = info.win_pov ?? 50;
  const tone = w >= 60 ? 'good' : w <= 40 ? 'bad' : 'even';
  const urgent = URGENT_TAIL.test(info.headline || '');
  const headline = `<div class="ins-headline">
      <div class="hl-row"><span class="verdict-pill ${tone}">${esc(info.verdict || '')}</span>
        <span class="winbar" title="Win chance for ${esc(info.pov)}"><i style="width:${Math.max(2, Math.min(98, w))}%"></i></span><span class="win-n">${Math.round(w)}%</span>
        <span class="tag">${esc(info.phase || '')}</span></div>
      <p class="hl-text">${mdInline((info.headline || '').replace(URGENT_TAIL, ''))}${urgent ? ' <span class="urgent">⚠ deal with the urgent issue first</span>' : ''}</p>
    </div>`;

  // last move
  const lm = info.last_move;
  const hasThreatLook = looks.some((x) => x.it.kind === 'threat');
  const mine = lm && lm.by === info.pov;
  const points = (lm?.points || []).filter((p) => !(hasThreatLook && THREAT_POINT.test(p)));
  const intent = lm?.intent || [];
  const lastHtml = lm ? `<section class="ins-sec">
      <div class="ins-h">${mine ? '↪ Your last move' : '↩ Their last move'} — <b class="san">${esc(lm.san)}</b></div>
      ${points.length ? `<ul>${points.map((p) => li(p)).join('')}</ul>` : ''}
      ${intent.length ? `<p class="intent"><span>${mine ? 'Your idea' : 'What they’re up to'}:</span> ${intent.map((t) => mdInline(t.replace(/^(White|Black)['’]s idea:\s*/i, ''))).join(' · ')}</p>` : ''}
      ${!points.length && !intent.length ? '<p class="muted small">A quiet move.</p>' : ''}
    </section>` : '';

  // goals
  const g = info.big_goal;
  const goalHtml = g ? `<section class="ins-sec goal">
      <div class="ins-h">🎯 Your big goal: <b>${esc(g.title)}</b></div>
      ${g.why ? `<p class="why">${mdInline(g.why)}</p>` : ''}
      <ul>${goalHow(g.how, suggest, false)}</ul>
    </section>` : '';
  const og = info.opponent_goal;
  const theirHtml = og ? `<details class="ins-sec ins-fold">
      <summary>Their goal: <b>${esc(og.title)}</b></summary>
      ${og.why ? `<p class="why">${mdInline(og.why)}</p>` : ''}
      <ul>${goalHow(og.how, suggest, true)}</ul>
    </details>` : '';

  // trumps
  const imb = info.imbalances || [];
  const st = info.structure;
  const trumpsHtml = imb.length || st ? `<details class="ins-sec ins-fold">
      <summary>Trumps &amp; structure${st?.name ? `: <b>${esc(st.name)}</b>` : ''}</summary>
      ${imb.length ? `<div class="chips trumps">${imb.map((x, i) => `<button type="button" class="chip trump ${x.side === 'you' ? 'you' : x.side === 'them' ? 'them' : 'both'}" data-trump="${i}" title="${esc(x.text)}">${esc(x.label)}</button>`).join('')}</div>
        <p class="trump-text muted small hidden"></p>` : ''}
      ${st ? `<div class="struct">${st.you?.length ? `<div><span class="struct-h you">You</span><ul>${st.you.map((t) => li(t)).join('')}</ul></div>` : ''}
        ${st.them?.length ? `<div><span class="struct-h them">Them</span><ul>${st.them.map((t) => li(t)).join('')}</ul></div>` : ''}</div>` : ''}
    </details>` : '';

  // engine (revealing)
  let engineHtml = '';
  if (suggest) {
    const ep = info.engine_plan || {};
    const cands = candidates ? info.candidates || [] : [];
    if (ep.you || ep.them || cands.length) {
      engineHtml = `<section class="ins-sec engine">
        <div class="ins-h">🧠 Engine</div>
        ${ep.you ? `<p class="small"><b>Your plan:</b> ${mdInline(ep.you)}</p>` : ''}
        ${ep.them ? `<p class="small"><b>Their plan:</b> ${mdInline(ep.them)}</p>` : ''}
        ${cands.length ? `<div class="ins-cands">${cands.map((c) => `<button type="button" class="ins-cand" data-uci="${esc(c.uci)}" title="Play ${esc(c.san)}">
          <span class="eng-ev">${esc(evalLabel(c.eval_pov))}</span><span class="ic-main"><span><b>${esc(c.san)}</b> <span class="muted small">${esc(prettyDesc(c.desc, c.san))}</span></span>
          ${c.plan ? `<span class="small ic-plan">→ ${esc(c.plan)}</span>` : ''}<span class="line-txt">${esc(c.line || '')}</span></span></button>`).join('')}</div>` : ''}
      </section>`;
    }
  }
  const optsHtml = options ? optionsHtml(info, { allowMoves }) : '';
  const dangerLooks = looks.filter((x) => x.tone === 'danger');
  const dangerHtml = dangerLooks.length ? `<section class="ins-sec danger-strip">
      <div class="ins-h">⚠ Danger</div><ul class="looks">${dangerLooks.map((x) => lookItem(x, false)).join('')}</ul></section>` : '';
  const note = !optsHtml && optionsNote ? `<p class="opts-note muted small">${esc(optionsNote)}</p>` : '';
  const coach = info.coach_text ? `<div class="callout coach"><div class="callout-h">Coach</div>${renderMarkdown(info.coach_text)}</div>` : '';
  if (!optsHtml) {
    // no options (not our move): keep the classic layout
    return `<div class="insight v2">${headline}${note}${lookHtml}${lastHtml}${goalHtml}${theirHtml}${trumpsHtml}${engineHtml}${coach}</div>`;
  }
  return `<div class="insight v2">${headline}${optsHtml}${dangerHtml}${coach}
    <details class="more-details"><summary>More details <span class="muted small">— last move, big goal, trumps${suggest ? ', engine' : ''}</span></summary>
      ${lookHtml}${lastHtml}${goalHtml}${theirHtml}${trumpsHtml}${engineHtml}
    </details></div>`;
}

/**
 * Wire hover/click on look-now items (board overlay), "more", trump chips and candidate clicks.
 * Call after each render. Returns nothing; handlers live on `container` (set once).
 */
export function wireInsight(container, { board, getInfo, getSuggest = () => false, onCandidate = null }) {
  if (container.dataset.wired) return;
  container.dataset.wired = '1';
  let pinned = null;
  let optPinned = null;
  const optOf = (li) => getInfo()?.options?.[+li.dataset.opt];
  const optShow = (li) => {
    if (!board) return;
    const ov = optionOverlay(optOf(li), { suggest: getSuggest(), showMove: li.classList.contains('moved') });
    board.setOverlay(ov);
  };
  const optOpen = (li, on) => {
    if (on) container.querySelectorAll('.opt.open').forEach((x) => { if (x !== li && x !== optPinned) { x.classList.remove('open'); x.querySelector('.opt-head')?.setAttribute('aria-expanded', 'false'); } });
    li.classList.toggle('open', on);
    li.querySelector('.opt-head')?.setAttribute('aria-expanded', on ? 'true' : 'false');
  };
  const optRelease = () => {
    if (optPinned) { optPinned.classList.remove('pinned'); optOpen(optPinned, false); }
    optPinned = null;
    board?.clearOverlay();
  };
  container.addEventListener('mouseover', (e) => {
    const li = e.target.closest('.opt');
    if (!li || optPinned || !matchMedia('(hover: hover)').matches) return;
    optOpen(li, true);
    optShow(li);
  });
  container.addEventListener('mouseout', (e) => {
    const li = e.target.closest('.opt');
    if (!li || li.contains(e.relatedTarget) || optPinned) return;
    optOpen(li, false);
    board?.clearOverlay();
  });
  container.addEventListener('click', (e) => {
    const show = e.target.closest('.opt-show');
    if (show) {
      const li = show.closest('.opt');
      li.classList.add('moved');
      show.remove();
      li.querySelector('.opt-move')?.classList.remove('hidden');
      if (optPinned && optPinned !== li) optRelease();
      optPinned = li; li.classList.add('pinned'); optOpen(li, true);
      optShow(li);
      e.stopPropagation();
      return;
    }
    const head = e.target.closest('.opt-head');
    if (head) {
      const li = head.closest('.opt');
      if (optPinned === li) { optRelease(); return; }
      if (optPinned) optRelease();
      optPinned = li; li.classList.add('pinned'); optOpen(li, true); optShow(li);
      if (matchMedia('(pointer: coarse)').matches) requestAnimationFrame(() => li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      e.stopPropagation();
    }
  }, true);
  container.addEventListener('keydown', (e) => {
    const head = e.target.closest?.('.opt-head');
    if (head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); head.click(); }
  });
  // tap/click outside the panel (and outside the board) releases a pinned option
  const outside = (e) => {
    if (!document.contains(container)) { document.removeEventListener('pointerdown', outside, true); return; }
    if (!optPinned || container.contains(e.target) || e.target.closest?.('.cb')) return;
    optRelease();
  };
  document.addEventListener('pointerdown', outside, true);
  container.__focusOption = (n) => {
    const li = container.querySelectorAll('.opt')[n - 1];
    if (!li) return false;
    li.querySelector('.opt-head').click();
    if (optPinned === li) li.scrollIntoView({ block: 'nearest' });
    return true;
  };
  const show = (el) => {
    const info = getInfo();
    const it = info?.look_now?.[+el.dataset.look];
    if (!it || !board) return;
    const v = lookView(it, getSuggest());
    const tone = lookTone(it, info);
    board.setOverlay({ squares: v.squares, color: TONE_COLOR[tone], arrows: v.arrows.map(([from, to]) => ({ from, to, color: TONE_ARROW[tone] })) });
  };
  const clear = () => { if (!pinned && board) board.clearOverlay(); };
  container.addEventListener('mouseover', (e) => { const el = e.target.closest('[data-look]'); if (el && !pinned) show(el); });
  container.addEventListener('mouseout', (e) => { const el = e.target.closest('[data-look]'); if (el && !el.contains(e.relatedTarget)) clear(); });
  container.addEventListener('focusin', (e) => { const el = e.target.closest('[data-look]'); if (el && !pinned) show(el); });
  container.addEventListener('click', (e) => {
    const look = e.target.closest('[data-look]');
    if (look) {
      container.querySelectorAll('.look.pinned').forEach((n) => n !== look && n.classList.remove('pinned'));
      if (pinned === look) { pinned = null; look.classList.remove('pinned'); board?.clearOverlay(); }
      else { pinned = look; look.classList.add('pinned'); show(look); }
      return;
    }
    if (e.target.closest('.look-more')) {
      container.querySelector('.looks')?.classList.add('show-all');
      e.target.closest('.look-more').remove();
      return;
    }
    const chip = e.target.closest('[data-trump]');
    if (chip) {
      const info = getInfo();
      const box = container.querySelector('.trump-text');
      const t = info?.imbalances?.[+chip.dataset.trump];
      const on = !chip.classList.contains('on');
      container.querySelectorAll('[data-trump]').forEach((c) => c.classList.remove('on'));
      if (box) { box.classList.toggle('hidden', !on); box.innerHTML = on && t ? mdInline(t.text) : ''; }
      if (on) chip.classList.add('on');
      return;
    }
    const cand = e.target.closest('[data-uci]');
    if (cand && onCandidate) onCandidate(cand.dataset.uci);
  });
  // a new render invalidates the pinned element
  new MutationObserver(() => {
    if (pinned && !container.contains(pinned)) pinned = null;
    if (optPinned && !container.contains(optPinned)) optPinned = null;
  }).observe(container, { childList: true, subtree: true });
}

/** Keyboard 1–6: toggle option n in a wired container. */
export function focusOption(container, n) { return !!container?.__focusOption?.(n); }
