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
  if (p.tribute.resisted) return;
  assert.equal(p.hands[0].length, 28);
  assert.equal(p.hands[3].length, 26);
  assert.deepEqual(p.pendingReturns, [{ from: 0, to: 3 }, { from: 2, to: 1 }]);
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
