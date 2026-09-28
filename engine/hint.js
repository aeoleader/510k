import { valueOf, isJoker, compareCards, SUITS } from './cards.js';
import { identify, beats, compareStrength, MAX_RUN_VALUE } from './combos.js';

// Order in which a leader's options are offered: multi-card combos first.
const LEAD_ORDER = { straight: 0, pairs: 1, triples: 2, triple_pair: 3, single: 4, pair: 5, triple: 6 };

// Jokers group by value too (16 small, 17 big), so same-kind singles/pairs/triples
// of jokers come from the same generators as any other value.
function groupByValue(hand) {
  const groups = new Map();
  for (const c of [...hand].sort(compareCards)) {
    const v = valueOf(c);
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(c);
  }
  return groups;
}

const count510k = (count) => Math.min(count(5), count(10), count(13));

// [breaks a bomb, breaks a 510K, splits a group] — lower is better.
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
  const before = count510k((v) => groups.get(v)?.length ?? 0);
  const after = count510k((v) => (groups.get(v)?.length ?? 0) - (used.get(v) ?? 0));
  return [bomb, after < before ? 1 : 0, split];
}

const compareCost = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

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
      if (need >= 2) out.push(...bombFreeRuns(groups, start, len, minLen));
    }
  }
  return out.map((r) => {
    const [start, len] = Array.isArray(r) ? r : [r, exactLen];
    const cards = [];
    for (let v = start; v < start + len; v++) cards.push(...groups.get(v).slice(0, need));
    return cards;
  });
}

// Pieces of the run [start, start + len) that leave every bomb (4+ of a value) intact,
// e.g. 333 444 555 6666 also offers 333 444 555 as 连三.
function bombFreeRuns(groups, start, len, minLen) {
  const out = [];
  let from = start;
  for (let v = start; v <= start + len; v++) {
    if (v < start + len && groups.get(v).length < 4) continue;
    const piece = v - from;
    if (piece >= minLen && piece < len) out.push([from, piece]);
    from = v + 1;
  }
  return out;
}

function sameKind(groups, k) {
  return [...groups.values()].filter((g) => g.length >= k).map((g) => g.slice(0, k));
}

function triplePairs(groups) {
  const out = [];
  // Jokers never go into triple_pair: skip joker values (16/17) for both the triple and the pair.
  for (const [t, g] of groups) {
    if (t > 15 || g.length < 3) continue;
    const pair = [...groups]
      .filter(([v, p]) => v !== t && v <= 15 && p.length >= 2)
      .map(([, p]) => p.slice(0, 2))
      .sort((a, b) => compareCost(costOf(groups, a), costOf(groups, b)) || valueOf(a[0]) - valueOf(b[0]))[0];
    if (pair) out.push([...g.slice(0, 3), ...pair]);
  }
  return out;
}

function singles(groups) {
  return [...groups.values()].map((g) => [g[0]]);
}

function specials(groups, jokers, decks) {
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
  // Bombs are non-joker only (jokers never form a plain bomb); a joker bomb exists
  // only when the whole set of jokers is played together.
  for (const [v, g] of groups) {
    if (v > 15) continue;
    for (let k = 4; k <= g.length; k++) out.push(g.slice(0, k));
  }
  if (jokers.length === 2 * decks) out.push([...jokers]);
  return out;
}

// Legal plays for `hand` against `top` (null when leading), best recommendation first.
// Returns [{ cards, combo }].
export function hints(hand, top = null, decks = 2) {
  const groups = groupByValue(hand);
  const jokers = hand.filter(isJoker).sort(compareCards);
  let normal = [];
  if (!top) {
    normal = [
      ...runs(groups, 1, 5), ...runs(groups, 2, 3), ...runs(groups, 3, 3), ...triplePairs(groups),
      ...singles(groups), ...sameKind(groups, 2), ...sameKind(groups, 3),
    ];
  } else if (top.cat === 0) {
    const byType = {
      single: () => singles(groups),
      pair: () => sameKind(groups, 2),
      triple: () => sameKind(groups, 3),
      triple_pair: () => triplePairs(groups),
      straight: () => runs(groups, 1, top.length, top.length),
      pairs: () => runs(groups, 2, top.length / 2, top.length / 2),
      triples: () => runs(groups, 3, top.length / 3, top.length / 3),
    };
    normal = byType[top.type]();
  }

  const seen = new Set();
  const toCandidates = (list) => list.flatMap((cards) => {
    const key = [...cards].sort().join();
    if (seen.has(key)) return [];
    seen.add(key);
    const combo = identify(cards, decks);
    if (!combo || !beats(combo, top)) return [];
    return [{ cards, combo, cost: costOf(groups, cards) }];
  });

  const normals = toCandidates(normal).sort((a, b) =>
    a.cost[0] - b.cost[0]
    || a.cost[1] - b.cost[1]
    || (top ? 0 : LEAD_ORDER[a.combo.type] - LEAD_ORDER[b.combo.type])
    || a.cost[2] - b.cost[2]
    || a.combo.value - b.combo.value
    || b.combo.length - a.combo.length);
  // Specials order: 杂510K, 纯510K, bombs (weakest first), then joker bombs last.
  const isJokerBomb = (h) => h.combo.type === 'joker_bomb' ? 1 : 0;
  const special = toCandidates(specials(groups, jokers, decks)).sort((a, b) =>
    isJokerBomb(a) - isJokerBomb(b) || compareStrength(a.combo, b.combo));
  return [...normals, ...special].map(({ cards, combo }) => ({ cards, combo }));
}

export const smallestSingle = (hand) => [[...hand].sort(compareCards)[0]];
