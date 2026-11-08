// Lock screen + decryption of data.bin (AES-256-GCM, key = PBKDF2-SHA256(passphrase, salt, 600k)).
import { gunzip } from './inflate.js';
import { BUNDLE_KIND } from './data.js';

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const FAIL_KEY = 'cc.unlockFails';

export async function deriveKey(passphrase, meta) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(meta.salt), iterations: meta.iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

async function gunzipToText(buf) {
  if (typeof DecompressionStream === 'function') {
    try {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    } catch (e) { console.warn('DecompressionStream failed, using fallback', e); }
  }
  return new TextDecoder().decode(gunzip(new Uint8Array(buf)));
}

/** Decrypt + gunzip + validate. Throws {wrongKey:true} for a bad passphrase. */
export async function decryptBundle(key, meta, bin) {
  let gz;
  try {
    gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(meta.iv) }, key, bin);
  } catch {
    const e = new Error('Wrong passphrase'); e.wrongKey = true; throw e;
  }
  const bundle = JSON.parse(await gunzipToText(gz));
  if (bundle?.kind !== BUNDLE_KIND || bundle.v !== 1 || !Array.isArray(bundle.games) || !bundle.dashboard) throw new Error('The data file is damaged or from another app version.');
  return bundle;
}

export async function fetchEncrypted(base) {
  const [mr, br] = await Promise.all([fetch(new URL('data.meta.json', base)), fetch(new URL('data.bin', base))]);
  if (!mr.ok || !br.ok) throw new Error('Could not load the encrypted data file. Open the app once while online.');
  const meta = await mr.json();
  if (meta.v !== 1 || !meta.salt || !meta.iv || !meta.iterations) throw new Error('Unknown data file format.');
  return { meta, bin: await br.arrayBuffer() };
}

const fails = () => { try { return JSON.parse(localStorage.getItem(FAIL_KEY)) || { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; } };
const setFails = (v) => { try { localStorage.setItem(FAIL_KEY, JSON.stringify(v)); } catch { /* ignore */ } };

/**
 * Show the lock screen until the bundle decrypts. Resolves {bundle, key, remember}.
 * opts: {meta, bin, canRemember, update (true when a newer export replaces remembered data), onSkip}
 */
export function showLockScreen({ meta, bin, canRemember, update = false, onSkip = null, iconUrl }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'lock-screen';
    el.innerHTML = `
      <form class="lock-card" autocomplete="off" novalidate>
        <img class="lock-icon" src="${iconUrl}" alt="" width="96" height="96">
        <h1>Chess Coach</h1>
        <p class="muted">${update ? 'New data from your Mac is available. Enter your passphrase to update.' : 'Your data is encrypted on this device and online.'}</p>
        <label class="lock-label" for="lock-pass">Enter your passphrase</label>
        <input id="lock-pass" class="lock-input" type="password" name="cc-passphrase" autocomplete="current-password"
               autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="word-word-word-word-word" required>
        <label class="lock-remember ${canRemember ? '' : 'hidden'}"><input type="checkbox" id="lock-remember" ${canRemember ? 'checked' : ''}>
          <span>Remember on this device</span></label>
        ${canRemember ? '' : '<p class="muted small">Storage is unavailable here (private mode?) — you will need the passphrase every time.</p>'}
        <button class="btn primary lock-btn" type="submit">Unlock</button>
        ${update && onSkip ? '<button class="btn lock-skip" type="button">Not now</button>' : ''}
        <p class="lock-error" role="alert" aria-live="assertive"></p>
      </form>`;
    document.body.appendChild(el);
    const form = el.querySelector('form'), input = el.querySelector('#lock-pass'), btn = el.querySelector('.lock-btn'), err = el.querySelector('.lock-error');
    setTimeout(() => input.focus(), 50);
    let timer = null;
    const cooldown = () => {
      clearInterval(timer);
      const tick = () => {
        const left = Math.ceil((fails().until - Date.now()) / 1000);
        if (left > 0) { btn.disabled = true; btn.textContent = `Try again in ${left}s`; } else { btn.disabled = false; btn.textContent = 'Unlock'; clearInterval(timer); }
      };
      tick();
      timer = setInterval(tick, 250);
    };
    cooldown();
    el.querySelector('.lock-skip')?.addEventListener('click', () => { el.remove(); onSkip(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const raw = input.value.trim();
      if (!raw) { err.textContent = 'Type your passphrase first.'; return; }
      btn.disabled = true; btn.textContent = 'Unlocking…'; err.textContent = '';
      const candidates = [raw];
      const norm = raw.toLowerCase().replace(/[\s_]+/g, '-');
      if (norm !== raw) candidates.push(norm); // iOS auto-capitalisation / spaces instead of dashes
      try {
        for (const p of candidates) {
          const key = await deriveKey(p, meta);
          try {
            const bundle = await decryptBundle(key, meta, bin);
            setFails({ n: 0, until: 0 });
            const remember = canRemember && el.querySelector('#lock-remember').checked;
            input.value = '';
            el.remove();
            clearInterval(timer);
            resolve({ bundle, key, remember });
            return;
          } catch (x) { if (!x.wrongKey) throw x; }
        }
        const f = fails();
        f.n += 1;
        f.until = Date.now() + Math.min(60, 2 ** (f.n - 1)) * 1000; // 1 s, 2 s, 4 s, ... max 60 s
        setFails(f);
        err.textContent = 'That passphrase didn’t work. Check the words and the dashes and try again.';
        input.select();
        cooldown();
      } catch (x) {
        err.textContent = x.message || String(x);
        btn.disabled = false; btn.textContent = 'Unlock';
      }
    });
  });
}
