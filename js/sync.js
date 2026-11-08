// "Sync new games" on the phone: GET-only reads of the chess.com public API (CORS: *), new rated blitz/rapid
// games go into the local games store (same fields as db.game_row) and the background analysis queue.

const API = 'https://api.chess.com/pub/player';
const DRAW_CODES = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);
const FAMILY_END = new Set(['Defense', 'Opening', 'Game', 'Gambit', 'Attack', 'System', 'Countergambit']);

export function parseOpening(ecoUrl) {
  if (!ecoUrl) return [null, null];
  const slug = ecoUrl.replace(/\/+$/, '').split('/').pop();
  const words = slug.split('-');
  let cut = words.findIndex((w) => /^\d+\./.test(w));
  if (cut < 0) cut = words.length;
  const nameWords = words.slice(0, cut).length ? words.slice(0, cut) : words;
  const fam = [];
  for (const w of nameWords) { fam.push(w); if (FAMILY_END.has(w)) break; }
  return [nameWords.join(' '), fam.join(' ')];
}

function pgnHeaders(pgn) {
  const h = {};
  for (const m of pgn.matchAll(/^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm)) h[m[1]] = m[2];
  return h;
}

/** Port of db.game_row. */
export function gameRow(g, username) {
  if (g.rules !== 'chess' || !g.pgn) return null;
  const meWhite = g.white.username.toLowerCase() === username.toLowerCase();
  const [me, opp] = meWhite ? [g.white, g.black] : [g.black, g.white];
  const result = me.result === 'win' ? 'win' : DRAW_CODES.has(me.result) ? 'draw' : 'loss';
  const headers = pgnHeaders(g.pgn);
  const [opening, family] = parseOpening(g.eco || headers.ECOUrl);
  let base = null, inc = 0;
  const tc = g.time_control || '';
  if (tc && !tc.includes('/')) { const [b, i] = tc.split('+'); base = parseInt(b, 10); inc = parseInt(i || '0', 10); }
  const dt = new Date(g.end_time * 1000);
  const acc = g.accuracies || {};
  const idx = g.pgn.indexOf('\n\n');
  const movetext = idx >= 0 ? g.pgn.slice(idx + 2) : g.pgn;
  const nPlies = (movetext.match(/\b\d+\.(?:\.\.)?\s*\S+/g) || []).length;
  return {
    id: g.url.replace(/\/+$/, '').split('/').pop(), url: g.url, end_time: g.end_time, date: dt.toISOString().slice(0, 10),
    hour: dt.getUTCHours(), weekday: (dt.getUTCDay() + 6) % 7, time_class: g.time_class, time_control: g.time_control,
    base_seconds: base, increment: inc, rated: g.rated ? 1 : 0, color: meWhite ? 'white' : 'black',
    my_rating: me.rating ?? null, opp_rating: opp.rating ?? null, opp_name: opp.username ?? null, result,
    my_code: me.result, opp_code: opp.result, termination: headers.Termination ?? null, eco: headers.ECO ?? null,
    opening, opening_family: family, n_plies: nPlies, my_accuracy: acc[meWhite ? 'white' : 'black'] ?? null,
    opp_accuracy: acc[meWhite ? 'black' : 'white'] ?? null, pgn: g.pgn, analyzed: 0, blunders: 0, highlights: 0,
  };
}

async function getJson(realFetch, url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await realFetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt)); continue; }
    if (!r.ok) throw new Error(`chess.com answered ${r.status}`);
    return r.json();
  }
  throw new Error('chess.com rate limit — try again in a minute');
}

/** Fetch the latest `months` archives; returns {added, checked}. */
export async function syncGames({ data, api, realFetch, months = 2, onStatus = () => {} }) {
  const user = data.meta?.username;
  if (!user) throw new Error('No chess.com username in the data bundle');
  onStatus('Checking chess.com…');
  const { archives = [] } = await getJson(realFetch, `${API}/${encodeURIComponent(user)}/games/archives`);
  let checked = 0;
  const fresh = [];
  for (const url of archives.slice(-months)) {
    if (!url.startsWith(API + '/')) continue; // only ever talk to api.chess.com
    onStatus(`Downloading ${url.split('/').slice(-2).join('-')}…`);
    const { games = [] } = await getJson(realFetch, url);
    for (const g of games) {
      checked++;
      const row = gameRow(g, user);
      if (!row || !row.rated || !['blitz', 'rapid'].includes(row.time_class) || data.knows(row.id)) continue;
      fresh.push(row);
    }
    await new Promise((r) => setTimeout(r, 300)); // serial + polite
  }
  fresh.sort((a, b) => b.end_time - a.end_time); // analyse newest first, like the Mac
  for (const row of fresh) { await data.putGame(row); await data.enqueue(row.id); }
  await data.setKv('last_sync', Date.now());
  if (fresh.length) api.runQueue();
  return { added: fresh.length, checked };
}
