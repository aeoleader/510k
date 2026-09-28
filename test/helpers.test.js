import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortBySize, sortBy510k, bombValues } from '../engine/sort.js';
import { counterView } from '../engine/counter.js';
import { findHighlights } from '../engine/highlights.js';
import { createHandState, replay } from '../engine/game.js';

test('sortBySize: big to small, suits S H C D', () => {
  assert.deepEqual(sortBySize(['3D0', 'BJ0', '3S0', 'AS0', 'LJ0', '2H0']), ['BJ0', 'LJ0', '2H0', 'AS0', '3S0', '3D0']);
});

test('sortBy510k: pure groups first by suit, then mixed, then the rest', () => {
  const hand = ['5H0', 'TH0', 'KH0', '5S0', 'TS0', 'KS0', '5D0', 'TC0', 'KC1', '3S0', 'AS0'];
  const { groups, rest } = sortBy510k(hand);
  assert.deepEqual(groups, [['5S0', 'TS0', 'KS0'], ['5H0', 'TH0', 'KH0'], ['5D0', 'TC0', 'KC1']]);
  assert.deepEqual(rest, ['AS0', '3S0']);
});

test('bombValues finds ranks held 4+ times', () => {
  assert.deepEqual(bombValues(['3S0', '3H0', '3C0', '3D0', '4S0', 'LJ0', 'LJ1', 'BJ0', 'BJ1']), new Set([3]));
});

test('counterView counts unseen cards and points', () => {
  const v = counterView({ decks: 2, ownHand: ['5S0', 'KS0', 'LJ0'], played: ['5S1', 'TS0', 'BJ1'] });
  assert.equal(v.fives, 6);
  assert.equal(v.tens, 7);
  assert.equal(v.kings, 7);
  assert.equal(v.jokers, 2);
  assert.equal(v.remaining['3'], 8);
  assert.equal(v.points, 200 - 5 - 10 - 5 - 10);
});

test('highlights: big bomb, steal, big trick, gift, team bomb, auto, sweep', () => {
  const s = createHandState({
    hands: [
      ['KS0', '3S0'],
      ['3H0', '3H1', '3C0', '3C1', '3D0', '3D1', '9S0'],
      ['5S0', 'TS0', 'KH0', '4S0'],
      ['TH0', '4H0'],
    ],
    teams: [0, 1, 0, 1], leader: 0, decks: 2,
  });
  const { events } = replay(s, [
    { seat: 0, type: 'play', cards: ['KS0'] },
    { seat: 1, type: 'pass' },
    { seat: 2, type: 'play', cards: ['5S0', 'TS0', 'KH0'] }, // mixed 510K over a teammate
    { seat: 3, type: 'pass', auto: true },
    { seat: 0, type: 'pass' },
    { seat: 1, type: 'play', cards: ['3H0', '3H1', '3C0', '3C1', '3D0', '3D1'] }, // 6-bomb over opponent
    { seat: 2, type: 'pass' },
    { seat: 3, type: 'pass' },
    { seat: 0, type: 'pass' },
  ]);
  const tags = findHighlights({ events, teams: [0, 1, 0, 1], decks: 2, sweep: true }).map((h) => h.tag);
  assert.deepEqual(tags.sort(), ['auto', 'big_bomb', 'big_trick', 'gift', 'gift', 'steal', 'sweep', 'team_bomb'].sort());
});

test('highlights: consecutive automatic actions by one seat are tagged once', () => {
  const events = [
    { seq: 0, type: 'play', seat: 0, cards: ['3S0'], combo: { cat: 0, type: 'single', level: 0 }, auto: true },
    { seq: 1, type: 'pass', seat: 1, auto: false },
    { seq: 2, type: 'pass', seat: 0, auto: true },
    { seq: 3, type: 'pass', seat: 0, auto: false },
    { seq: 4, type: 'pass', seat: 0, auto: true },
  ];
  const autos = findHighlights({ events, teams: [0, 1, 0, 1], decks: 2 }).filter((h) => h.tag === 'auto');
  assert.deepEqual(autos.map((h) => h.eventSeq), [0, 4]);
});
