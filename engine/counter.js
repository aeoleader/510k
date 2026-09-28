import { buildDeck, pointsOf, RANKS } from './cards.js';

// Card-counter panel data: everything not in `ownHand` and not yet `played`.
export function counterView({ decks, ownHand, played }) {
  const seen = new Set([...ownHand, ...played]);
  const remaining = Object.fromEntries([...RANKS, 'L', 'B'].map((r) => [r, 0]));
  let points = 0;
  for (const c of buildDeck(decks)) {
    if (seen.has(c)) continue;
    remaining[c[0]] += 1;
    points += pointsOf(c);
  }
  return {
    remaining,
    points,
    fives: remaining['5'],
    tens: remaining.T,
    kings: remaining.K,
    jokers: remaining.L + remaining.B,
  };
}
