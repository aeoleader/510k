import { valueOf, isJoker, SUIT_ORDER } from './cards.js';

// Straights and pair runs may not go past K.
export const MAX_RUN_VALUE = 13;

// A joker bomb's level: a finite number (states stay JSON-safe) that outranks any 4n bomb.
export const JOKER_BOMB_LEVEL = 100;

// Every combo: { type, cards, length, cat, value, level, sub }
// cat: 0 normal, 1 mixed 510K, 2 pure 510K, 3 bomb (incl. joker bombs).
// level: bomb strength (card count; jokers count 3 each). sub: suit rank for pure 510K, 1 for joker bombs.
function make(type, cards, cat, value = 0, level = 0, sub = 0) {
  return { type, cards: [...cards], length: cards.length, cat, value, level, sub };
}

function countByValue(cards) {
  const counts = new Map();
  for (const c of cards) counts.set(valueOf(c), (counts.get(valueOf(c)) || 0) + 1);
  return counts;
}

const isConsecutive = (values) => values.every((v, i) => i === 0 || v === values[i - 1] + 1);

// A joker bomb exists only when all 2*decks jokers of the game are played together.
// Otherwise jokers are normal cards of value 16 (small, 'L') / 17 (big, 'B'): a same-kind
// single/pair/triple is a normal combo. Mixed small+big jokers, or 4+ same-kind jokers
// that aren't the full set, are invalid.
export function identify(cards, decks = 2) {
  const n = cards.length;
  if (n === 0) return null;
  const jokers = cards.filter(isJoker).length;
  if (jokers === n) {
    if (n === 2 * decks) return make('joker_bomb', cards, 3, 0, JOKER_BOMB_LEVEL, 1);
    const ranks = new Set(cards.map((c) => c[0]));
    if (ranks.size === 1 && n <= 3) {
      const value = valueOf(cards[0]);
      if (n === 1) return make('single', cards, 0, value);
      if (n === 2) return make('pair', cards, 0, value);
      return make('triple', cards, 0, value);
    }
    return null;
  }
  if (jokers > 0) return null;

  const counts = countByValue(cards);
  const values = [...counts.keys()].sort((a, b) => a - b);
  const top = values[values.length - 1];

  if (n === 3 && values.length === 3 && values[0] === 5 && values[1] === 10 && values[2] === 13) {
    const suits = new Set(cards.map((c) => c[1]));
    if (suits.size === 1) return make('p510k', cards, 2, 0, 0, SUIT_ORDER[cards[0][1]]);
    return make('x510k', cards, 1);
  }
  if (values.length === 1) {
    if (n === 1) return make('single', cards, 0, top);
    if (n === 2) return make('pair', cards, 0, top);
    if (n === 3) return make('triple', cards, 0, top);
    return make('bomb', cards, 3, top, n);
  }
  if (n === 5 && values.length === 2) {
    const [a, b] = values;
    if (counts.get(a) === 3 && counts.get(b) === 2) return make('triple_pair', cards, 0, a);
    if (counts.get(b) === 3 && counts.get(a) === 2) return make('triple_pair', cards, 0, b);
  }
  if (top <= MAX_RUN_VALUE && isConsecutive(values)) {
    if (n >= 5 && values.length === n) return make('straight', cards, 0, top);
    if (n >= 6 && values.length * 2 === n && values.every((v) => counts.get(v) === 2)) {
      return make('pairs', cards, 0, top);
    }
  }
  return null;
}

// True when combo `a` may be played on top of combo `b` (b null = leading).
export function beats(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.cat !== b.cat) return a.cat > b.cat;
  if (a.cat === 0) return a.type === b.type && a.length === b.length && a.value > b.value;
  if (a.cat === 1) return false;
  if (a.cat === 2) return a.sub > b.sub;
  if (a.level !== b.level) return a.level > b.level;
  if (a.sub !== b.sub) return a.sub > b.sub;
  return a.value > b.value;
}

// Total order for sorting candidates weakest-first.
export function compareStrength(a, b) {
  return a.cat - b.cat || a.level - b.level || a.sub - b.sub || a.value - b.value || a.length - b.length;
}
