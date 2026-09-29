import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';
import { HttpError } from '../server/http.js';
import { parseBalanceDeal } from '../server/validate.js';
import { deal, seededRandom } from '../engine/cards.js';
import { createMatch, recordHand } from '../engine/match.js';
import {
  handStrength, sideStrength, balanceTarget, balanceChance, balancedDeal, BALANCE_MIN_DEFICIT,
} from '../server/balance.js';

// 发牌平衡: a hidden, host-only lobby setting that sometimes gives a side far behind the better of two deals.

const DELAYS = {
  turnMs: 10000, returnMs: 30000, botMs: 700, nextHandMs: 30000,
  tributeMs: 5000, returnRevealMs: 3000, dealRoundMs: 100, claimGraceMs: 3000,
};

function fakeClock() {
  let t = 1000;
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

function setup({ humans = ['甲', '乙', '丙', '丁'], bots = 0, ...deps } = {}) {
  const clock = fakeClock();
  const room = new Room({ code: 'BAL', delays: DELAYS, timers: clock.timers, now: clock.now, random: () => 0, ...deps });
  const people = humans.map((n) => room.addHuman(n));
  for (let i = 0; i < bots; i++) room.addBot(people[0].id);
  for (const p of people) room.setOnline(p.id, true);
  return { room, clock, people, host: people[0] };
}

const code = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof HttpError, String(e)); return `${e.status} ${e.code}`; }
  return null;
};

// A match after one hand with the given totals.
function matchWith(totals, playerCount = 4) {
  const m = createMatch({ playerCount, decks: 2, seed: 1 });
  return { ...m, handNo: 1, totals: [...totals], last: { ranking: [...Array(playerCount).keys()], winner: m.teams ? 0 : null, sweep: false } };
}

// ---- hand strength ---------------------------------------------------------

test('handStrength: jokers, 2s and As count, big joker above small', () => {
  assert.equal(handStrength([]), 0);
  assert.equal(handStrength(['BJ0']), 6);
  assert.equal(handStrength(['LJ0']), 5);
  assert.equal(handStrength(['2S0']), 3);
  assert.equal(handStrength(['AS0']), 2);
  assert.ok(handStrength(['BJ0']) > handStrength(['LJ0']));
});

test('handStrength: bombs grow with size; every joker together is a bonus', () => {
  const four = ['QS0', 'QH0', 'QC0', 'QD0'];
  assert.equal(handStrength(four), 4);
  assert.equal(handStrength([...four, 'QS1']), 7);
  assert.equal(handStrength([...four, 'QS1', 'QH1']), 10);
  assert.equal(handStrength(['LJ0', 'LJ1', 'BJ0', 'BJ1']), 5 + 5 + 6 + 6 + 10);
  assert.equal(handStrength(['LJ0', 'LJ1', 'LJ2', 'BJ0', 'BJ1', 'BJ2'], 3), 3 * 5 + 3 * 6 + 10);
  assert.equal(handStrength(['LJ0', 'LJ1', 'BJ0', 'BJ1'], 3), 22, 'not every joker with 3 decks');
});

test('handStrength: 510K sets, pure ones worth a little more', () => {
  assert.equal(handStrength(['5S0', 'TH0', 'KC0']), 2 - 1, 'the lone 5 is still a low singleton');
  assert.equal(handStrength(['5S0', 'TS0', 'KS0']), 3 - 1);
  assert.equal(handStrength(['5S0', 'TS0', 'KS0', '5H0', 'TH0', 'KD0']), 2 * 2 + 1);
  assert.equal(handStrength(['5S0', '5H0', 'TS0', 'KS0']), 3, 'only one set without a second 10 and K');
});

test('handStrength: low singletons (3-9 held once) cost a point each', () => {
  assert.equal(handStrength(['3S0', '4S0', '9S0']), -3);
  assert.equal(handStrength(['3S0', '3H0']), 0, 'a pair is not a singleton');
  assert.equal(handStrength(['TS0', 'JS0', 'QS0']), 0, 'high singletons are free');
  assert.equal(handStrength(['5S0']), -1);
});

test('handStrength ranks a strong hand above a weak one; sideStrength sums seats', () => {
  const strong = ['BJ0', 'BJ1', '2S0', '2H0', 'AS0', 'AH0', 'KS0', 'KH0', 'KC0', 'KD0', '5S0', 'TS0'];
  const weak = ['3S0', '4H0', '6C0', '7D0', '8S0', '9H0', 'JS0', 'QH0', 'TD0', 'TC0', '6S0', '4D0'];
  assert.ok(handStrength(strong) > handStrength(weak));
  assert.equal(sideStrength([strong, weak, strong], [0, 2]), 2 * handStrength(strong));
});

// ---- who is favoured and how often -----------------------------------------

test('balanceChance: 25% at 100, 50% from 300 on', () => {
  assert.equal(balanceChance(100), 0.25);
  assert.equal(balanceChance(200), 0.375);
  assert.equal(balanceChance(300), 0.5);
  assert.equal(balanceChance(500), 0.5);
  assert.equal(balanceChance(2000), 0.5);
});

