import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { Accounts, publicAccount } from '../server/accounts.js';
import { HttpError } from '../server/http.js';

const fresh = () => new Accounts(openDatabase(':memory:'));
const code = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof HttpError); return e.code; }
  return null;
};

test('register stores a salted hash, never the password', () => {
  const accounts = fresh();
  const { token, user } = accounts.register('阿杰', 'secret1');
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.equal(user.rating, 60);
  const row = accounts.db.prepare('SELECT * FROM users').get();
  assert.notEqual(row.password_hash, 'secret1');
  assert.equal(row.password_hash.length, 64);
  assert.equal(row.salt.length, 32);
});

test('usernames are unique ignoring case; bad input is rejected', () => {
  const accounts = fresh();
  accounts.register('Jay', 'pw');
  assert.equal(code(() => accounts.register('jay', 'pw')), 'username_taken');
  assert.equal(code(() => accounts.register('', 'pw')), 'bad_username');
  assert.equal(code(() => accounts.register('a b', 'pw')), 'bad_username');
  assert.equal(code(() => accounts.register('一二三四五六七八九十一二三', 'pw')), 'bad_username');
  assert.equal(code(() => accounts.register('ok', '')), 'bad_password');
});

test('login checks the password and opens a new session; logout closes it', () => {
  const accounts = fresh();
  accounts.register('Jay', 'pw');
  assert.equal(code(() => accounts.login('Jay', 'nope')), 'bad_login');
  assert.equal(code(() => accounts.login('Nobody', 'pw')), 'bad_login');
  const { token } = accounts.login('JAY', 'pw');
  assert.equal(accounts.userForToken(token).username, 'Jay');
  accounts.logout(token);
  assert.equal(code(() => accounts.userForToken(token)), 'session_expired');
  assert.equal(accounts.userForToken(undefined), null);
});

test('publicAccount exposes rank info only', () => {
  const view = publicAccount({ id: 1, username: 'Jay', rating: 95, password_hash: 'x', salt: 'y' });
  assert.deepEqual(view, { username: 'Jay', rating: 95, tier: 3, tierName: '黄金', stars: 0, maxStars: 3 });
  assert.equal(publicAccount({ username: 'K', rating: 250 }).maxStars, null);
});

test('recordMatch writes match rows and new ratings atomically', () => {
  const accounts = fresh();
  const a = accounts.register('A', 'pw').user;
  const b = accounts.register('B', 'pw').user;
  const matchId = accounts.recordMatch({
    roomCode: 'ABCD', playerCount: 4, decks: 2, mode: 'team', startedAt: 1, endedAt: 2, totals: [300, 100],
    players: [
      { seat: 0, userId: a.id, name: 'A', isBot: false, team: 0, total: 300, heads: 5, tails: 0, ratingBefore: 60, delta: 27, leftEarly: false },
      { seat: 1, userId: null, name: 'Bot', isBot: true, team: 1, total: 100, heads: 0, tails: 5, ratingBefore: null, delta: null, leftEarly: false },
      { seat: 2, userId: null, name: 'Guest', isBot: false, team: 0, total: 300, heads: 5, tails: 0, ratingBefore: null, delta: null, leftEarly: false },
      { seat: 3, userId: b.id, name: 'B', isBot: false, team: 1, total: 100, heads: 0, tails: 5, ratingBefore: 60, delta: -27, leftEarly: false },
    ],
  });
  assert.equal(accounts.getUser(a.id).rating, 87);
  assert.equal(accounts.getUser(b.id).rating, 33);
  assert.equal(accounts.db.prepare('SELECT COUNT(*) n FROM match_players WHERE match_id = ?').get(matchId).n, 4);
});

test('importCardGame hashes passwords, starts at 60 and skips duplicates or invalid rows', () => {
  const accounts = fresh();
  accounts.register('Taken', 'pw');
  const summary = accounts.importCardGame({
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
  const { user } = accounts.login('alice', 'a1');
  assert.equal(user.rating, 60);
});
