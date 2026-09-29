import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';
import { deal, seededRandom, compareCards } from '../engine/cards.js';
import { recordHand, handSeed, prepareHand, createMatch } from '../engine/match.js';
import { openDatabase } from '../server/db.js';
import { Accounts } from '../server/accounts.js';
import { Stats } from '../server/stats.js';

// Real games shuffle every hand with the room's deal source (crypto), never from the match seed.

const DELAYS = {
  turnMs: 10000, returnMs: 30000, botMs: 700, nextHandMs: 30000,
  tributeMs: 5000, returnRevealMs: 3000, dealRoundMs: 100, claimGraceMs: 3000, restoreGraceMs: 20000,
};

function fakeClock(start = 1000) {
  let t = start;
  let id = 0;
  const pending = new Map();
  const timers = {
    setTimeout: (fn, ms) => { id += 1; pending.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (h) => pending.delete(h),
  };
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const next = [...pending].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      pending.delete(next[0]);
      t = next[1].at;
      next[1].fn();
    }
    t = end;
  };
  return { timers, now: () => t, advance };
}

function setup({ humans = ['甲'], bots = 3, dealMode = false, dealRandom } = {}) {
  const clock = fakeClock();
  const room = new Room({ code: 'FAIR', delays: DELAYS, timers: clock.timers, now: clock.now, random: () => 0, ...(dealRandom ? { dealRandom } : {}) });
  const people = humans.map((n) => room.addHuman(n));
  for (let i = 0; i < bots; i++) room.addBot(people[0].id);
  for (const p of people) room.setOnline(p.id, true);
  if (dealMode) room.setDealMode(people[0].id, true);
  return { room, clock, host: people[0] };
}

const runUntil = (clock, predicate, step = 50, limit = 2_000_000) => {
  for (let spent = 0; !predicate(); spent += step) {
    if (spent > limit) throw new Error('never happened');
    clock.advance(step);
  }
};

const sorted = (cards) => [...cards].sort(compareCards);
// Each seat's dealt hand (sorted), the leader's followed by the leftover as prepareHand() stores it.
const expectedDealt = (order, leftover, leader) => order.map((o, seat) => (seat === leader ? [...sorted(o), ...leftover] : sorted(o)));

test('the server deals from its injected source, not from the match seed', () => {
  let calls = 0;
  const seeded = seededRandom(7);
  const { room, host } = setup({ dealRandom: (n) => { calls += 1; return seeded(n); } });
  room.start(host.id);
  assert.equal(calls, 108 - 1 + 1, 'one Fisher–Yates pass over 108 cards, then the first leader');
  const expected = deal({ playerCount: 4, decks: 2, random: seededRandom(7) });
  assert.deepEqual(room.handRecord.tribute.dealt, expected.hands);
  assert.notDeepEqual(room.handRecord.tribute.dealt, deal({ playerCount: 4, decks: 2, seed: handSeed(room.match, 0) }).hands);
  assert.equal(room.handRecord.seed, 0, 'no seed is stored for a crypto deal');
  room.destroy();
});

test('the default source is crypto: two rooms never deal the same hand', () => {
  const a = setup();
  const b = setup();
  a.room.start(a.host.id);
  b.room.start(b.host.id);
  assert.notDeepEqual(a.room.handRecord.tribute.dealt, b.room.handRecord.tribute.dealt);
  a.room.destroy();
  b.room.destroy();
});

test('hands of one match are independent of the match seed', () => {
  // Same deal source, different match seeds: the second hand is the same, so the seed plays no part.
  const hand2 = (matchSeed) => {
    const { room, host } = setup({ dealRandom: seededRandom(11) });
    room.start(host.id);
    room.match = recordHand({ ...room.match, seed: matchSeed }, { ranking: [0, 2, 1, 3], finished: [0, 2], captured: [0, 0, 0, 0] }).match;
    room.startHand();
    const { dealt } = room.prepared;
    room.destroy();
    return { dealt };
  };
  const x = hand2(1);
  const y = hand2(0xdeadbeef);
  assert.deepEqual(x.dealt, y.dealt);
  // And with the real source, hand 2 is not what the seed would have dealt.
  const { room, host } = setup();
  room.start(host.id);
  const h1 = room.prepared.dealt;
  room.match = recordHand(room.match, { ranking: [0, 2, 1, 3], finished: [0, 2], captured: [0, 0, 0, 0] }).match;
  room.startHand();
  assert.notDeepEqual(room.prepared.dealt, h1);
  assert.notDeepEqual(room.prepared.dealt, prepareHand(room.match).dealt);
  room.destroy();
});

