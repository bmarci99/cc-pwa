# Stockfish.js 19 — lite, single-threaded WASM

- Files: `stockfish-19-lite-single.js` + `stockfish-19-lite-single.wasm` (unmodified)
- Source: npm package `stockfish@19.0.1` (`bin/`), https://registry.npmjs.org/stockfish/-/stockfish-19.0.1.tgz
  — project https://github.com/nmrugg/stockfish.js (release v19.0.1), engine https://github.com/official-stockfish/Stockfish
- Why this build: no SharedArrayBuffer / cross-origin isolation needed (GitHub Pages can't send COOP/COEP),
  ~1.8 MB, runs on iOS Safari 16.4+ as a classic Web Worker. The `.js` loads the sibling `.wasm`
  (serve it as `application/wasm`).
- License: GPL-3.0 (`Copying.txt`). The app that ships it must stay GPL-compatible and offer the source.
- `package.json` here only marks the folder as CommonJS so node (tests) can `require()` the same build; browsers ignore it.
- sha256
  - stockfish-19-lite-single.js   `ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a`
  - stockfish-19-lite-single.wasm `ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de`
