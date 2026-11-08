// Phone entry point: lock screen -> local data -> fetch shim -> the unchanged desktop frontend (static/app.js).
import { openIdb, memoryStore, wipeAll } from './idb.js';
import { LocalData } from './data.js';
import { LocalApi, installFetchShim } from './localapi.js';
import { showLockScreen, fetchEncrypted, decryptBundle } from './unlock.js';
import { syncGames } from './sync.js';
import { IS_STUB } from './impl.js';

const BASE = new URL('../', import.meta.url); // app root, works under any sub-path (GitHub Pages /<repo>/)
const ICON = new URL('icon-192.png', BASE).href;
const ENGINE_WORKER = new URL('vendor/stockfish/stockfish-19-lite-single.js', BASE).href;
const root = document.documentElement;
root.classList.add('cc-locked');

// ------------------------------------------------------------------ small UI helpers (before app.js exists)

function toast(msg, kind = 'info', ms = 4200, action = null) {
  const host = document.getElementById('toasts');
  if (!host) return null;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-btn'; b.type = 'button'; b.textContent = action.label;
    b.addEventListener('click', () => { t.remove(); action.run(); });
    t.appendChild(b);
  }
  host.appendChild(t);
  if (ms) setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

function fatal(msg) {
  const el = document.createElement('div');
  el.className = 'lock-screen';
  el.innerHTML = `<div class="lock-card"><img class="lock-icon" src="${ICON}" alt="" width="96" height="96"><h1>Chess Coach</h1>
    <p class="lock-error"></p><button class="btn primary lock-btn" type="button">Retry</button></div>`;
  el.querySelector('.lock-error').textContent = msg;
  el.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(el);
}

// ------------------------------------------------------------------ service worker (offline + update toast)

let wantReload = false;
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (wantReload) location.reload(); });
  navigator.serviceWorker.register(new URL('sw.js', BASE).href, { scope: BASE.pathname }).then((reg) => {
    const offer = () => toast('New version available', 'info', 0, {
      label: 'Reload',
      run: () => { wantReload = true; (reg.waiting || reg.installing)?.postMessage('skipWaiting'); setTimeout(() => location.reload(), 3000); },
    });
    if (reg.waiting && navigator.serviceWorker.controller) offer();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(); });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('service worker not registered', e));
}

// ------------------------------------------------------------------ unlock / load data

async function rememberState(idb, key, meta) {
  const st = { remember: true, salt: meta.salt, iterations: meta.iterations, key };
  try { await idb.put('kv', 'state', st); } catch { await idb.put('kv', 'state', { ...st, key: null }); } // CryptoKey not storable
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
}

async function loadData() {
  const idb = await openIdb();
  const state = idb ? await idb.get('kv', 'state').catch(() => null) : null;
  let data = null;
  if (state?.remember) {
    data = await new LocalData(idb).load();
    if (!data.meta) data = null;
  }
  let enc = null;
  try { enc = await fetchEncrypted(BASE); } catch (e) {
    if (!data) throw e;
  }
  if (data) {
    if (enc && enc.meta.created !== data.meta.created) { // a newer export from the Mac was deployed
      let updated = false;
      if (state.key && state.salt === enc.meta.salt && state.iterations === enc.meta.iterations) {
        try { await data.importBundle(await decryptBundle(state.key, enc.meta, enc.bin)); updated = true; } catch (e) { console.warn('silent update failed', e); }
      }
      if (!updated) {
        await new Promise((resolve) => {
          showLockScreen({ meta: enc.meta, bin: enc.bin, canRemember: true, update: true, onSkip: resolve, iconUrl: ICON })
            .then(async ({ bundle, key }) => { await data.importBundle(bundle); await rememberState(idb, key, enc.meta); updated = true; resolve(); });
        });
      }
      if (updated) setTimeout(() => toast('Updated with the latest data from your Mac.'), 800);
    }
    return data;
  }
  const { bundle, key, remember } = await showLockScreen({ meta: enc.meta, bin: enc.bin, canRemember: !!idb, iconUrl: ICON });
  if (remember) {
    try {
      data = await new LocalData(idb).importBundle(bundle);
      await rememberState(idb, key, enc.meta);
      return data;
    } catch (e) {
      console.warn('could not store data, keeping it in memory', e);
      toast('Could not save on this device — data is kept in memory only.', 'error');
    }
  }
  return new LocalData(memoryStore()).importBundle(bundle);
}

// ------------------------------------------------------------------ settings sheet

