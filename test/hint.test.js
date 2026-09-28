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

test('follow single: avoid breaking a 510K when another single works', () => {
  const list = hints(['5S0', '9D0', 'TS0', 'KH0'], identify(['4D0'])).map((h) => h.cards);
  assert.deepEqual(list[0], ['9D0']);
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
  // LJ0 and BJ0 are mixed jokers (decks 2, only 2 of the 4 jokers): not a joker bomb,
  // just two joker singles competing as normal singles.
  const hand = ['5S0', 'TS0', 'KS0', 'TH0', '3S0', '3H0', '3C0', '3D0', 'LJ0', 'BJ0'];
  const list = hints(hand, identify(['2D0']), 2);
  const types = list.map((h) => h.combo.type);
  assert.deepEqual(types.slice(0, 2), ['single', 'single']);
  const firstSpecial = types.findIndex((t) => t !== 'single');
  assert.deepEqual(types.slice(firstSpecial), ['x510k', 'p510k', 'bomb']);
});

test('specials: joker bombs always come after all normal bombs', () => {
  const hand = ['4S0', '4H0', '4C0', '4D0', '4S1', '4H1', '4C1', 'LJ0', 'LJ1', 'BJ0', 'BJ1'];
  const list = hints(hand, identify(['3S0', '3H0', '3C0', '3D0']), 2);
  const types = list.map((h) => h.combo.type);
  assert.deepEqual(types[types.length - 1], 'joker_bomb');
  const sevenBombIndex = list.findIndex((h) => h.combo.type === 'bomb' && h.combo.length === 7);
  assert.ok(sevenBombIndex >= 0, 'the 7-card 4-bomb is a candidate');
  assert.ok(sevenBombIndex < types.length - 1, '7-bomb comes before the joker bomb');
});

test('joker pair beats a pair of 2s when nothing smaller works', () => {
  const list = hints(['LJ0', 'LJ1', '3S0'], identify(['2S0', '2H0']), 2);
  assert.deepEqual(list[0].cards, ['LJ0', 'LJ1']);
});

test('jokers never go into triple_pair', () => {
  const list = hints(['LJ0', 'LJ1', 'LJ2', '4S0', '4H0'], null, 3);
  assert.ok(!list.some((h) => h.combo.type === 'triple_pair'));
});

test('nothing beats -> empty list', () => {
  assert.deepEqual(hints(['3S0', '4S0'], identify(['LJ0', 'LJ1', 'BJ0', 'BJ1']), 2), []);
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
  const hand = ['5S0', 'TS0', 'KS0', '4H0', '6H0', '8C0', '9D0'];
  assert.equal(botAction({ hand, top: null }).type, 'play');
  assert.deepEqual(botAction({ hand, top: identify(['3D0']), topIsTeammate: true }), { type: 'pass' });
  assert.deepEqual(botAction({ hand, top: identify(['3D0']) }), { type: 'play', cards: ['4H0'] });
  const top = identify(['2D0']);
  assert.deepEqual(botAction({ hand, top, trickPoints: 0 }), { type: 'pass' });
  assert.equal(identify(botAction({ hand, top, trickPoints: 20 }).cards).cat, 2);
});

test('follow 连三: a higher run of the same length, and leads offer it', () => {
  const hand = ['6S0', '6H0', '6D0', '7S0', '7H0', '7D0', '8S0', '8H0', '8C0', '3S0'];
  const top = identify(['5S1', '5H1', '5D1', '6S1', '6H1', '6D1', '7S1', '7H1', '7D1']);
  const list = cardsOf(hints(hand, top));
  assert.equal(identify(list[0]).type, 'triples');
  assert.equal(list[0].length, 9);
  assert.ok(hints(hand, null).some((h) => h.combo.type === 'triples'));
});

test('leading 连三 / 连对: also offers the run that keeps a bomb whole', () => {
  const t = (v) => [`${v}S0`, `${v}H0`, `${v}D0`];
  const hand = [...t('3'), ...t('4'), ...t('5'), ...t('6'), '6C0'];
  const list = hints(hand, null);
  const run35 = list.find((h) => h.combo.type === 'triples' && h.cards.length === 9);
  assert.ok(run35, '333 444 555 is offered');
  assert.ok(run35.cards.every((c) => c[0] !== '6'), 'the 6666 bomb stays whole');
  assert.ok(list.findIndex((h) => h === run35) < list.findIndex((h) => h.combo.type === 'triples' && h.cards.length === 12),
    'offered before the run that breaks the bomb');
  const pairs = hints(['3S0', '3H0', '4S0', '4H0', '5S0', '5H0', '6S0', '6H0', '6D0', '6C0'], null);
  assert.ok(pairs.some((h) => h.combo.type === 'pairs' && h.cards.length === 6 && h.cards.every((c) => c[0] !== '6')));
});
