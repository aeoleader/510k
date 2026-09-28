// Card ids are "<rank><suit><deck>": rank 3-9,T,J,Q,K,A,2 or L/B for jokers,
// suit S/H/C/D (J for jokers), deck is the 0-based deck index. e.g. "TS0", "BJ1".

export const RANKS = ['3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A', '2'];
export const SUITS = ['S', 'H', 'C', 'D'];
export const SUIT_ORDER = { S: 4, H: 3, C: 2, D: 1, J: 0 };

const RANK_VALUE = { L: 16, B: 17 };
RANKS.forEach((r, i) => { RANK_VALUE[r] = i + 3; });

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 8;
export const MIN_DECKS = 2;
export const MAX_DECKS = 4;

export const valueOf = (id) => RANK_VALUE[id[0]];
export const isJoker = (id) => id[1] === 'J';
export const deckOf = (id) => Number(id.slice(2));

export function pointsOf(id) {
  const r = id[0];
  if (r === '5') return 5;
  if (r === 'T' || r === 'K') return 10;
  return 0;
}

export const sumPoints = (cards) => cards.reduce((sum, c) => sum + pointsOf(c), 0);

// Ascending: value, then suit, then deck.
export function compareCards(a, b) {
  return valueOf(a) - valueOf(b) || SUIT_ORDER[a[1]] - SUIT_ORDER[b[1]] || deckOf(a) - deckOf(b);
}

export function buildDeck(decks) {
  const cards = [];
  for (let d = 0; d < decks; d++) {
    for (const r of RANKS) for (const s of SUITS) cards.push(`${r}${s}${d}`);
    cards.push(`LJ${d}`, `BJ${d}`);
  }
  return cards;
}

// mulberry32: small, fast, deterministic; the seed itself comes from crypto on the server.
export function createRng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(cards, rng) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const defaultDecks = (playerCount) => (playerCount >= 7 ? 3 : 2);

// Even player counts play two teams on alternating seats; odd counts play free-for-all (null).
export function teamsFor(playerCount) {
  if (playerCount % 2 !== 0) return null;
  return Array.from({ length: playerCount }, (_, i) => i % 2);
}

export function deal({ playerCount, decks, seed }) {
  if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    throw new Error(`playerCount must be ${MIN_PLAYERS}-${MAX_PLAYERS}`);
  }
  if (!Number.isInteger(decks) || decks < MIN_DECKS || decks > MAX_DECKS) {
    throw new Error(`decks must be ${MIN_DECKS}-${MAX_DECKS}`);
  }
  const cards = shuffle(buildDeck(decks), createRng(seed));
  const per = Math.floor(cards.length / playerCount);
  const hands = Array.from({ length: playerCount }, (_, i) =>
    cards.slice(i * per, (i + 1) * per).sort(compareCards));
  return { hands, leftover: cards.slice(per * playerCount).sort(compareCards) };
}
