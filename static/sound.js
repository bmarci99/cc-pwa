// Tiny WebAudio sound kit (no audio files). Works in Chrome, Safari and WKWebView (webkitAudioContext fallback).

let ctx = null;
let muted = false;
try { muted = localStorage.getItem('cc.muted') === '1'; } catch { /* storage unavailable */ }

/** The AudioContext is only created / resumed inside a user gesture (required by iOS Safari). */
function ac() {
  if (!ctx || ctx.state === 'closed') return null;
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return ctx;
}

function unlockFromGesture() {
  try {
    if (!ctx || ctx.state === 'closed') {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      ctx = new C();
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    // iOS: playing a 1-sample silent buffer inside the gesture fully unlocks output
    const b = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.connect(ctx.destination);
    src.start(0);
  } catch { /* ignore */ }
}

// Keep listening to gestures until audio actually runs (iOS may also suspend it again, e.g. after a call).
if (typeof window !== 'undefined') {
  const onGesture = () => { if (!ctx || ctx.state !== 'running') unlockFromGesture(); };
  for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) window.addEventListener(ev, onGesture, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); });
}

function tone(c, { freq = 440, dur = 0.12, type = 'sine', gain = 0.18, delay = 0, to = null }) {
  const t0 = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function knock(c, { dur = 0.07, gain = 0.5, freq = 900, delay = 0 }) {
  const t0 = c.currentTime + delay;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = 1.2;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  src.connect(f).connect(g).connect(c.destination);
  src.start(t0);
}

const SOUNDS = {
  move(c) { knock(c, { freq: 700, gain: 0.9 }); tone(c, { freq: 190, dur: 0.06, gain: 0.08 }); },
  castle(c) { knock(c, { freq: 700, gain: 0.8 }); knock(c, { freq: 650, gain: 0.7, delay: 0.09 }); },
  capture(c) { knock(c, { freq: 1300, gain: 1.1, dur: 0.09 }); tone(c, { freq: 260, dur: 0.08, gain: 0.1, type: 'triangle' }); },
  check(c) { knock(c, { freq: 900, gain: 0.8 }); tone(c, { freq: 660, dur: 0.1, gain: 0.12, type: 'triangle', delay: 0.02 }); tone(c, { freq: 880, dur: 0.16, gain: 0.12, type: 'triangle', delay: 0.11 }); },
  end(c) { [523, 659, 784, 1046].forEach((f, i) => tone(c, { freq: f, dur: 0.35, gain: 0.1, type: 'triangle', delay: i * 0.09 })); },
  low(c) { tone(c, { freq: 988, dur: 0.09, gain: 0.12, type: 'square' }); tone(c, { freq: 988, dur: 0.09, gain: 0.12, type: 'square', delay: 0.16 }); },
  good(c) { tone(c, { freq: 784, dur: 0.12, gain: 0.1, type: 'triangle' }); tone(c, { freq: 1046, dur: 0.2, gain: 0.1, type: 'triangle', delay: 0.09 }); },
  bad(c) { tone(c, { freq: 330, dur: 0.18, gain: 0.12, type: 'sawtooth', to: 220 }); },
};

export const sound = {
  play(kind) {
    if (muted) return;
    const c = ac();
    if (!c || !SOUNDS[kind]) return;
    try { SOUNDS[kind](c); } catch { /* never break the app over sound */ }
  },
  get muted() { return muted; },
  setMuted(v) {
    muted = !!v;
    try { localStorage.setItem('cc.muted', muted ? '1' : '0'); } catch { /* ignore */ }
  },
};
