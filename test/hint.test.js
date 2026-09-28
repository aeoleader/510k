import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hints, smallestSingle } from '../engine/hint.js';
import { botAction } from '../engine/bot.js';
import { identify } from '../engine/combos.js';

const cardsOf = (list) => list.map((h) => h.cards);

test('follow single: smallest that beats, not breaking pairs or bombs first', () => {
  const hand = ['4S0', '6S0', '6H0', '9S0', '9H0', '9C0', '9D0', 'QS0'];
  const list = cardsOf(hints(hand, identify(['5D0'])));
  assert.deepEqual(list[0], ['QS0'], 'lone Q before splitting the 6 pair');
  assert.deepEqual(list[1], ['6H0'], 'within a rank the lowest suit is used');
  assert.ok(list.findIndex((c) => c.length === 1 && c[0][0] === '9') > 1, 'breaking the 9 bomb comes last among singles');
});

test('follow pair / straight / pair run of the same length', () => {
  const hand = ['3S0', '4S0', '5S0', '6S0', '7S0', '8S0', '8H0', '9S0', '9H0', 'TS0', 'TH0'];
  assert.deepEqual(cardsOf(hints(hand, identify(['7D0', '7C0'])))[0], ['8H0', '8S0']);
  const straights = cardsOf(hints(hand, identify(['3D0', '4D0', '5D0', '6D0', '7D0'])));
  assert.deepEqual(straights[0].length, 5);
  assert.ok(straights.every((c) => c.length === 5 || identify(c).cat > 0));
  const pairRuns = cardsOf(hints(hand, identify(['5D0', '5C0', '6D0', '6C0', '7D0', '7C0'])));
  assert.deepEqual(pairRuns[0], ['8H0', '8S0', '9H0', '9S0', 'TH0', 'TS0']);
});

test('specials follow normals, weakest first', () => {
  const hand = ['5S0', 'TS0', 'KS0', 'TH0', '3S0', '3H0', '3C0', '3D0', 'LJ0', 'BJ0'];
  const list = hints(hand, identify(['2D0']));
  const types = list.map((h) => h.combo.type);
  assert.deepEqual(types.slice(0, 2), ['single', 'single']);
  const firstSpecial = types.findIndex((t) => t !== 'single');
  assert.deepEqual(types.slice(firstSpecial), ['x510k', 'p510k', 'bomb', 'joker_bomb']);
});

test('nothing beats -> empty list', () => {
  assert.deepEqual(hints(['3S0', '4S0'], identify(['LJ0', 'BJ0', 'BJ1'])), []);
});

test('leading prefers multi-card combos and every candidate is legal', () => {
  const hand = ['3S0', '4S0', '5S0', '6S0', '7S0', '9S0', '9H0', 'QS0'];
  const list = hints(hand, null);
  assert.equal(list[0].combo.type, 'straight');
  assert.ok(list.every((h) => identify(h.cards)));
  assert.deepEqual(hints(['BJ0'], null)[0].cards, ['BJ0']);
});

test('smallestSingle', () => {
  assert.deepEqual(smallestSingle(['KS0', '3D0', 'BJ0']), ['3D0']);
});

test('bot: leads the first hint, passes on teammate, saves specials for points', () => {
  const hand = ['5S0', 'TS0', 'KS0', '4H0'];
  assert.equal(botAction({ hand, top: null }).type, 'play');
  assert.deepEqual(botAction({ hand, top: identify(['3D0']), topIsTeammate: true }), { type: 'pass' });
  assert.deepEqual(botAction({ hand, top: identify(['3D0']) }), { type: 'play', cards: ['4H0'] });
  const top = identify(['2D0']);
  assert.deepEqual(botAction({ hand, top, trickPoints: 0 }), { type: 'pass' });
  assert.equal(identify(botAction({ hand, top, trickPoints: 20 }).cards).cat, 2);
});
