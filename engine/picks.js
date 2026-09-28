import { valueOf, isJoker, compareCards } from './cards.js';
import { identify, beats } from './combos.js';
import { hints } from './hint.js';

const MAX_PICKS = 10;
const SUIT_SYMBOL = { S: '♠', H: '♥', C: '♣', D: '♦' };
const rankLabel = (id) => (isJoker(id) ? (id[0] === 'B' ? '大王' : '小王') : ({ T: '10' }[id[0]] ?? id[0]));

// Short Chinese name of a play, e.g. "对K", "顺子 3-7", "4炸 9", "三带一对 7带4".
export function comboLabel(combo) {
  const cards = [...combo.cards].sort(compareCards);
  const low = rankLabel(cards[0]);
  const high = rankLabel(cards.at(-1));
  switch (combo.type) {
    case 'single': return high;
    case 'pair': return `对${high}`;
    case 'triple': return `三张${high}`;
    case 'triple_pair': {
      const triple = cards.find((c) => valueOf(c) === combo.value);
      const pair = cards.find((c) => valueOf(c) !== combo.value);
      return `三带一对 ${rankLabel(triple)}带${rankLabel(pair)}`;
    }
    case 'straight': return `顺子 ${low}-${high}`;
    case 'pairs': return `连对 ${low}-${high}`;
    case 'x510k': return '杂510K';
    case 'p510k': return `纯510K ${SUIT_SYMBOL[cards[0][1]]}`;
    case 'bomb': return `${combo.length}炸 ${high}`;
    case 'joker_bomb': return '王炸';
    default: return '';
  }
}

// Put the tapped card into a candidate in place of a card of the same rank, if it holds one.
function withFocus(cards, focus) {
  if (cards.includes(focus)) return cards;
  const i = cards.findIndex((c) => valueOf(c) === valueOf(focus) && isJoker(c) === isJoker(focus));
  if (i < 0) return null;
  const next = [...cards];
  next[i] = focus;
  return next;
}

// Quick-pick chips: the hint list (plays that beat `top`, or leads), or, with a focus card,
// only plays that use that exact card. Returns [{ cards, combo }].
export function quickPicks(hand, top, decks, focus = null) {
  const options = hints(hand, top, decks);
  if (!focus) return options.slice(0, MAX_PICKS);
  const seen = new Set();
  const picks = [];
  for (const option of options) {
    const cards = withFocus(option.cards, focus);
    if (!cards) continue;
    const combo = identify(cards, decks);
    if (!combo || !beats(combo, top)) continue; // e.g. a pure 510K stops being pure with another suit's 5
    const key = [...cards].sort().join();
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push({ cards, combo });
    if (picks.length === MAX_PICKS) break;
  }
  return picks;
}