test('dealing mode: the order shown while dealing is exactly the final hands (with the leftover to the leader)', () => {
  const { room, clock, host } = setup({ bots: 4, dealMode: true }); // 5 players: 3 cards left over
  room.start(host.id);
  const { order, leftover } = room.dealing;
  assert.equal(leftover.length, 3);
  runUntil(clock, () => room.phase !== 'dealing');
  assert.deepEqual(room.prepared.dealt, expectedDealt(order, leftover, room.prepared.leader));
  assert.deepEqual(room.prepared.leftover, leftover);
  room.destroy();
});

test('a snapshot mid-dealing restores the same cards', () => {
  const { room, clock, host } = setup({ bots: 4, dealMode: true });
  room.start(host.id);
  clock.advance(350);
  const { order, leftover } = room.dealing;
  const data = JSON.parse(JSON.stringify(room.toSnapshot()));
  room.destroy();
  assert.deepEqual(data.dealing.leftover, leftover);
  const c = fakeClock(9_000_000);
  // A restored room must not deal again: its own source would throw.
  const copy = Room.fromSnapshot(data, { delays: DELAYS, timers: c.timers, now: c.now, random: () => 0, dealRandom: () => { throw new Error('dealt again'); } });
  assert.deepEqual(copy.dealing.order, order);
  runUntil(c, () => copy.phase !== 'dealing');
  assert.deepEqual(copy.prepared.dealt, expectedDealt(order, leftover, copy.prepared.leader));
  copy.destroy();
});

test('an old snapshot mid-dealing (order from the match seed, no leftover) still restores from the seed', () => {
  const { room, clock, host } = setup({ bots: 4, dealMode: true });
  room.start(host.id);
  clock.advance(350);
  const data = JSON.parse(JSON.stringify(room.toSnapshot()));
  room.destroy();
  // What the old server saved: the order dealt from handSeed, and no leftover.
  const old = deal({ playerCount: 5, decks: 2, seed: handSeed(data.match, data.match.handNo) });
  data.dealing.order = old.order;
  delete data.dealing.leftover;
  delete data.balanceDeal;
  const c = fakeClock(9_000_000);
  const copy = Room.fromSnapshot(data, { delays: DELAYS, timers: c.timers, now: c.now, random: () => 0 });
  assert.equal(copy.balanceDeal, false);
  runUntil(c, () => copy.phase !== 'dealing');
  assert.deepEqual(copy.prepared.dealt, expectedDealt(old.order, old.leftover, copy.prepared.leader));
  assert.equal(copy.prepared.seed, handSeed(data.match, data.match.handNo));
  copy.destroy();
});

test('engine: prepareHand keeps seed-dealt hands for scripts and uses given cards as they are', () => {
  const match = createMatch({ playerCount: 4, decks: 2, seed: 5 });
  assert.deepEqual(prepareHand(match).dealt, deal({ playerCount: 4, decks: 2, seed: handSeed(match, 0) }).hands);
  const cards = deal({ playerCount: 4, decks: 2, random: seededRandom(3) });
  const p = prepareHand(match, { cards, random: () => 2 });
  assert.deepEqual(p.dealt, cards.hands);
  assert.equal(p.leader, 2);
  assert.equal(p.seed, 0);
});

test('replays of old matches (seeded hands) and new ones (seed 0) both load', async () => {
  const accounts = new Accounts(openDatabase(':memory:'));
  const me = (await accounts.register('Me1', 'secret1')).user;
  const stats = new Stats(accounts.db);
  const hand = (handNo, seed) => ({
    handNo, seed, leader: 0, tribute: { dealt: [[], [], [], []], leftover: [], pairs: [], resisted: false, given: [], returns: [] },
    initialHands: [['3S0'], [], [], []], actions: [], highlights: [],
    result: { ranking: [0, 2, 1, 3], finished: [0, 2], captured: [0, 0, 0, 0], score: [0, 0], penalties: [], winner: 0, sweep: false },
  });
  const id = accounts.recordMatch({
    roomCode: 'OLD1', playerCount: 4, decks: 2, mode: 'team', startedAt: 1, endedAt: 2, totals: [0, 0],
    players: [0, 1, 2, 3].map((seat) => ({
      seat, userId: seat === 0 ? me.id : null, name: `P${seat}`, isBot: seat !== 0, team: seat % 2, total: 0, heads: 0, tails: 0,
      ratingBefore: seat === 0 ? 60 : null, delta: seat === 0 ? 0 : null, leftEarly: false,
    })),
    hands: [hand(0, 3735928559), hand(1, 0)],
  });
  const replay = stats.replay(id);
  assert.equal(replay.hands.length, 2);
  assert.deepEqual(replay.hands.map((h) => h.initialHands[0]), [['3S0'], ['3S0']]);
  assert.equal(JSON.stringify(replay).includes('balance'), false);
});
