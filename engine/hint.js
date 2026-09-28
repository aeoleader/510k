import { valueOf, isJoker, compareCards, SUITS } from './cards.js';
import { identify, beats, compareStrength, MAX_RUN_VALUE } from './combos.js';

// Order in which a leader's options are offered: multi-card combos first.
const LEAD_ORDER = { straight: 0, pairs: 1, triple_pair: 2, single: 3, pair: 4, triple: 5 };

function groupByValue(hand) {
  const groups = new Map();
  for (const c of [...hand].sort(compareCards)) {
    if (isJoker(c)) continue;
    const v = valueOf(c);
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(c);
  }
  return groups;
}

// [breaks a bomb, splits a group] — lower is better.
function costOf(groups, cards) {
  const used = new Map();
  for (const c of cards) if (!isJoker(c)) used.set(valueOf(c), (used.get(valueOf(c)) || 0) + 1);
  let bomb = 0;
  let split = 0;
  for (const [v, k] of used) {
    const have = groups.get(v).length;
    if (have >= 4 && k < have) bomb += 1;
    else if (k < have) split += 1;
  }
  return [bomb, split];
}

function runs(groups, need, minLen, exactLen) {
  const out = [];
  const lengths = exactLen ? [exactLen] : null;
  for (let start = 3; start <= MAX_RUN_VALUE; start++) {
    let len = 0;
    while (start + len <= MAX_RUN_VALUE && (groups.get(start + len)?.length ?? 0) >= need) len++;
    if (len < minLen) continue;
    if (lengths) {
      if (len >= exactLen) out.push(start);
    } else if ((groups.get(start - 1)?.length ?? 0) < need) {
      out.push([start, len]); // maximal run starting here
    }
  }
  return out.map((r) => {
    const [start, len] = Array.isArray(r) ? r : [r, exactLen];
    const cards = [];
    for (let v = start; v < start + len; v++) cards.push(...groups.get(v).slice(0, need));
    return cards;
  });
}

function sameKind(groups, k) {
  return [...groups.values()].filter((g) => g.length >= k).map((g) => g.slice(0, k));
}

function triplePairs(groups) {
  const out = [];
  for (const [t, g] of groups) {
    if (g.length < 3) continue;
    const pair = [...groups]
      .filter(([v, p]) => v !== t && p.length >= 2)
      .map(([, p]) => p.slice(0, 2))
      .sort((a, b) => costOf(groups, a)[0] - costOf(groups, b)[0] || costOf(groups, a)[1] - costOf(groups, b)[1] || valueOf(a[0]) - valueOf(b[0]))[0];
    if (pair) out.push([...g.slice(0, 3), ...pair]);
  }
  return out;
}

function singles(groups, jokers) {
  const out = [...groups.values()].map((g) => [g[0]]);
  const small = jokers.find((c) => c[0] === 'L');
  const big = jokers.find((c) => c[0] === 'B');
  if (small) out.push([small]);
  if (big) out.push([big]);
  return out;
}

function specials(groups, jokers) {
  const out = [];
  const fives = groups.get(5) ?? [];
  const tens = groups.get(10) ?? [];
  const kings = groups.get(13) ?? [];
  const mixed = fives.flatMap((f) => tens.flatMap((t) => kings.map((k) => [f, t, k])))
    .find((cards) => new Set(cards.map((c) => c[1])).size > 1);
  if (mixed) out.push(mixed);
  for (const suit of SUITS) {
    const f = fives.find((c) => c[1] === suit);
    const t = tens.find((c) => c[1] === suit);
    const k = kings.find((c) => c[1] === suit);
    if (f && t && k) out.push([f, t, k]);
  }
  for (const g of groups.values()) for (let k = 4; k <= g.length; k++) out.push(g.slice(0, k));
  for (let k = 2; k <= jokers.length; k++) out.push(jokers.slice(0, k));
  return out;
}

// Legal plays for `hand` against `top` (null when leading), best recommendation first.
// Returns [{ cards, combo }].
export function hints(hand, top = null) {
  const groups = groupByValue(hand);
  const jokers = hand.filter(isJoker).sort(compareCards);
  let normal = [];
  if (!top) {
    normal = [
      ...runs(groups, 1, 5), ...runs(groups, 2, 3), ...triplePairs(groups),
      ...singles(groups, jokers), ...sameKind(groups, 2), ...sameKind(groups, 3),
    ];
  } else if (top.cat === 0) {
    const byType = {
      single: () => singles(groups, jokers),
      pair: () => sameKind(groups, 2),
      triple: () => sameKind(groups, 3),
      triple_pair: () => triplePairs(groups),
      straight: () => runs(groups, 1, top.length, top.length),
      pairs: () => runs(groups, 2, top.length / 2, top.length / 2),
    };
    normal = byType[top.type]();
  }

  const seen = new Set();
  const toCandidates = (list) => list.flatMap((cards) => {
    const key = [...cards].sort().join();
    if (seen.has(key)) return [];
    seen.add(key);
    const combo = identify(cards);
    if (!combo || !beats(combo, top)) return [];
    return [{ cards, combo, cost: costOf(groups, cards) }];
  });

  const normals = toCandidates(normal).sort((a, b) =>
    a.cost[0] - b.cost[0]
    || (top ? 0 : LEAD_ORDER[a.combo.type] - LEAD_ORDER[b.combo.type])
    || a.cost[1] - b.cost[1]
    || a.combo.value - b.combo.value
    || b.combo.length - a.combo.length);
  const special = toCandidates(specials(groups, jokers)).sort((a, b) => compareStrength(a.combo, b.combo));
  return [...normals, ...special].map(({ cards, combo }) => ({ cards, combo }));
}

export const smallestSingle = (hand) => [[...hand].sort(compareCards)[0]];