test('balanceTarget: the trailing team, only from the second hand and 100 points behind', () => {
  assert.equal(balanceTarget({ ...matchWith([400, 0]), handNo: 0 }), null, 'first hand never biased');
  assert.equal(balanceTarget(matchWith([199, 100])), null);
  assert.deepEqual(balanceTarget(matchWith([200, 100])), { seats: [1, 3], deficit: BALANCE_MIN_DEFICIT });
  assert.deepEqual(balanceTarget(matchWith([50, 400])), { seats: [0, 2], deficit: 350 });
  assert.deepEqual(balanceTarget(matchWith([100, 100], 6)), null);
});

test('balanceTarget: FFA favours the lowest player against the average of the others', () => {
  assert.deepEqual(balanceTarget(matchWith([200, 300, 20, 250, 250], 5)), { seats: [2], deficit: 250 - 20 });
  assert.equal(balanceTarget(matchWith([100, 150, 60, 100, 150], 5)), null, 'average others 125 - 60 < 100');
});

// ---- the pick ----------------------------------------------------------------

// Fake deals: hands whose strength for seats 1/3 is `s` (one BJ each is 6).
const fakeDeal = (tag, jokersForSide) => ({
  tag, hands: [[], Array(jokersForSide).fill('BJ0'), [], []], order: [], leftover: [],
});

test('balancedDeal: under 100 behind, one deal and no coin', () => {
  let deals = 0;
  const r = balancedDeal({
    match: matchWith([150, 60]), deal: () => fakeDeal(deals += 1, 0), coin: () => assert.fail('no coin under 100'),
  });
  assert.equal(r.candidates, 1);
  assert.equal(deals, 1);
});

for (const [firstJ, secondJ, heads, want] of [[0, 2, true, 2], [0, 2, false, 1], [3, 1, true, 1], [3, 1, false, 1], [1, 1, true, 1]]) {
  test(`balancedDeal: first ${firstJ} / second ${secondJ} jokers for the trailers, coin ${heads} -> deal ${want}`, () => {
    const ps = [];
    const js = [firstJ, secondJ];
    let n = 0;
    const r = balancedDeal({
      match: matchWith([400, 100]), deal: () => fakeDeal(n + 1, js[n++]), coin: (p) => { ps.push(p); return heads; },
    });
    assert.equal(r.candidates, 2);
    assert.equal(r.cards.tag, want);
    assert.deepEqual(ps, [0.5]);
  });
}

test('balancedDeal: the coin is asked with p from the deficit', () => {
  for (const [totals, p] of [[[200, 100], 0.25], [[400, 100], 0.5], [[700, 100], 0.5], [[300, 100], 0.375]]) {
    const ps = [];
    balancedDeal({ match: matchWith(totals), deal: () => fakeDeal(0, 0), coin: (x) => { ps.push(x); return false; } });
    assert.deepEqual(ps, [p]);
  }
});

test('balancedDeal: FFA picks the deal better for the lowest seat', () => {
  const match = matchWith([300, 300, 0, 300, 300], 5);
  const hands = (s2) => ({ hands: [['BJ0'], [], s2, [], []], order: [], leftover: [] });
  const weak = hands(['3S0']);
  const strong = hands(['2S0', '2H0']);
  const seq = [weak, strong];
  assert.equal(balancedDeal({ match, deal: () => seq.shift(), coin: () => true }).cards, strong);
});

// ---- the room ----------------------------------------------------------------

test('balanceDeal is a host-only lobby setting', () => {
  const { room, host, people } = setup();
  assert.equal(code(() => room.setBalanceDeal(people[1].id, true)), '403 host_only');
  room.setBalanceDeal(host.id, true);
  assert.equal(room.balanceDeal, true);
  room.start(host.id);
  assert.equal(code(() => room.setBalanceDeal(host.id, false)), '409 in_progress');
  room.destroy();
  assert.throws(() => parseBalanceDeal('true'), (e) => e.status === 400 && e.code === 'bad_balance_deal');
  assert.throws(() => parseBalanceDeal(undefined), (e) => e.status === 400);
  assert.equal(parseBalanceDeal(false), false);
});

test('balanceDeal is only in the host\'s view, in every phase, and never in the log', () => {
  const { room, clock, host, people } = setup({ humans: ['甲', '乙'], bots: 2 });
  const check = () => {
    assert.equal(room.viewFor(host.id).balanceDeal, true, room.phase);
    for (const p of people.slice(1)) assert.equal('balanceDeal' in room.viewFor(p.id), false, room.phase);
    assert.equal('balanceDeal' in room.viewFor('nobody'), false);
    assert.equal(JSON.stringify(room.log).includes('平衡'), false);
  };
  room.setBalanceDeal(host.id, true);
  check();
  room.setDealMode(host.id, true);
  room.start(host.id);
  const seen = new Set();
  for (let i = 0; i < 20000 && room.phase !== 'match_over'; i++) {
    seen.add(room.phase);
    check();
    for (const p of people) {
      if (room.phase === 'dealing' && room.dealRounds() >= room.dealing.total) try { room.claimThree(p.id); } catch { /* not theirs */ }
      if (['tribute', 'return_reveal', 'hand_over'].includes(room.phase)) try { room.markReady(p.id); } catch { /* already */ }
    }
    clock.advance(2000);
  }
  check();
  assert.ok(seen.has('dealing') && seen.has('playing') && seen.has('hand_over'), [...seen].join());
  assert.equal(JSON.stringify(room.handLog).includes('balance'), false);
  room.destroy();
});

