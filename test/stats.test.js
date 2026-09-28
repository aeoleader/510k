import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { Accounts } from '../server/accounts.js';
import { Stats } from '../server/stats.js';

async function setup() {
  const accounts = new Accounts(openDatabase(':memory:'));
  const me = (await accounts.register('Me1', 'secret1')).user;
  const mate = (await accounts.register('Mate', 'secret1')).user;
  return { accounts, stats: new Stats(accounts.db), me, mate };
}

// A 4-player team match; `hands` optional (matches stored before replays existed have none).
function record(accounts, me, mate, { totals, hands = [], leftEarly = false, delta = 10 }) {
  return accounts.recordMatch({
    roomCode: 'TEST', playerCount: 4, decks: 2, mode: 'team', startedAt: 1, endedAt: 2, totals,
    players: [
      { seat: 0, userId: me.id, name: 'Me1', isBot: false, team: 0, total: totals[0], heads: 1, tails: 0, ratingBefore: 60, delta, leftEarly },
      { seat: 1, userId: null, name: 'Bot', isBot: true, team: 1, total: totals[1], heads: 0, tails: 1, ratingBefore: null, delta: null, leftEarly: false },
      { seat: 2, userId: mate.id, name: 'Mate', isBot: false, team: 0, total: totals[0], heads: 0, tails: 0, ratingBefore: 60, delta, leftEarly: false },
      { seat: 3, userId: null, name: 'Bot2', isBot: true, team: 1, total: totals[1], heads: 0, tails: 0, ratingBefore: null, delta: null, leftEarly: false },
    ],
    hands,
  });
}

const hand = (handNo, { ranking = [0, 2, 1, 3], sweep = false, winner = 0 } = {}) => ({
  handNo, seed: 1, leader: 0, tribute: { pairs: [], resisted: false, given: [], returns: [] },
  initialHands: [[], [], [], []], actions: [], highlights: [],
  result: { ranking, finished: [0, 2], captured: [60, 20, 40, 80], score: [120, 80], penalties: [], winner, sweep },
});

test('matches recorded before replays existed: no replay link, rates only from recorded hands', async () => {
  const { accounts, stats, me, mate } = await setup();
  record(accounts, me, mate, { totals: [300, 100] }); // old: no hands
  record(accounts, me, mate, { totals: [200, 100], hands: [hand(0), hand(1, { ranking: [1, 3, 2, 0] })] });
  const p = stats.profile('Me1');
  assert.equal(p.totals.matches, 2);
  assert.equal(p.totals.hands, 2);
  assert.equal(p.totals.headRate, 0.5);
  assert.equal(p.totals.tailRate, 0.5);
  assert.equal(p.totals.avgCaptured, 60);
  assert.deepEqual(p.recent.map((r) => r.hasReplay), [true, false]);
  assert.equal(stats.replay(p.recent[1].matchId).hands.length, 0);
});

test('outcomes follow the rating rules: leaving early loses, team ties go to more sweeps', async () => {
  const { accounts, stats, me, mate } = await setup();
  record(accounts, me, mate, { totals: [300, 100], leftEarly: true, delta: -30 });
  record(accounts, me, mate, { totals: [200, 200], hands: [hand(0, { sweep: true, winner: 0 })] });
  record(accounts, me, mate, { totals: [200, 200] });
  const p = stats.profile('Me1');
  assert.deepEqual(p.recent.map((r) => r.outcome), ['draw', 'win', 'loss']);
  assert.equal(p.totals.sweeps, 1);
  assert.equal(p.recent[1].highlights.sweep, 1);
  assert.equal(p.teammates[0].name, 'Mate');
  assert.equal(p.teammates[0].with, 3);
});

test("a sweep by the other team is not shown as the player's sweep", async () => {
  const { accounts, stats, me, mate } = await setup();
  record(accounts, me, mate, { totals: [100, 300], hands: [hand(0, { sweep: true, winner: 1, ranking: [1, 3, 0, 2] })] });
  const p = stats.profile('Me1');
  assert.equal(p.recent[0].highlights.sweep, undefined);
  assert.equal(p.totals.sweeps, 0);
});

test('replays carry who showed the black 3; older hands without it load as null', async () => {
  const { accounts, stats, me, mate } = await setup();
  const dealt = hand(1);
  dealt.tribute = { ...dealt.tribute, claimedBy: 2 };
  const id = record(accounts, me, mate, { totals: [200, 100], hands: [hand(0), dealt] });
  const replay = stats.replay(id);
  assert.deepEqual(replay.hands.map((h) => h.tribute.claimedBy), [null, 2]);
});

test('matches(): unknown user throws no_user', async () => {
  const { stats } = await setup();
  assert.throws(() => stats.matches('Nobody'), (err) => err.status === 404 && err.code === 'no_user');
});

test('matches(): pagination is 20 per page, newest first, with a cursor for the next page', async () => {
  const { accounts, stats, me, mate } = await setup();
  for (let i = 0; i < 21; i++) record(accounts, me, mate, { totals: [i + 1, 0] });
  const page1 = stats.matches('Me1');
  assert.equal(page1.total, 21);
  assert.equal(page1.matches.length, 20);
  assert.ok(page1.nextBefore, 'a next-page cursor is returned when more matches remain');
  // Newest first: the 21st recorded match (highest total) comes first.
  assert.equal(page1.matches[0].totals[0], 21);
  assert.equal(page1.matches[19].totals[0], 2);
  const page2 = stats.matches('Me1', { before: page1.nextBefore });
  assert.equal(page2.matches.length, 1);
  assert.equal(page2.matches[0].totals[0], 1);
  assert.equal(page2.nextBefore, null);
});

test('matches(): an exact multiple of the page size has no next page', async () => {
  const { accounts, stats, me, mate } = await setup();
  for (let i = 0; i < 20; i++) record(accounts, me, mate, { totals: [1, 0] });
  const page1 = stats.matches('Me1');
  assert.equal(page1.matches.length, 20);
  assert.equal(page1.nextBefore, null);
});

test('matches(): outcome filter only returns matching matches, scanning past non-matches', async () => {
  const { accounts, stats, me, mate } = await setup();
  record(accounts, me, mate, { totals: [300, 100] }); // win
  record(accounts, me, mate, { totals: [100, 300], leftEarly: true }); // loss
  record(accounts, me, mate, { totals: [100, 100] }); // draw
  record(accounts, me, mate, { totals: [300, 100] }); // win
  const wins = stats.matches('Me1', { outcome: 'win' });
  assert.equal(wins.matches.length, 2);
  assert.ok(wins.matches.every((m) => m.outcome === 'win'));
  assert.equal(wins.total, 4, 'total counts all matches, unaffected by the filter');
  const losses = stats.matches('Me1', { outcome: 'loss' });
  assert.equal(losses.matches.length, 1);
  assert.equal(losses.matches[0].outcome, 'loss');
});

test('matches(): rows match the shape of profile().recent (shared row builder)', async () => {
  const { accounts, stats, me, mate } = await setup();
  record(accounts, me, mate, { totals: [200, 100], hands: [hand(0, { sweep: true, winner: 0 })] });
  const p = stats.profile('Me1');
  const m = stats.matches('Me1');
  assert.deepEqual(m.matches[0], p.recent[0]);
});
