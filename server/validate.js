import { HttpError } from './http.js';
import { MIN_DECKS, MAX_DECKS } from '../engine/cards.js';

// Untrusted input from clients is checked here before it reaches the engine.
const CARD_ID = /^(?:[3-9TJQKA2][SHCD]|[LB]J)[0-3]$/;
const ROOM_CODE = /^[A-Z0-9]{4}$/;
const MAX_NAME_LENGTH = 12;
const MAX_CARDS_PER_PLAY = 60;

export function parseCards(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CARDS_PER_PLAY) {
    throw new HttpError(400, 'bad_cards');
  }
  if (!value.every((c) => typeof c === 'string' && CARD_ID.test(c)) || new Set(value).size !== value.length) {
    throw new HttpError(400, 'bad_cards');
  }
  return [...value];
}

export function parseCard(value) {
  return parseCards([value])[0];
}

// NFKC-normalise and drop control / format characters (zero-width, bidi overrides) from names.
export const cleanText = (value) => (typeof value === 'string' ? value.normalize('NFKC').replace(/\p{C}/gu, '').trim() : '');

export function parseName(value) {
  const name = cleanText(value);
  if (!name || [...name].length > MAX_NAME_LENGTH) throw new HttpError(400, 'bad_name');
  return name;
}

export function parseCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!ROOM_CODE.test(code)) throw new HttpError(400, 'bad_code');
  return code;
}

export function parseDecks(value) {
  if (value === null) return null; // null = default for the player count
  if (!Number.isInteger(value) || value < MIN_DECKS || value > MAX_DECKS) throw new HttpError(400, 'bad_decks');
  return value;
}

export const TURN_SECONDS_CHOICES = [0, 10, 15, 20, 30, 45, 60]; // 0 = 不计时 (no limit)

export function parseTurnSeconds(value) {
  if (value === null) return null; // null = server default
  if (!TURN_SECONDS_CHOICES.includes(value)) throw new HttpError(400, 'bad_turn_time');
  return value;
}

export function parseDealMode(value) {
  if (typeof value !== 'boolean') throw new HttpError(400, 'bad_deal_mode');
  return value;
}

export function parseBalanceDeal(value) {
  if (typeof value !== 'boolean') throw new HttpError(400, 'bad_balance_deal');
  return value;
}

export const parseToken = (value) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{48}$/.test(value)) throw new HttpError(401, 'bad_token');
  return value;
};

// Match-history pagination cursor: the id of the last match seen, or absent/null for the first page.
export function parseBeforeId(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, 'bad_before');
  return value;
}

export const MATCH_OUTCOMES = ['win', 'loss', 'draw'];

export function parseOutcomeFilter(value) {
  if (value === undefined || value === null) return null;
  if (!MATCH_OUTCOMES.includes(value)) throw new HttpError(400, 'bad_outcome');
  return value;
}
