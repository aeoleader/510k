import { hints } from './hint.js';

const SPECIAL_WORTH_POINTS = 10;
const OPPONENT_DANGER_CARDS = 5;

// Simple bot / auto-play policy shared by bots and disconnected players.
// ctx: { hand, top, topIsTeammate, trickPoints, opponentMinCards }
export function botAction({ hand, top, topIsTeammate = false, trickPoints = 0, opponentMinCards = Infinity }) {
  const options = hints(hand, top);
  if (!top) return { type: 'play', cards: options[0].cards };
  if (topIsTeammate) return { type: 'pass' };
  const normal = options.find((o) => o.combo.cat === 0);
  if (normal) return { type: 'play', cards: normal.cards };
  const worthIt = trickPoints >= SPECIAL_WORTH_POINTS || opponentMinCards <= OPPONENT_DANGER_CARDS;
  if (worthIt && options.length) return { type: 'play', cards: options[0].cards };
  return { type: 'pass' };
}
