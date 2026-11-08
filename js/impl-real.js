// The real on-device port (mobile/src): Stockfish WASM wrapper + JavaScript coach.
export { createEngine } from '../src/engine.js';
export * from '../src/coach/index.js';
export const IS_STUB = false;
