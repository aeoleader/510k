import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { Accounts, publicAccount, SESSION_TTL_MS } from '../server/accounts.js';
import { HttpError } from '../server/http.js';

const fresh = (options) => new Accounts(openDatabase(':memory:'), options);
const code = async (fn) => {
  try { await fn(); } catch (e) { assert.ok(e instanceof HttpError, String(e)); return e.code; }
  return null;
};
const PW = 'secret1';

test('register stores a salted hash, never the password', async () => {
  const accounts = fresh();
  const { token, user } = await accounts.register('阿杰', PW);
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.equal(user.rating, 60);
  const row = accounts.db.prepare('SELECT * FROM users').get();
  assert.notEqual(row.password_hash, PW);
  assert.equal(row.password_hash.length, 64);
  assert.equal(row.salt.length, 32);
});

test('usernames are unique ignoring case; bad input is rejected', async () => {
  const accounts = fresh();
  await accounts.register('Jay', PW);
  assert.equal(await code(() => accounts.register('jay', PW)), 'username_taken');
  assert.equal(await code(() => accounts.register('', PW)), 'bad_username');
  assert.equal(await code(() => accounts.register('a b', PW)), 'bad_username');
  assert.equal(await code(() => accounts.register('一二三四五六七八九十一二三', PW)), 'bad_username');
  assert.equal(await code(() => accounts.register('ok', '')), 'bad_password');
  assert.equal(await code(() => accounts.register('ok', '12345')), 'short_password');
});

test('usernames drop invisible characters, so look-alikes collide', async () => {
  const accounts = fresh();
  await accounts.register('Jay', PW);
  assert.equal(await code(() => accounts.register('J​ay', PW)), 'username_taken');
  assert.equal(await code(() => accounts.register('‮', PW)), 'bad_username');
});

test('login checks the password and opens a new session; logout closes it', async () => {
  const accounts = fresh();
  await accounts.register('Jay', PW);
  assert.equal(await code(() => accounts.login('Jay', 'nope')), 'bad_login');
  assert.equal(await code(() => accounts.login('Nobody', PW)), 'bad_login');
  const { token } = await accounts.login('JAY', PW);
  assert.equal(accounts.userForToken(token).username, 'Jay');
  accounts.logout(token);
  assert.equal(await code(() => accounts.userForToken(token)), 'session_expired');
  assert.equal(accounts.userForToken(undefined), null);
});

test('sessions expire after the TTL', async () => {
  let now = 1_000_000;
  const accounts = fresh({ now: () => now });
  const { token } = await accounts.register('Jay', PW);
  now += SESSION_TTL_MS - 1;
  assert.equal(accounts.userForToken(token).username, 'Jay');
  now += 2;
  assert.equal(await code(() => accounts.userForToken(token)), 'session_expired');
});

test('publicAccount exposes rank info only', () => {
  const view = publicAccount({ id: 1, username: 'Jay', rating: 95, password_hash: 'x', salt: 'y' });
  assert.deepEqual(view, { username: 'Jay', rating: 95, tier: 3, tierName: '黄金', stars: 0, maxStars: 3 });
  assert.equal(publicAccount({ username: 'K', rating: 250 }).maxStars, null);
});

test('recordMatch writes match rows and adds each delta to the stored rating', async () => {
  const accounts = fresh();
  const a = (await accounts.register('A1', PW)).user;
  const b = (await accounts.register('B1', PW)).user;
  const match = (deltaA, deltaB) => accounts.recordMatch({
    roomCode: 'ABCD', playerCount: 4, decks: 2, mode: 'team', startedAt: 1, endedAt: 2, totals: [300, 100],
    players: [
      { seat: 0, userId: a.id, name: 'A1', isBot: false, team: 0, total: 300, heads: 5, tails: 0, ratingBefore: 60, delta: deltaA, leftEarly: false },
      { seat: 1, userId: null, name: 'Bot', isBot: true, team: 1, total: 100, heads: 0, tails: 5, ratingBefore: null, delta: null, leftEarly: false },
      { seat: 2, userId: null, name: 'Guest', isBot: false, team: 0, total: 300, heads: 5, tails: 0, ratingBefore: null, delta: null, leftEarly: false },
      { seat: 3, userId: b.id, name: 'B1', isBot: false, team: 1, total: 100, heads: 0, tails: 5, ratingBefore: 60, delta: deltaB, leftEarly: false },
    ],
  });
  const matchId = match(27, -27);
  assert.equal(accounts.getUser(a.id).rating, 87);
  assert.equal(accounts.getUser(b.id).rating, 33);
  assert.equal(accounts.db.prepare('SELECT COUNT(*) n FROM match_players WHERE match_id = ?').get(matchId).n, 4);
  // A second match that also started from 60 (overlapping rooms) must not overwrite the first result.
  match(5, -5);
  assert.equal(accounts.getUser(a.id).rating, 92);
  assert.equal(accounts.getUser(b.id).rating, 28);
});

test('importCardGame hashes passwords, keeps short old passwords, starts at 60 and skips duplicates or invalid rows', async () => {
  const accounts = fresh();
  await accounts.register('Taken', PW);
  const summary = await accounts.importCardGame({
    users: {
      alice: { username: 'Alice', password: 'a1', score: 150 },
      taken: { username: 'taken', password: 'x' },
      broken: { username: '', password: 'x' },
    },
    sessions: { tok: 'alice' },
  });
  assert.equal(summary.imported, 1);
  assert.deepEqual(summary.skipped.map((s) => s.reason).sort(), ['exists', 'invalid']);
  assert.equal(accounts.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1, 'card-game sessions are not imported');
  const { user } = await accounts.login('alice', 'a1');
  assert.equal(user.rating, 60);
});
