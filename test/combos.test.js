import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identify, beats } from '../engine/combos.js';

const type = (cards) => identify(cards)?.type ?? null;
const win = (a, b) => beats(identify(a), identify(b));

test('identifies basic types', () => {
  assert.equal(type(['3S0']), 'single');
  assert.equal(type(['BJ0']), 'single');
  assert.equal(type(['4S0', '4S1']), 'pair');
  assert.equal(type(['4S0', '4H0', '4D1']), 'triple');
  assert.equal(type(['4S0', '4H0', '4D1', '9S0', '9H0']), 'triple_pair');
  assert.equal(type(['3S0', '4H0', '5D0', '6S0', '7C0']), 'straight');
  assert.equal(type(['3S0', '3H0', '4S0', '4H0', '5S0', '5D0']), 'pairs');
});

test('straights and pair runs stop at K', () => {
  assert.equal(type(['9S0', 'TH0', 'JD0', 'QS0', 'KC0']), 'straight');
  assert.equal(type(['TH0', 'JD0', 'QS0', 'KC0', 'AS0']), null);
  assert.equal(type(['JS0', 'JH0', 'QS0', 'QH0', 'KS0', 'KH0']), 'pairs');
  assert.equal(type(['QS0', 'QH0', 'KS0', 'KH0', 'AS0', 'AH0']), null);
  assert.equal(type(['3S0', '4H0', '5D0', '6S0']), null);
  assert.equal(type(['3S0', '3H0', '4S0', '4H0']), null);
});

test('no airplanes, no jokers mixed into normal combos', () => {
  assert.equal(type(['3S0', '3H0', '3D0', '4S0', '4H0', '4D0']), null);
  assert.equal(type(['3S0', '3H0', '3D0', '4S0', '4H0', '4D0', '7S0', '7H0', '8S0', '8H0']), null);
  assert.equal(type(['4S0', 'LJ0']), null);
});

test('510K: pure vs mixed', () => {
  assert.equal(type(['5S0', 'TS0', 'KS0']), 'p510k');
  assert.equal(type(['5S0', 'TS1', 'KH0']), 'x510k');
  assert.equal(identify(['5H0', 'TH0', 'KH0']).sub, 3);
});

test('bombs and joker bombs', () => {
  assert.equal(type(['7S0', '7H0', '7C0', '7D0']), 'bomb');
  assert.equal(identify(['7S0', '7H0', '7C0', '7D0', '7S1']).level, 5);

  assert.equal(type(['LJ0', 'LJ1']), 'pair');
  assert.ok(win(['BJ0', 'BJ1'], ['LJ0', 'LJ1']));
  assert.ok(win(['BJ0', 'BJ1'], ['2S0', '2H0']));

  assert.equal(identify(['LJ0', 'BJ0'], 2), null);

  const fourJokers = ['LJ0', 'LJ1', 'BJ0', 'BJ1'];
  const bomb8 = ['3S0', '3H0', '3C0', '3D0', '3S1', '3H1', '3C1', '3D1'];
  assert.equal(identify(fourJokers, 2).type, 'joker_bomb');
  assert.ok(beats(identify(fourJokers, 2), identify(bomb8)));
  assert.equal(identify(fourJokers, 3), null);

  assert.equal(identify(['LJ0', 'LJ1', 'LJ2'], 3).type, 'triple');

  const sixJokers = ['LJ0', 'LJ1', 'LJ2', 'BJ0', 'BJ1', 'BJ2'];
  const bomb12 = ['3S0', '3H0', '3C0', '3D0', '3S1', '3H1', '3C1', '3D1', '3S2', '3H2', '3C2', '3D2'];
  assert.equal(identify(sixJokers, 3).type, 'joker_bomb');
  assert.ok(beats(identify(sixJokers, 3), identify(bomb12, 3)));
});

test('normal combos only beat same type and length with higher value', () => {
  assert.ok(win(['4S0'], ['3S0']));
  assert.ok(!win(['3S0'], ['3H0']));
  assert.ok(!win(['4S0', '4H0'], ['3S0']));
  assert.ok(win(['2S0'], ['AS0']));
  assert.ok(win(['LJ0'], ['2S0']));
  assert.ok(win(['4S0', '5H0', '6D0', '7S0', '8C0'], ['3S0', '4H0', '5D0', '6S0', '7C0']));
  assert.ok(!win(['4S0', '5H0', '6D0', '7S0', '8C0'], ['3S0', '4H0', '5D0', '6S0', '7C0', '8H0']));
});

test('special ordering: x510k < p510k < 4-bomb < ... < 9-bomb < joker bomb', () => {
  const x = ['5S0', 'TS1', 'KH0'];
  const pD = ['5D0', 'TD0', 'KD0'];
  const pS = ['5S0', 'TS0', 'KS0'];
  const b4 = ['3S0', '3H0', '3C0', '3D0'];
  const b4big = ['AS0', 'AH0', 'AC0', 'AD0'];
  const b5 = ['3S0', '3H0', '3C0', '3D0', '3S1'];
  const b6 = ['2S0', '2H0', '2C0', '2D0', '2S1', '2H1'];
  const b7 = ['3S0', '3H0', '3C0', '3D0', '3S1', '3H1', '3C1'];
  const b9 = ['3S0', '3H0', '3C0', '3D0', '3S1', '3H1', '3C1', '3D1', '3S2'];
  const jokerBomb = ['LJ0', 'LJ1', 'BJ0', 'BJ1'];

  assert.ok(win(x, ['2S0', '2H0', '2D0', 'AS0', 'AH0']));
  assert.ok(win(x, ['9S0', 'TH0', 'JD0', 'QS0', 'KC0']));
  assert.ok(!win(x, ['5H0', 'TS0', 'KD0']), 'mixed 510K do not beat each other');
  assert.ok(win(pD, x));
  assert.ok(win(pS, pD));
  assert.ok(!win(pS, ['5S1', 'TS1', 'KS1']), 'same-suit pure 510K do not beat each other');
  assert.ok(win(b4, pS));
  assert.ok(win(b4big, b4));
  assert.ok(win(b5, b4big));
  assert.ok(win(b6, b5));
  assert.ok(win(b7, b6));
  assert.ok(win(jokerBomb, b9), 'a joker bomb outranks even a 9-bomb');
  assert.ok(!win(b9, jokerBomb));
});
