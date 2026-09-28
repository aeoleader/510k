import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickPicks, comboLabel } from '../engine/picks.js';
import { identify } from '../engine/combos.js';

const labels = (picks) => picks.map((p) => comboLabel(p.combo));

test('without a focus card: the plays that beat the top, best first', () => {
  const hand = ['4S0', '6S0', '6H0', 'KS0', 'KH0', 'QS0'];
  const picks = quickPicks(hand, identify(['5D0', '5C0']), 2);
  assert.deepEqual(labels(picks), ['对6', '对K']);
});

test('with a focus card: only plays containing that exact card', () => {
  const hand = ['3S0', '4H0', '5D0', '6C0', '7S0', '7H0', '7D0', '4S0', '4C0'];
  const picks = quickPicks(hand, null, 2, '7H0');
  assert.ok(picks.length > 0);
  assert.ok(picks.every((p) => p.cards.includes('7H0')), 'the tapped 7 is used, not another 7');
  const l = labels(picks);
  assert.ok(l.includes('顺子 3-7'));
  assert.ok(l.includes('7'));
  assert.ok(l.includes('对7'));
  assert.ok(l.includes('三张7'));
  assert.ok(l.includes('三带一对 7带4'));
});

test('with a focus card and a top to beat: only legal plays containing it', () => {
  const hand = ['9S0', '9H0', '9D0', '9C0', 'JS0', '3D0'];
  const picks = quickPicks(hand, identify(['8S0', '8H0']), 2, '9H0');
  assert.deepEqual(labels(picks), ['对9', '4炸 9']);
  assert.ok(picks.every((p) => p.cards.includes('9H0')));
  assert.deepEqual(quickPicks(hand, identify(['8S0', '8H0']), 2, '3D0'), [], 'nothing with the 3 beats a pair of 8s');
});

test('a pure 510K keeps its suit when the focus card is from another suit', () => {
  const hand = ['5S0', 'TS0', 'KS0', '5H0'];
  const picks = quickPicks(hand, identify(['AS0', 'AH0', 'AD0', '2S0', '2H0']), 2, '5H0');
  assert.deepEqual(labels(picks), ['杂510K']);
  assert.ok(picks[0].cards.includes('5H0'));
});

test('labels for every combo type', () => {
  assert.equal(comboLabel(identify(['BJ0'])), '大王');
  assert.equal(comboLabel(identify(['LJ0', 'LJ1'])), '对小王');
  assert.equal(comboLabel(identify(['TS0', 'TH0', 'TD0'])), '三张10');
  assert.equal(comboLabel(identify(['JS0', 'JH0', 'QS0', 'QH0', 'KS0', 'KH0'])), '连对 J-K');
  assert.equal(comboLabel(identify(['5S0', 'TS0', 'KS0'])), '纯510K ♠');
  assert.equal(comboLabel(identify(['3S0', '3H0', '3C0', '3D0', '3S1'])), '5炸 3');
  assert.equal(comboLabel(identify(['LJ0', 'LJ1', 'BJ0', 'BJ1'], 2)), '王炸');
});