test('balanceDeal survives a snapshot; old snapshots default to off', () => {
  const { room, host } = setup();
  room.setBalanceDeal(host.id, true);
  const data = JSON.parse(JSON.stringify(room.toSnapshot()));
  room.destroy();
  assert.equal(data.balanceDeal, true);
  const c = fakeClock();
  const copy = Room.fromSnapshot(data, { delays: DELAYS, timers: c.timers, now: c.now });
  assert.equal(copy.balanceDeal, true);
  copy.destroy();
  delete data.balanceDeal;
  const old = Room.fromSnapshot(data, { delays: DELAYS, timers: c.timers, now: c.now });
  assert.equal(old.balanceDeal, false);
  old.destroy();
});

// The room's second hand after a first that left team 0 `lead` points ahead.
function secondHand({ lead, on = true, heads = true, seed = 21, dealMode = false }) {
  const coins = [];
  const src = seededRandom(seed);
  let draws = 0;
  const { room, host, clock } = setup({
    dealRandom: (n) => { draws += 1; return src(n); }, coin: (p) => { coins.push(p); return heads; },
  });
  room.setBalanceDeal(host.id, on);
  if (dealMode) room.setDealMode(host.id, true);
  room.start(host.id);
  if (dealMode) {
    room.claimedBy = 0;
    clock.advance(10_000);
  }
  const firstDraws = draws;
  const firstCoins = coins.slice();
  room.match = recordHand(room.match, { ranking: [0, 2, 1, 3], finished: [0, 2], captured: [lead, 0, 0, 0] }).match;
  draws = 0;
  room.startHand();
  const cards = dealMode ? { order: room.dealing.order, leftover: room.dealing.leftover } : null;
  return { room, coins, firstDraws, firstCoins, draws, cards, host, clock };
}

test('room: the first hand is never biased (one shuffle, no coin)', () => {
  const { room, firstCoins, firstDraws } = secondHand({ lead: 300 });
  assert.equal(firstDraws, 108, 'one shuffle (107 draws) and the first leader');
  assert.deepEqual(firstCoins, []);
  room.destroy();
});

test('room: less than 100 behind deals once', () => {
  const { room, coins, draws } = secondHand({ lead: 90 });
  assert.equal(draws, 107);
  assert.deepEqual(coins, []);
  room.destroy();
});

test('room: off deals once however far behind', () => {
  const { room, coins, draws } = secondHand({ lead: 400, on: false });
  assert.equal(draws, 107);
  assert.deepEqual(coins, []);
  room.destroy();
});

for (const heads of [true, false]) {
  test(`room: 100+ behind deals two candidates and keeps the better only when the coin says so (${heads})`, () => {
    for (const seed of [21, 22, 23, 24, 25, 26]) {
      const { room, coins, draws } = secondHand({ lead: 300, heads, seed });
      assert.equal(draws, 2 * 107, 'two independent shuffles');
      assert.deepEqual(coins, [0.5]);
      // Rebuild the two candidates from the same stream, after the first hand's 108 draws.
      const a = deal({ playerCount: 4, decks: 2, random: seededRandomAfter(seed, 108) });
      const b = deal({ playerCount: 4, decks: 2, random: seededRandomAfter(seed, 108 + 107) });
      const trail = [1, 3];
      const better = sideStrength(b.hands, trail) > sideStrength(a.hands, trail) ? b : a;
      assert.deepEqual(room.prepared.dealt, (heads ? better : a).hands);
      room.destroy();
    }
  });
}

test('room: dealing mode deals the chosen candidate card by card and keeps it for the hands', () => {
  const { room, cards, clock, firstDraws } = secondHand({ lead: 300, dealMode: true, seed: 30 });
  assert.equal(firstDraws, 107, 'the black 3 picks the leader, so only the shuffle');
  const a = deal({ playerCount: 4, decks: 2, random: seededRandomAfter(30, 107) });
  const b = deal({ playerCount: 4, decks: 2, random: seededRandomAfter(30, 107 + 107) });
  const better = sideStrength(b.hands, [1, 3]) > sideStrength(a.hands, [1, 3]) ? b : a;
  assert.deepEqual(cards.order, better.order);
  room.claimedBy = 1;
  clock.advance(10_000);
  assert.deepEqual(room.prepared.dealt, better.hands);
  room.destroy();
});

// A seeded source that has already drawn `skip` values (the draws are what the room made before).
function seededRandomAfter(seed, skip) {
  const src = seededRandom(seed);
  for (let i = 0; i < skip; i++) src(2);
  return src;
}
