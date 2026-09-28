import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import { Accounts } from '../server/accounts.js';
import { hints } from '../engine/hint.js';
import { identify } from '../engine/combos.js';
import { createHandState, replay, ranking } from '../engine/game.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST = { turnMs: 2000, returnMs: 2000, botMs: 1, nextHandMs: 1 };
let server;
let base;
let accounts;
const streams = [];

before(async () => {
  accounts = new Accounts(openDatabase(':memory:'));
  await accounts.register('Boss', 'secret1'); // admins must exist before the server starts
  ({ server } = createApp({
    publicDir: path.join(root, 'public'), engineDir: path.join(root, 'engine'), delays: FAST, accounts,
    admins: ['Boss', 'Ghost'], rateLimits: { register: { limit: 100, windowMs: 60_000 } },
  }));
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
  assert.equal((await post('/api/rooms/set-turn-time', { code, token, seconds: 7 }, 400)).error, 'bad_turn_time');
  assert.equal((await post('/api/rooms/set-turn-time', { code, token, seconds: 45 })).ok, true);
  assert.equal((await post('/api/rooms/swap-seats', { code, token, a: 'x', b: 'y' }, 404)).error, 'no_player');
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

// Drive one seat through a whole match using the engine's hints; returns the final view.
async function playMatch(code, token, me) {
  // Act only on views at least as new as our last accepted action, so a view
  // that predates our own move never triggers a second move.
  let minVersion = (await post('/api/rooms/start', { code, token })).version;
  let acted = 0;
  let lastSeen = 0;
  for (;;) {
    await until(() => me.count > lastSeen && me.view.version >= minVersion);
    lastSeen = me.count;
    const v = me.view;
    if (v.phase === 'match_over') return { view: v, acted };
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
}

test('a human plays a full match over HTTP + SSE against three bots', async () => {
  const { code, token } = await post('/api/rooms/create', { name: '甲' });
  const me = await listen(code, token);
  for (let i = 0; i < 3; i++) await post('/api/rooms/add-bot', { code, token });
  const { view, acted } = await playMatch(code, token, me);
  assert.ok(acted > 10, 'the human acted through the match');
  assert.equal(view.handNo, 10);
  assert.equal(view.totals.length, 2);
  assert.equal(view.ratings[0].delta, null, 'guests are not rated');
  await post('/api/rooms/leave', { code, token });
});

test('accounts: register, login, bad credentials, me and logout', async () => {
  const reg = await post('/api/auth/register', { username: 'Jay', password: 'secret1' });
  assert.equal(reg.account.rating, 60);
  assert.equal(reg.account.tierName, '白银');
  assert.equal((await post('/api/auth/register', { username: 'jay', password: 'secret1' }, 409)).error, 'username_taken');
  assert.equal((await post('/api/auth/login', { username: 'Jay', password: 'nope' }, 401)).error, 'bad_login');
  const login = await post('/api/auth/login', { username: 'jay', password: 'secret1' });
  assert.equal((await post('/api/auth/me', { accountToken: login.accountToken })).account.username, 'Jay');
  await post('/api/auth/logout', { accountToken: login.accountToken });
  assert.equal((await post('/api/auth/me', { accountToken: login.accountToken }, 401)).error, 'session_expired');
  assert.equal((await post('/api/rooms/create', { accountToken: login.accountToken }, 401)).error, 'session_expired');
});

test('accounts: a logged-in player sits under their username and gets the same seat back', async () => {
  const { accountToken } = await post('/api/auth/register', { username: 'Seat', password: 'secret1' });
  const created = await post('/api/rooms/create', { accountToken, name: 'ignored' });
  const again = await post('/api/rooms/join', { code: created.code, accountToken });
  assert.equal(again.playerId, created.playerId, 'no second seat for the same account');
  const me = await listen(created.code, created.token);
  await until(() => me.view);
  assert.equal(me.view.players[0].name, 'Seat');
  assert.equal(me.view.you.account.username, 'Seat');
  await post('/api/rooms/leave', { code: created.code, token: created.token });
});

test('accounts: a full rated match updates the rating and records the match', async () => {
  const { accountToken } = await post('/api/auth/register', { username: 'Rated', password: 'secret1' });
  const { code, token } = await post('/api/rooms/create', { accountToken });
  const me = await listen(code, token);
  for (let i = 0; i < 3; i++) await post('/api/rooms/add-bot', { code, token });
  const { view } = await playMatch(code, token, me);
  const mine = view.ratings[view.you.seat];
  assert.equal(mine.before, 60);
  assert.ok(Number.isInteger(mine.delta));
  assert.equal(mine.after, 60 + mine.delta);
  assert.deepEqual(view.ratings.filter((r) => r.seat !== view.you.seat).map((r) => r.delta), [null, null, null]);
  const { account } = await post('/api/auth/me', { accountToken });
  assert.equal(account.rating, mine.after);
  const rows = accounts.db.prepare('SELECT user_id, rating_delta FROM match_players WHERE user_id IS NOT NULL').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rating_delta, mine.delta);
  assert.ok(Number.isInteger(view.matchId), 'the finished view links to the stored match');

  // The stored hands replay through the engine to exactly the recorded results.
  assert.equal((await post('/api/matches/replay', { matchId: view.matchId }, 401)).error, 'login_required');
  const replayData = await post('/api/matches/replay', { accountToken, matchId: view.matchId });
  assert.equal(replayData.hands.length, 10);
  assert.deepEqual(replayData.totals, view.totals);
  for (const h of replayData.hands) {
    const initial = createHandState({ hands: h.initialHands, teams: replayData.teams, leader: h.leader, decks: replayData.decks });
    const { state } = replay(initial, h.actions.map(({ seat, type, cards }) => ({ seat, type, cards })));
    assert.deepEqual(state.captured, h.result.captured, `hand ${h.handNo} captured`);
    assert.deepEqual(ranking(state), h.result.ranking, `hand ${h.handNo} ranking`);
  }

  const profile = await post('/api/users/profile', { accountToken, username: 'me' });
  assert.equal(profile.account.username, 'Rated');
  assert.equal(profile.totals.matches, 1);
  assert.equal(profile.totals.hands, 10);
  assert.equal(profile.recent[0].matchId, view.matchId);
  assert.equal(profile.recent[0].hands.length, 10);
  assert.equal(profile.history.at(-1).after, mine.after);
  assert.equal((await post('/api/users/profile', { accountToken, username: 'nobody' }, 404)).error, 'no_user');
  assert.equal((await fetch(`${base}/replay/${view.matchId}`)).status, 200);
  assert.equal((await fetch(`${base}/u/Rated`)).status, 200);
  await post('/api/rooms/leave', { code, token });
});

test('admin: only admins manage card counters, and counter data reaches only that player', async () => {
  const boss = await post('/api/auth/login', { username: 'Boss', password: 'secret1' });
  const ghost = await post('/api/auth/register', { username: 'Ghost', password: 'secret1' });
  assert.equal((await post('/api/auth/me', { accountToken: ghost.accountToken })).isAdmin, false, 'registering a listed name later grants nothing');
  const counted = await post('/api/auth/register', { username: 'Counted', password: 'secret1' });
  assert.equal((await post('/api/auth/me', { accountToken: boss.accountToken })).isAdmin, true);
  assert.equal((await post('/api/admin/users', { accountToken: counted.accountToken, query: '' }, 403)).error, 'admin_only');
  assert.equal((await post('/api/admin/users', { query: '' }, 401)).error, 'login_required');
  const found = await post('/api/admin/users', { accountToken: boss.accountToken, query: 'count' });
  assert.deepEqual(found.users.map((u) => [u.username, u.cardCounter]), [['Counted', false]]);
  const notReally = await post('/api/admin/card-counter', { accountToken: boss.accountToken, username: 'Counted', enabled: 'false' });
  assert.equal(notReally.cardCounter, false, 'only a real true enables it');
  const set = await post('/api/admin/card-counter', { accountToken: boss.accountToken, username: 'Counted', enabled: true });
  assert.equal(set.cardCounter, true);
  const audit = (await post('/api/admin/users', { accountToken: boss.accountToken, query: '' })).audit;
  assert.deepEqual([audit[0].admin, audit[0].target, audit[0].action], ['Boss', 'Counted', 'card_counter_on']);
  assert.equal((await post('/api/auth/register', { username: 'Me', password: 'secret1' }, 400)).error, 'bad_username');

  const host = await post('/api/rooms/create', { accountToken: counted.accountToken });
  const guest = await post('/api/rooms/join', { code: host.code, name: '路人' });
  const hostView = await listen(host.code, host.token);
  const guestView = await listen(guest.code, guest.token);
  for (let i = 0; i < 2; i++) await post('/api/rooms/add-bot', { code: host.code, token: host.token });
  await post('/api/rooms/start', { code: host.code, token: host.token });
  await until(() => hostView.view?.phase === 'playing' && guestView.view?.phase === 'playing');
  const counter = hostView.view.you.counter;
  assert.ok(counter, 'the enabled player sees the counter');
  const unseen = Object.values(counter.remaining).reduce((a, b) => a + b, 0);
  const othersHold = hostView.view.players.filter((p) => p.seat !== hostView.view.you.seat).reduce((n, p) => n + p.cards, 0);
  assert.equal(unseen, othersHold, 'unseen cards are exactly the cards still in other hands');
  assert.equal(guestView.view.you.counter, null);
  assert.ok(!JSON.stringify(guestView.view).includes('"remaining"'), 'no counter data in anyone else\'s view');

  await post('/api/admin/card-counter', { accountToken: boss.accountToken, username: 'Counted', enabled: false });
  await until(() => hostView.view.you.counter === null);
  await post('/api/rooms/leave', { code: guest.code, token: guest.token });
  await post('/api/rooms/leave', { code: host.code, token: host.token });
});
