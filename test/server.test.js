import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { hints } from '../engine/hint.js';
import { identify } from '../engine/combos.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST = { turnMs: 2000, returnMs: 2000, botMs: 1, nextHandMs: 1 };
let server;
let base;
const streams = [];

before(async () => {
  ({ server } = createApp({ publicDir: path.join(root, 'public'), engineDir: path.join(root, 'engine'), delays: FAST }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const s of streams) s.abort();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function post(pathname, body, expected = 200) {
  const res = await fetch(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await res.json();
  assert.equal(res.status, expected, JSON.stringify(payload));
  return payload;
}

// Open an SSE stream and keep the latest view in `holder.view`.
async function listen(code, token) {
  const controller = new AbortController();
  streams.push(controller);
  const res = await fetch(`${base}/api/events?room=${code}&token=${token}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  const holder = { view: null, count: 0 };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (chunk.startsWith('data: ')) {
            holder.view = JSON.parse(chunk.slice(6));
            holder.count += 1;
          }
        }
      }
    } catch { /* aborted */ }
  })();
  return holder;
}

const until = (predicate, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    if (predicate()) return resolve();
    if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
    setTimeout(tick, 5);
  };
  tick();
});

test('static files and engine modules are served; path traversal is refused', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  const engine = await fetch(`${base}/engine/combos.js`);
  assert.equal(engine.status, 200);
  assert.match(engine.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/engine/..%2fpackage.json`)).status, 403);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 403);
  assert.equal((await fetch(`${base}/engine/%2e%2e/package.json`)).status, 404, 'dot segments are normalized away, never escaping the root');
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('input validation', async () => {
  assert.equal((await post('/api/rooms/create', { name: '' }, 400)).error, 'bad_name');
  const { code, token } = await post('/api/rooms/create', { name: '甲' });
  assert.equal((await post('/api/rooms/join', { code: 'ZZZZ', name: '乙' }, 404)).error, 'no_room');
  assert.equal((await post('/api/rooms/start', { code, token: 'x' }, 401)).error, 'bad_token');
  assert.equal((await post('/api/rooms/play', { code, token, cards: ['XX0'] }, 400)).error, 'bad_cards');
  assert.equal((await post('/api/rooms/play', { code, token, cards: ['3S0', '3S0'] }, 400)).error, 'bad_cards');
  assert.equal((await post('/api/rooms/start', { code, token }, 409)).error, 'not_enough_players');
  assert.equal((await post('/api/rooms/leave', { code, token })).ok, true);
});

test('reconnecting with the token returns the same seat', async () => {
  const { code, token, playerId } = await post('/api/rooms/create', { name: '甲' });
  const again = await post('/api/rooms/join', { code, token });
  assert.equal(again.playerId, playerId);
  const stale = await post('/api/rooms/join', { code, token: 'a'.repeat(48) }, 400);
  assert.equal(stale.error, 'bad_name', 'an unknown token without a name does not create a nameless player');
  await post('/api/rooms/leave', { code, token });
});

test('a human plays a full match over HTTP + SSE against three bots', async () => {
  const { code, token } = await post('/api/rooms/create', { name: '甲' });
  const me = await listen(code, token);
  for (let i = 0; i < 3; i++) await post('/api/rooms/add-bot', { code, token });
  // Act only on views at least as new as our last accepted action, so a view
  // that predates our own move never triggers a second move.
  let minVersion = (await post('/api/rooms/start', { code, token })).version;
  let acted = 0;
  let lastSeen = 0;
  for (;;) {
    await until(() => me.count > lastSeen && me.view.version >= minVersion);
    lastSeen = me.count;
    const v = me.view;
    if (v.phase === 'match_over') break;
    if (v.phase === 'returning' && v.you.mustReturnTo !== null) {
      minVersion = (await post('/api/rooms/return', { code, token, card: v.you.hand[0] })).version;
    } else if (v.phase === 'playing' && v.turn === v.you.seat) {
      const top = v.trick ? identify(v.trick.cards, v.decks) : null;
      const options = hints(v.you.hand, top, v.decks);
      const res = options.length
        ? await post('/api/rooms/play', { code, token, cards: options[0].cards })
        : await post('/api/rooms/pass', { code, token });
      minVersion = res.version;
      acted += 1;
    }
  }
  assert.ok(acted > 10, 'the human acted through the match');
  assert.equal(me.view.handNo, 10);
  assert.equal(me.view.totals.length, 2);
  await post('/api/rooms/leave', { code, token });
});
