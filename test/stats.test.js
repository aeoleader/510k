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
