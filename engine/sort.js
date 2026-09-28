import { compareCards, valueOf, isJoker, SUITS } from './cards.js';

// Big to small: jokers, 2, A, ... 3; within a rank S, H, C, D.
export const sortBySize = (hand) => [...hand].sort(compareCards).reverse();

// Pull out pure 510Ks (by suit S>H>C>D), then mixed 510Ks; the rest sorted big to small.
// Returns { groups: string[][], rest: string[] }.
export function sortBy510k(hand) {
  let rest = [...hand];
  const groups = [];
  const takeGroup = (pick) => {
    for (;;) {
      const f = rest.find((c) => c[0] === '5' && pick(c));
      const t = rest.find((c) => c[0] === 'T' && pick(c));
      const k = rest.find((c) => c[0] === 'K' && pick(c));
      if (!(f && t && k)) return;
      groups.push([f, t, k]);
      rest = rest.filter((c) => c !== f && c !== t && c !== k);
    }
  };
  for (const suit of SUITS) takeGroup((c) => c[1] === suit);
  takeGroup(() => true); // any pure triple is already gone, so these are mixed
  return { groups, rest: sortBySize(rest) };
}

// Values (3..15) held 4 or more times — shown with a bomb badge.
export function bombValues(hand) {
  const counts = new Map();
  for (const c of hand) if (!isJoker(c)) counts.set(valueOf(c), (counts.get(valueOf(c)) || 0) + 1);
  return new Set([...counts].filter(([, n]) => n >= 4).map(([v]) => v));
}

// How a played combo is laid out on the table: bigger groups first, then low to high,
// e.g. 三带一对 as 777 44, a straight or 510K ascending.
export function displayOrder(cards) {
  const counts = new Map();
  for (const c of cards) counts.set(valueOf(c), (counts.get(valueOf(c)) || 0) + 1);
  return [...cards].sort((a, b) => counts.get(valueOf(b)) - counts.get(valueOf(a)) || compareCards(a, b));
}