function settings({ data, api, realFetch }) {
  const actions = document.querySelector('.top-actions');
  if (!actions) return;
  const btn = document.createElement('button');
  btn.className = 'icon-btn'; btn.id = 'settings-btn'; btn.type = 'button';
  btn.setAttribute('aria-label', 'Settings'); btn.title = 'Settings';
  btn.textContent = '⚙︎';
  actions.appendChild(btn);
  let syncing = false, syncMsg = '';
  const fmtDate = (s) => { try { return new Date(s).toLocaleString(); } catch { return String(s); } };

  function open() {
    const bg = document.createElement('div');
    bg.className = 'modal-bg sheet-bg';
    bg.innerHTML = `<div class="modal sheet" role="dialog" aria-label="Settings">
      <div class="sheet-h"><div class="modal-h">Settings</div><button class="icon-btn sheet-x" type="button" aria-label="Close">✕</button></div>
      <section><h3>chess.com</h3>
        <p class="muted small">Downloads your newest rated blitz/rapid games (read-only, public API) and analyses them on this phone.</p>
        <button class="btn primary" id="st-sync" type="button">Sync new games</button>
        <p class="small" id="st-sync-msg"></p>
        <p class="small" id="st-an"></p>
      </section>
      <section><h3>Data</h3>
        <p class="small" id="st-data"></p>
      </section>
      <section><h3>Privacy</h3>
        <p class="muted small">Removes all your data from this phone. You will need the passphrase again.</p>
        <button class="btn danger-btn" id="st-forget" type="button">Lock &amp; forget data</button>
      </section>
      <p class="muted small" id="st-ver"></p>
    </div>`;
    document.body.appendChild(bg);
    const $ = (s) => bg.querySelector(s);
    const close = () => { window.removeEventListener('cc-analysis', render); bg.remove(); };
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    $('.sheet-x').addEventListener('click', close);
    function render() {
      const a = api.analysis, left = data.queue.length;
      $('#st-sync').disabled = syncing;
      $('#st-sync').textContent = syncing ? 'Syncing…' : 'Sync new games';
      $('#st-sync-msg').textContent = syncMsg;
      $('#st-an').textContent = a.running && a.current
        ? `Analysing ${left} game${left === 1 ? '' : 's'} on this phone… move ${a.ply}/${a.plies || '?'}`
        : left ? `${left} game${left === 1 ? '' : 's'} waiting for analysis.` : '';
      const n = [...data.games.values()];
      $('#st-data').innerHTML = '';
      $('#st-data').append(
        `From your Mac: ${fmtDate(data.meta?.created)} · ${n.filter((g) => g.time_class !== 'coach').length} games · ${data.practice.size} puzzles. `,
        data.persistent ? 'Stored on this device.' : 'Kept in memory only — locks again when the app closes.',
        IS_STUB ? ' Coach: basic stand-in (full on-device coach not installed yet).' : '',
      );
    }
    window.addEventListener('cc-analysis', render);
    render();
    data.getKv('last_sync').then((t) => { if (t && !syncMsg) { syncMsg = `Last sync ${fmtDate(t)}.`; render(); } }).catch(() => {});
    fetch(new URL('build.json', BASE)).then((r) => r.json()).then((b) => { $('#st-ver').textContent = `Version ${b.hash.slice(0, 8)} · built ${fmtDate(b.built)}`; }).catch(() => {});
    $('#st-sync').addEventListener('click', async () => {
      if (syncing) return;
      syncing = true; render();
      try {
        const r = await syncGames({ data, api, realFetch, onStatus: (m) => { syncMsg = m; render(); } });
        syncMsg = r.added ? `Added ${r.added} new game${r.added === 1 ? '' : 's'} — analysing in the background.` : 'No new games.';
      } catch (e) {
        syncMsg = navigator.onLine === false ? 'You are offline — try again with internet.' : `Sync failed: ${e.message || e}`;
      } finally { syncing = false; render(); }
    });
    $('#st-forget').addEventListener('click', async () => {
      if (!confirm('Remove all Chess Coach data from this device? Your progress on this phone (puzzle history, practice games) will be lost.')) return;
      await wipeAll(data.st);
      location.reload();
    });
  }
  btn.addEventListener('click', open);
  let lastDone = 0;
  window.addEventListener('cc-analysis', (e) => {
    const d = e.detail;
    if (!d.running && d.done > lastDone) { toast(`Analysis finished (${d.done - lastDone} game${d.done - lastDone === 1 ? '' : 's'}).`, 'info', 3000); lastDone = d.done; }
  });
}

// ------------------------------------------------------------------ go

async function main() {
  registerSW();
  let data;
  try { data = await loadData(); } catch (e) { fatal(e.message || String(e)); return; }
  const api = new LocalApi(data, { workerUrl: ENGINE_WORKER });
  const realFetch = installFetchShim(api, BASE.href);
  root.classList.remove('cc-locked');
  settings({ data, api, realFetch });
  await import('../static/app.js');
  if (data.queue.length) setTimeout(() => api.runQueue(), 4000); // resume interrupted analysis
}

main();
