import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeck, deal, pointsOf, sumPoints, compareCards, valueOf, isJoker,
  teamsFor, defaultDecks, createRng,
} from '../engine/cards.js';

test('buildDeck has 54 unique cards per deck', () => {
  const d = buildDeck(2);
  assert.equal(d.length, 108);
  assert.equal(new Set(d).size, 108);
  assert.ok(d.includes('LJ0') && d.includes('BJ1') && d.includes('TS1'));
});

test('points: 5=5, T=10, K=10, others 0; 100 per deck', () => {
  assert.equal(pointsOf('5H0'), 5);
  assert.equal(pointsOf('TS0'), 10);
  assert.equal(pointsOf('KD1'), 10);
  assert.equal(pointsOf('AS0'), 0);
  assert.equal(pointsOf('BJ0'), 0);
  assert.equal(sumPoints(buildDeck(3)), 300);
});

test('rank values: 3 lowest, 2 above A, jokers on top', () => {
  assert.equal(valueOf('3S0'), 3);
  assert.equal(valueOf('KS0'), 13);
  assert.equal(valueOf('AS0'), 14);
  assert.equal(valueOf('2S0'), 15);
  assert.equal(valueOf('LJ0'), 16);
  assert.equal(valueOf('BJ0'), 17);
  assert.ok(isJoker('LJ0') && !isJoker('JS0'));
});

test('compareCards orders by value then suit S>H>C>D', () => {
  const sorted = ['2D0', '3S0', 'BJ0', '3D0', 'LJ0', 'AS0'].sort(compareCards);
  assert.deepEqual(sorted, ['3D0', '3S0', 'AS0', '2D0', 'LJ0', 'BJ0']);
});

test('deal splits evenly and returns leftovers', () => {
  const cases = [[4, 2, 27, 0], [5, 2, 21, 3], [6, 2, 18, 0], [7, 3, 23, 1], [8, 3, 20, 2]];
  for (const [playerCount, decks, per, left] of cases) {
    const { hands, leftover } = deal({ playerCount, decks, seed: 42 });
    assert.equal(hands.length, playerCount);
    hands.forEach((h) => assert.equal(h.length, per));
    assert.equal(leftover.length, left);
    assert.equal(new Set([...hands.flat(), ...leftover]).size, 54 * decks);
  }
});

test('deal is deterministic for a seed', () => {
  assert.deepEqual(deal({ playerCount: 4, decks: 2, seed: 7 }), deal({ playerCount: 4, decks: 2, seed: 7 }));
  assert.notDeepEqual(deal({ playerCount: 4, decks: 2, seed: 7 }), deal({ playerCount: 4, decks: 2, seed: 8 }));
});

test('deal rejects bad config', () => {
  assert.throws(() => deal({ playerCount: 3, decks: 2, seed: 1 }));
  assert.throws(() => deal({ playerCount: 4, decks: 1, seed: 1 }));
  assert.throws(() => deal({ playerCount: 9, decks: 2, seed: 1 }));
});

test('teams alternate seats for even counts, null for odd', () => {
  assert.deepEqual(teamsFor(6), [0, 1, 0, 1, 0, 1]);
  assert.equal(teamsFor(5), null);
  assert.equal(defaultDecks(6), 2);
  assert.equal(defaultDecks(7), 3);
});

test('rng yields values in [0,1)', () => {
  const rng = createRng(123);
  for (let i = 0; i < 1000; i++) {
    const x = rng();
    assert.ok(x >= 0 && x < 1);
  }
});

test('deal exposes each seat\'s cards in dealt order; sorting them gives the hands', () => {
  const { hands, order } = deal({ playerCount: 5, decks: 2, seed: 11 });
  assert.equal(order.length, 5);
  order.forEach((o, i) => {
    assert.equal(o.length, hands[i].length);
    assert.deepEqual([...o].sort(compareCards), hands[i]);
  });
  assert.ok(order.some((o, i) => o.join() !== hands[i].join()), 'dealt order is not already sorted');
});
