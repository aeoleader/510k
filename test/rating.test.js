import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankInfo, computeRatingDeltas, START_RATING } from '../engine/rating.js';

test('rankInfo tiers and stars', () => {
  assert.equal(START_RATING, 60);
  assert.deepEqual([rankInfo(60).key, rankInfo(60).stars], ['silver', 0]);
  assert.deepEqual([rankInfo(29).key, rankInfo(29).stars], ['iron', 2]);
  assert.deepEqual([rankInfo(-15).key, rankInfo(-15).stars], ['iron', 0]);
  assert.deepEqual([rankInfo(179).key, rankInfo(179).stars], ['diamond', 2]);
  assert.deepEqual([rankInfo(250).key, rankInfo(250).stars], ['king', 7]);
});

const teamMatch = (over) => ({
  playerCount: 4, decks: 2, teams: [0, 1, 0, 1],
  totals: [1300, 700], heads: [4, 3, 2, 1], tails: [1, 2, 3, 4], sweeps: [2, 0], ...over,
});
const everyone = (ratings, extra = {}) => ratings.map((r, seat) => ({ seat, rated: true, ratingBefore: r, leftEarly: false, ...(extra[seat] || {}) }));

test('team: base, margin, sweeps and personal', () => {
  // diff 600 over 2 decks -> floor(600/100)=6
  const d = computeRatingDeltas(teamMatch(), everyone([60, 60, 60, 60]));
  assert.deepEqual(d.map((x) => x.delta), [
    20 + 6 + 4 + 3,   // seat 0: win, margin, 2 sweeps, 4 heads - 1 tail
    -20 - 6 + 0 + 1,  // seat 1: loss, 3 heads - 2 tails
    20 + 6 + 4 - 1,
    -20 - 6 + 0 - 3,
  ]);
});

test('team: margin capped at 10, losses scaled by tier', () => {
  const d = computeRatingDeltas(teamMatch({ totals: [2000, 0], heads: [0, 0, 0, 0], tails: [0, 0, 0, 0], sweeps: [0, 0] }),
    everyone([60, 10, 60, 200]));
  assert.deepEqual(d.map((x) => x.delta), [30, -15, 30, -45]);
});

test('team: tie broken by sweeps, else draw', () => {
  const tieSweeps = computeRatingDeltas(teamMatch({ totals: [1000, 1000], heads: [0, 0, 0, 0], tails: [0, 0, 0, 0], sweeps: [0, 1] }), everyone([60, 60, 60, 60]));
  assert.deepEqual(tieSweeps.map((x) => x.delta), [-20, 22, -20, 22]);
  const draw = computeRatingDeltas(teamMatch({ totals: [1000, 1000], heads: [0, 0, 0, 0], tails: [0, 0, 0, 0], sweeps: [0, 0] }), everyone([60, 60, 60, 60]));
  assert.deepEqual(draw.map((x) => x.delta), [0, 0, 0, 0]);
});

test('team: leaving early counts as a loss, no sweep bonus, x1.5 on the loss', () => {
  const d = computeRatingDeltas(teamMatch(), everyone([60, 60, 60, 60], { 0: { leftEarly: true } }));
  assert.equal(d[0].delta, -35); // raw -23 x 1.5 = -34.5 -> -35 (half away from zero)
});

test('unrated seats get null', () => {
  const d = computeRatingDeltas(teamMatch(), everyone([60, 60, 60, 60], { 1: { rated: false } }));
  assert.equal(d[1].delta, null);
});

const ffaMatch = (over) => ({
  playerCount: 5, decks: 2, teams: null,
  totals: [500, 300, 900, 100, 200], heads: [2, 2, 5, 0, 1], tails: [0, 1, 0, 6, 3], sweeps: [0, 0], ...over,
});

test('ffa: place-based base plus personal', () => {
  // order by total: seat2 (1st, +20), seat0 (2nd, +10), seat1 (3rd, 0), seat4 (4th, -10), seat3 (5th, -20)
  const d = computeRatingDeltas(ffaMatch(), everyone([60, 60, 60, 60, 60]));
  assert.deepEqual(d.map((x) => x.delta), [12, 1, 25, -26, -12]);
});

test('ffa: ties on total and heads share the average base', () => {
  const d = computeRatingDeltas(ffaMatch({ totals: [400, 400, 900, 100, 200], heads: [1, 1, 5, 0, 1], tails: [0, 0, 0, 6, 3] }),
    everyone([60, 60, 60, 60, 60]));
  assert.equal(d[0].delta, 6); // avg of +10 and 0 = 5, +1 head
  assert.equal(d[1].delta, 6);
});

test('ffa: leaving early drops to last place', () => {
  const d = computeRatingDeltas(ffaMatch(), everyone([60, 60, 60, 60, 60], { 2: { leftEarly: true } }));
  // seat 2 is last: -20 + 5 heads = -15, x1.0 tier x1.5 = -22.5 -> -23 (half away from zero)
  assert.equal(d[2].delta, -23);
});

test('ffa: 7-player tie averages unrounded bases', () => {
  const match = {
    playerCount: 7, decks: 3, teams: null,
    totals: [900, 500, 400, 400, 100, 50, 0], heads: [0, 0, 0, 0, 0, 0, 0], tails: [0, 0, 0, 0, 0, 0, 0], sweeps: [0, 0],
  };
  const d = computeRatingDeltas(match, everyone([60, 60, 60, 60, 60, 60, 60]));
  assert.deepEqual(d.map((x) => x.delta), [20, 13, 3, 3, -7, -13, -20]);
});
