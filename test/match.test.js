import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, prepareHand, completeReturns, recordHand, isMatchOver, HANDS_PER_MATCH } from '../engine/match.js';

test('first hand: leftover goes to a leader, no tribute', () => {
  const m = createMatch({ playerCount: 5, decks: 2, seed: 99 });
  const p = prepareHand(m);
  assert.equal(p.handNo, 0);
  assert.equal(p.leftover.length, 3);
  assert.equal(p.hands[p.leader].length, 24);
  assert.deepEqual(p.tribute.pairs, []);
  assert.deepEqual(p.pendingReturns, []);
  assert.deepEqual(prepareHand(m), p, 'deterministic');
});

test('recordHand accumulates totals, heads, tails and sweeps', () => {
  let m = createMatch({ playerCount: 4, decks: 2, seed: 1 });
  ({ match: m } = recordHand(m, { ranking: [0, 2, 1, 3], finished: [0, 2], captured: [0, 100, 0, 100] }));
  assert.deepEqual(m.totals, [40, 160]);
  assert.deepEqual(m.heads, [1, 0, 0, 0]);
  assert.deepEqual(m.tails, [0, 0, 0, 1]);
  assert.deepEqual(m.sweeps, [1, 0]);
  assert.deepEqual(m.last, { ranking: [0, 2, 1, 3], winner: 0, sweep: true });
  assert.equal(m.handNo, 1);
});

test('second hand: previous head leads and tribute is applied, then returned', () => {
  let m = createMatch({ playerCount: 4, decks: 2, seed: 1 });
  ({ match: m } = recordHand(m, { ranking: [0, 2, 1, 3], finished: [0, 2], captured: [0, 100, 0, 100] }));
  const p = prepareHand(m);
  assert.equal(p.leader, 0);
  assert.deepEqual(p.tribute.pairs, [{ from: 3, to: 0 }, { from: 1, to: 2 }]);
  assert.equal(p.tribute.resisted, false);
  assert.equal(p.hands[0].length, 28);
  assert.equal(p.hands[3].length, 26);
  assert.deepEqual(p.pendingReturns, [{ from: 0, to: 3 }, { from: 2, to: 1 }]);
  const hands = completeReturns(p, [
    { from: 0, to: 3, card: p.hands[0][0] },
    { from: 2, to: 1, card: p.hands[2][0] },
  ]);
  assert.deepEqual(hands.map((h) => h.length), [27, 27, 27, 27]);
});

test('completeReturns throws on duplicate, missing or extra returns', () => {
  let m = createMatch({ playerCount: 4, decks: 2, seed: 1 });
  ({ match: m } = recordHand(m, { ranking: [0, 2, 1, 3], finished: [0, 2], captured: [0, 100, 0, 100] }));
  const p = prepareHand(m);
  assert.equal(p.tribute.resisted, false);
  assert.deepEqual(p.pendingReturns, [{ from: 0, to: 3 }, { from: 2, to: 1 }]);

  // duplicate pair (two returns from seat 0 to seat 3)
  assert.throws(() => completeReturns(p, [
    { from: 0, to: 3, card: p.hands[0][0] },
    { from: 0, to: 3, card: p.hands[0][1] },
  ]), /bad_returns/);

  // empty list when pendingReturns is non-empty
  assert.throws(() => completeReturns(p, []), /bad_returns/);

  // a valid list still works
  const hands = completeReturns(p, [
    { from: 0, to: 3, card: p.hands[0][0] },
    { from: 2, to: 1, card: p.hands[2][0] },
  ]);
  assert.deepEqual(hands.map((h) => h.length), [27, 27, 27, 27]);
});

test('match is over after 10 hands', () => {
  let m = createMatch({ playerCount: 5, decks: 2, seed: 3 });
  for (let i = 0; i < HANDS_PER_MATCH; i++) {
    assert.equal(isMatchOver(m), false);
    ({ match: m } = recordHand(m, { ranking: [0, 1, 2, 3, 4], finished: [0, 1, 2, 3], captured: [40, 40, 40, 40, 40] }));
  }
  assert.equal(isMatchOver(m), true);
  assert.deepEqual(m.totals, [600, 400, 400, 400, 200]);
});

test('prepareHand: a leader override leads and takes the leftover; without it nothing changes', () => {
  let m = createMatch({ playerCount: 5, decks: 2, seed: 99 });
  const plain = prepareHand(m);
  const other = (plain.leader + 2) % 5;
  const p = prepareHand(m, { leader: other });
  assert.equal(p.leader, other);
  assert.equal(p.hands[other].length, 24);
  assert.deepEqual(p.leftover, plain.leftover);
  assert.deepEqual(prepareHand(m, {}), plain);
  assert.throws(() => prepareHand(m, { leader: 5 }), /bad_leader/);
  ({ match: m } = recordHand(m, { ranking: [3, 0, 1, 2, 4], finished: [3, 0, 1, 2], captured: [0, 0, 0, 0, 0] }));
  assert.equal(prepareHand(m).leader, 3, 'previous head by default');
  const q = prepareHand(m, { leader: 1 });
  assert.equal(q.leader, 1);
  assert.deepEqual(q.tribute.pairs, [{ from: 4, to: 3 }], 'tribute still follows the previous hand');
});
