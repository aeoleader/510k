import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleHand, tributePairs, applyTribute, applyReturn, lowestCard } from '../engine/tribute.js';

const T4 = [0, 1, 0, 1];
const T6 = [0, 1, 0, 1, 0, 1];

test('team: unfinished opponent pays 20 to the head team', () => {
  // Seat 0 head, then 1, then 2 (team 0 all out). Seat 3 unfinished.
  const r = settleHand({ teams: T4, captured: [60, 50, 40, 50], ranking: [0, 1, 2, 3], finished: [0, 1, 2] });
  assert.deepEqual(r.score, [120, 80]);
  assert.deepEqual(r.penalties, [{ from: 1, to: 0, count: 1, amount: 20 }]);
  assert.equal(r.winner, 0);
  assert.equal(r.sweep, false);
});

test('team: two unfinished pay 40, capped at what the team has', () => {
  const r = settleHand({ teams: T4, captured: [150, 10, 20, 20], ranking: [0, 2, 1, 3], finished: [0, 2] });
  assert.deepEqual(r.score, [200, 0]);
  assert.equal(r.penalties[0].amount, 30);
  assert.equal(r.sweep, true);
  assert.equal(r.winner, 0);
});

test('team: unfinished player on the head team pays nothing', () => {
  const r = settleHand({ teams: T4, captured: [50, 60, 0, 90], ranking: [0, 1, 3, 2], finished: [0, 1, 3] });
  assert.deepEqual(r.score, [50, 150]);
  assert.deepEqual(r.penalties, []);
  assert.equal(r.winner, 1);
});

test('team: tie on score goes to the head team', () => {
  const r = settleHand({ teams: T4, captured: [50, 50, 30, 70], ranking: [1, 0, 3, 2], finished: [1, 0, 3] });
  assert.deepEqual(r.score, [60, 140], "seat 2 is unfinished and pays 20 to the head team");
  const tie = settleHand({ teams: T4, captured: [50, 50, 50, 50], ranking: [1, 0, 2, 3], finished: [1, 0, 2] });
  assert.deepEqual(tie.score, [100, 100]);
  assert.equal(tie.winner, 1);
});

test('team: sweep wins even with fewer points', () => {
  const r = settleHand({ teams: T4, captured: [0, 100, 0, 100], ranking: [0, 2, 1, 3], finished: [0, 2] });
  assert.deepEqual(r.score, [40, 160]);
  assert.equal(r.sweep, true);
  assert.equal(r.winner, 0);
});

test('ffa: last pays 20 to head', () => {
  const r = settleHand({ teams: null, captured: [10, 50, 0, 40, 100], ranking: [2, 0, 1, 3, 4], finished: [2, 0, 1, 3] });
  assert.deepEqual(r.score, [10, 50, 20, 40, 80]);
  assert.equal(r.winner, null);
});

test('team 6p: sweep settlement and tribute', () => {
  const r = settleHand({
    teams: T6, captured: [30, 40, 30, 40, 30, 30], ranking: [0, 2, 4, 1, 3, 5], finished: [0, 2, 4],
  });
  assert.equal(r.sweep, true);
  assert.equal(r.winner, 0);
  assert.deepEqual(r.score, [150, 50]);
  assert.deepEqual(tributePairs({ teams: T6, ranking: [0, 2, 4, 1, 3, 5], winner: r.winner, sweep: r.sweep }), [
    { from: 5, to: 0 }, { from: 3, to: 2 },
  ]);
});

test('tribute pairs: sweep -> last two give to winners 1st and 2nd', () => {
  assert.deepEqual(tributePairs({ teams: T4, ranking: [0, 2, 1, 3], winner: 0, sweep: true }), [
    { from: 3, to: 0 }, { from: 1, to: 2 },
  ]);
});

test('tribute pairs: non-sweep chain from the bottom stops at a winner', () => {
  assert.deepEqual(tributePairs({ teams: T4, ranking: [0, 1, 2, 3], winner: 0, sweep: false }), [{ from: 3, to: 0 }]);
  assert.deepEqual(tributePairs({ teams: T4, ranking: [0, 1, 2, 3], winner: 1, sweep: false }), []);
  assert.deepEqual(tributePairs({ teams: T6, ranking: [0, 2, 1, 4, 3, 5], winner: 0, sweep: false }), [
    { from: 5, to: 0 }, { from: 3, to: 2 },
  ]);
});

test('tribute pairs: ffa last gives to head', () => {
  assert.deepEqual(tributePairs({ teams: null, ranking: [3, 1, 0, 4, 2], winner: null, sweep: false }), [{ from: 2, to: 3 }]);
});

test('applyTribute gives the highest card', () => {
  const hands = [['3S0'], ['4S0', 'AS0', '2D0'], ['5S0'], ['6S0']];
  const r = applyTribute({ hands, pairs: [{ from: 1, to: 0 }], decks: 2 });
  assert.equal(r.resisted, false);
  assert.deepEqual(r.given, [{ from: 1, to: 0, card: '2D0' }]);
  assert.deepEqual(r.hands[0], ['3S0', '2D0']);
  assert.deepEqual(r.hands[1], ['4S0', 'AS0']);
});

test('applyTribute is resisted when a tributer holds every joker', () => {
  const hands = [['3S0'], ['LJ0', 'LJ1', 'BJ0', 'BJ1'], ['5S0'], ['6S0']];
  const r = applyTribute({ hands, pairs: [{ from: 1, to: 0 }], decks: 2 });
  assert.equal(r.resisted, true);
  assert.deepEqual(r.hands, hands);
  const three = applyTribute({ hands: [['3S0'], ['LJ0', 'LJ1', 'BJ0', 'BJ1'], ['5S0'], ['6S0']], pairs: [{ from: 1, to: 0 }], decks: 3 });
  assert.equal(three.resisted, false, '3 decks need all 6 jokers');
});

test('applyReturn moves a chosen card back; lowestCard picks the smallest', () => {
  const hands = applyReturn({ hands: [['3S0', '2D0'], ['4S0']], from: 0, to: 1, card: '3S0' });
  assert.deepEqual(hands, [['2D0'], ['3S0', '4S0']]);
  assert.throws(() => applyReturn({ hands, from: 0, to: 1, card: '9S0' }));
  assert.equal(lowestCard(['KS0', '3D0', '3S0']), '3D0');
});
