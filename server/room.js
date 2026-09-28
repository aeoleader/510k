import crypto from 'node:crypto';
import { defaultDecks, sumPoints, deal, MIN_PLAYERS, MAX_PLAYERS } from '../engine/cards.js';
import { createHandState, apply, ranking, GameError } from '../engine/game.js';
import { createMatch, prepareHand, completeReturns, recordHand, isMatchOver, handSeed, HANDS_PER_MATCH } from '../engine/match.js';
import { botAction } from '../engine/bot.js';
import { computeRatingDeltas } from '../engine/rating.js';
import { findHighlights } from '../engine/highlights.js';
import { counterView } from '../engine/counter.js';
import { smallestSingle } from '../engine/hint.js';
import { lowestCard } from '../engine/tribute.js';
import { displayOrder } from '../engine/sort.js';
import { HttpError } from './http.js';

export const DEFAULT_DELAYS = {
  turnMs: 15000, returnMs: 30000, botMs: 700, nextHandMs: 30000,
  tributeMs: 5000, returnRevealMs: 3000, dealRoundMs: 120, claimGraceMs: 3000,
  restoreGraceMs: 20000, // after a server restart, humans count as present this long so they can reconnect
  reclaimOfflineMs: 30000, // a guest seat that is only offline may be taken back by name after this long
};
// A bot holding the black 3 shows it this long after it was dealt to them.
const BOT_CLAIM_MIN_MS = 1000;
const BOT_CLAIM_MAX_MS = 2500;
const PHASES = ['lobby', 'dealing', 'tribute', 'returning', 'return_reveal', 'playing', 'hand_over', 'match_over'];
const PAUSABLE = ['dealing', 'tribute', 'returning', 'return_reveal', 'playing', 'hand_over'];
// From these phases on, returned cards are public.
const RETURNS_PUBLIC = ['return_reveal', 'playing', 'hand_over', 'match_over'];
const isBlackThree = (id) => id.startsWith('3S');
const LOG_LIMIT = 40;
const BOT_NAMES = ['小白', '阿福', '老K', '十点', '五哥', '炸弹王', '顺子', '对子'];

const randomToken = () => crypto.randomBytes(24).toString('hex');
const randomId = () => `p_${crypto.randomBytes(6).toString('hex')}`;

// One room: lobby, a 10-hand match, and the automatic actions (bots, timeouts, next hand).
// All game rules live in ../engine; this class only sequences them and guards who may act.
export class Room {
  // accountView(userId) -> public account or null; onMatchOver(room) persists a finished match.
  // Every piece of game state set here must also be written by toSnapshot() and read by fromSnapshot(),
  // so a room survives a server restart; only runtime wiring (callbacks, timers, online) is left out.
  constructor({
    code, delays = DEFAULT_DELAYS, timers = globalThis, now = Date.now, random = Math.random, onChange = () => {},
    accountView = () => null, onMatchOver = () => {}, counterFor = () => false,
  }) {
    this.code = code;
    this.delays = { ...DEFAULT_DELAYS, ...delays }; // callers may pass only some delays
    this.timers = timers;
    this.now = now;
    this.random = random; // bot claim times and the fallback leader; tests pass their own
    this.onChange = onChange;
    this.accountView = accountView;
    this.counterFor = counterFor; // userId -> whether an admin enabled the card counter for them
    this.playedCards = []; // every card played this hand, for card counters
    this.onMatchOver = onMatchOver;
    this.startedAt = null;
    this.ratingResult = null;
    this.handLog = []; // one entry per finished hand of the current match, for replays
    this.handRecord = null;
    this.matchId = null; // set once the finished match is stored
    this.players = [];
    this.hostId = null;
    this.decks = null; // null = default for the player count
    this.turnSeconds = null; // host's choice of time per turn; null = the server default, 0 = no limit
    this.dealMode = false; // host's choice: deal card by card and race to show the black 3
    // lobby | dealing | tribute | returning | return_reveal | playing | hand_over | match_over
    this.phase = 'lobby';
    this.dealing = null; // { order, startedAt, total, claimAt: { seat: ms }, ended } during `dealing`
    this.claimedBy = null; // seat that showed the black 3 this hand
    this.revealHands = null; // hands after every return, played from once `return_reveal` ends
    this.ready = new Set(); // seats ready for the next hand during `hand_over`
    this.paused = false;
    this.pausedAt = null;
    this.pausedRemaining = null; // ms left on the deadline when the host paused
    this.online = new Set();
    this.offlineSince = new Map(); // playerId -> when that human was last seen (not saved: a restore resets it)
    this.graceUntil = null; // set after a restore: until then offline humans are not played automatically
    this.graceTimer = null;
    this.match = null;
    this.prepared = null;
    this.returns = [];
    this.hand = null;
    this.actions = [];
    this.events = [];
    this.seatActions = {};
    this.lastTrick = null;
    this.result = null;
    this.deadline = null;
    this.deadlineSpan = null;
    this.timer = null;
    this.log = [];
    this.version = 0; // bumped on every change; lets clients tell stale views apart
    this.updatedAt = now();
  }

  // ---- players -------------------------------------------------------------

  // user: { id, username, rating } for a logged-in player, or null for a guest.
  addHuman(name, user = null) {
    this.requirePhase('lobby', 'in_progress');
    if (this.players.length >= MAX_PLAYERS) throw new HttpError(409, 'room_full');
    const player = { id: randomId(), token: randomToken(), name, isBot: false, userId: user?.id ?? null, leftEarly: false };
    this.players.push(player);
    this.offlineSince.set(player.id, this.now()); // until their stream connects
    if (!this.hostId) this.hostId = player.id;
    this.say(`${name} 加入了房间`);
    this.changed();
    return player;
  }

  addBot(byId) {
    this.requireHost(byId);
    this.requirePhase('lobby', 'in_progress');
    if (this.players.length >= MAX_PLAYERS) throw new HttpError(409, 'room_full');
    const used = new Set(this.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(`${n}(机器人)`)) ?? '机器人';
    const bot = { id: randomId(), token: null, name: `${name}(机器人)`, isBot: true, userId: null, leftEarly: false };
    this.players.push(bot);
    this.changed();
    return bot;
  }

  removePlayer(byId, playerId) {
    const target = this.players.find((p) => p.id === playerId);
    if (!target) throw new HttpError(404, 'no_player');
    if (byId !== playerId) this.requireHost(byId);
    if (this.phase !== 'match_over') this.requirePhase('lobby', 'in_progress');
    if (this.phase === 'match_over') {
      // Seats are fixed until the room goes back to the lobby; drop the player then.
      target.gone = true;
      this.online.delete(playerId);
      this.passHost(playerId);
      this.say(`${target.name} 离开了房间`);
      this.changed();
      return;
    }
    this.requirePhase('lobby', 'in_progress');
    this.players = this.players.filter((p) => p.id !== playerId);
    this.online.delete(playerId);
    if (this.hostId === playerId) this.hostId = this.players.find((p) => !p.isBot)?.id ?? null;
    if (!target.isBot) this.say(`${target.name} 离开了房间`);
    this.changed();
  }

  // Hand the host role to another human still in the game, preferring someone online.
  passHost(fromId) {
    if (this.hostId !== fromId) return;
    const candidates = this.players.filter((p) => !p.isBot && !p.leftEarly && !p.gone && p.id !== fromId);
    this.hostId = (candidates.find((p) => this.online.has(p.id)) ?? candidates[0])?.id ?? null;
  }

  // Seat order decides teams (alternating seats), so the host adjusts teams by swapping seats.
  swapSeats(byId, aId, bId) {
    this.requireHost(byId);
    this.requirePhase('lobby', 'in_progress');
    const a = this.players.findIndex((p) => p.id === aId);
    const b = this.players.findIndex((p) => p.id === bId);
    if (a < 0 || b < 0) throw new HttpError(404, 'no_player');
    if (a === b) return;
    [this.players[a], this.players[b]] = [this.players[b], this.players[a]];
    this.changed();
  }

  findByUser(userId) {
    return this.players.find((p) => p.userId !== null && p.userId === userId) ?? null;
  }

  // Leaving mid-match hands the seat to auto-play until the match ends (spec 3.3) and
  // counts as leaving early for the rating, unless the player comes back and reclaims the seat.
  markLeft(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player || player.leftEarly || this.phase === 'lobby' || this.phase === 'match_over') return;
    player.leftEarly = true;
    this.online.delete(playerId);
    this.passHost(playerId);
    this.say(`${player.name} 离开了牌桌，由机器人托管到本轮结束`);
    this.schedule();
    if (this.readyToAdvance()) return this.advanceAfterHand();
    this.changed();
  }

  // Someone takes back a seat on auto-play (托管). A fresh token logs the old device out;
  // the seat is no longer counted as left, so it is rated normally.
  // keepToken: the caller already holds this seat's token (rejoin after leaving), so nothing to log out.
  reclaim(playerId, { keepToken = false } = {}) {
    const player = this.players[this.seatOf(playerId)];
    if (!keepToken) player.token = randomToken();
    player.leftEarly = false;
    this.say(`${player.name} 回到了牌桌`);
    if (this.waitsOn(playerId)) this.schedule();
    this.changed();
    return player;
  }

  inMatch() {
    return this.phase !== 'lobby' && this.phase !== 'match_over';
  }

  findByToken(token) {
    return this.players.find((p) => p.token && p.token === token) ?? null;
  }

  // Humans who still belong to the room (not departed at the end of a match, not left mid-match).
  humanCount() {
    return this.players.filter((p) => !p.isBot && !p.gone && !p.leftEarly).length;
  }

  setOnline(playerId, isOnline) {
    const was = this.online.has(playerId);
    if (isOnline) this.online.add(playerId);
    else this.online.delete(playerId);
    if (was === isOnline) return;
    if (isOnline) this.offlineSince.delete(playerId);
    else this.offlineSince.set(playerId, this.now());
    if (this.waitsOn(playerId)) this.schedule();
    if (this.readyToAdvance()) return this.advanceAfterHand();
    this.changed();
  }

  // A seat someone else may take back by name: left the match, or offline for a while.
  reclaimable(player) {
    if (player.leftEarly) return true;
    if (this.online.has(player.id)) return false;
    return this.now() - (this.offlineSince.get(player.id) ?? this.now()) >= this.delays.reclaimOfflineMs;
  }

  // True when the pending automatic action depends on this player (their turn or their return).
  waitsOn(playerId) {
    const seat = this.players.findIndex((p) => p.id === playerId);
    if (this.phase === 'playing') return this.hand.turn === seat;
    if (this.phase === 'returning') return this.returns.some((r) => r.card === null && r.from === seat);
    return false;
  }

  setDecks(byId, decks) {
    this.requireHost(byId);
    this.requirePhase('lobby', 'in_progress');
    this.decks = decks;
    this.changed();
  }

  setDealMode(byId, on) {
    this.requireHost(byId);
    this.requirePhase('lobby', 'in_progress');
    this.dealMode = on;
    this.changed();
  }

  setTurnSeconds(byId, seconds) {
    this.requireHost(byId);
    this.requirePhase('lobby', 'in_progress');
    this.turnSeconds = seconds;
    this.changed();
  }

  turnMs() {
    return this.turnSeconds === null ? this.delays.turnMs : this.turnSeconds * 1000;
  }

  // 不计时: online humans are never timed out.
  noTimer() {
    return this.turnSeconds === 0;
  }

  effectiveDecks() {
    return this.decks ?? defaultDecks(Math.max(MIN_PLAYERS, this.players.length));
  }

  // ---- match flow ----------------------------------------------------------

  start(byId) {
    this.requireHost(byId);
    this.requirePhase('lobby', 'in_progress');
    if (this.players.length < MIN_PLAYERS) throw new HttpError(409, 'not_enough_players');
    this.startedAt = this.now();
    this.ratingResult = null;
    this.handLog = [];
    this.matchId = null;
    this.ratingsBefore = this.players.map((p) => (p.userId ? this.accountView(p.userId)?.rating ?? null : null));
    for (const p of this.players) p.leftEarly = false;
    this.paused = false;
    this.match = createMatch({
      playerCount: this.players.length,
      decks: this.effectiveDecks(),
      seed: crypto.randomInt(2 ** 32),
    });
    this.say(`开始新一轮：${this.players.length} 人，${this.match.decks} 副牌`);
    this.startHand();
  }

  restart(byId) {
    this.requireHost(byId);
    this.requirePhase('match_over', 'not_finished');
    this.clearTimer();
    this.players = this.players.filter((p) => !p.gone);
    for (const p of this.players) p.leftEarly = false;
    Object.assign(this, {
      phase: 'lobby', match: null, prepared: null, hand: null, result: null, returns: [], deadline: null, deadlineSpan: null,
      dealing: null, claimedBy: null, revealHands: null, ready: new Set(), paused: false,
    });
    this.changed();
  }

  nextHand(byId) {
    this.requireHost(byId);
    this.requirePhase('hand_over', 'not_finished');
    this.requireRunning();
    this.advanceAfterHand();
  }

  // hand_over: a player is done reviewing. The next hand starts once every online human is ready.
  markReady(playerId) {
    this.requirePhase('hand_over', 'not_hand_over');
    this.requireRunning();
    this.ready.add(this.activeSeatOf(playerId));
    if (this.readyToAdvance()) return this.advanceAfterHand();
    this.changed();
  }

  readyToAdvance() {
    if (this.phase !== 'hand_over' || this.paused) return false;
    const waiting = this.players.flatMap((p, seat) => (!p.isBot && !p.leftEarly && this.isPresent(p) ? [seat] : []));
    return waiting.length > 0 && waiting.every((seat) => this.ready.has(seat));
  }

  startHand() {
    Object.assign(this, {
      prepared: null, hand: null, result: null, lastTrick: null, seatActions: {}, returns: [],
      claimedBy: null, revealHands: null, ready: new Set(),
    });
    this.say(`第 ${this.match.handNo + 1} 局开始`);
    if (this.dealMode) this.startDealing();
    else {
      this.prepared = prepareHand(this.match);
      this.afterDeal();
    }
  }

  // ---- dealing (dealMode): cards are revealed one round at a time; first to show the black 3 leads.

  startDealing() {
    const { order } = deal({ playerCount: this.match.playerCount, decks: this.match.decks, seed: handSeed(this.match, this.match.handNo) });
    const startedAt = this.now();
    const claimAt = {};
    order.forEach((cards, seat) => {
      const i = cards.findIndex(isBlackThree);
      if (i < 0 || !this.players[seat].isBot) return; // offline humans do not claim
      const wait = BOT_CLAIM_MIN_MS + Math.floor(this.random() * (BOT_CLAIM_MAX_MS - BOT_CLAIM_MIN_MS + 1));
      claimAt[seat] = startedAt + (i + 1) * this.delays.dealRoundMs + wait;
    });
    this.dealing = { order, startedAt, total: order[0].length, claimAt, ended: false };
    this.phase = 'dealing';
    this.setDeadline(null);
    this.schedule();
    this.changed();
  }

  // Rounds revealed so far; frozen while paused.
  dealRounds() {
    const at = this.paused ? this.pausedAt : this.now();
    const rounds = Math.floor((at - this.dealing.startedAt) / this.delays.dealRoundMs);
    return Math.max(0, Math.min(this.dealing.total, rounds));
  }

  dealEndAt() {
    return this.dealing.startedAt + this.dealing.total * this.delays.dealRoundMs;
  }

  claimThree(playerId) {
    this.requirePhase('dealing', 'not_dealing');
    this.requireRunning();
    const seat = this.activeSeatOf(playerId);
    if (this.claimedBy !== null) throw new HttpError(409, 'already_claimed');
    if (!this.dealing.order[seat].slice(0, this.dealRounds()).some(isBlackThree)) throw new HttpError(409, 'no_black_three');
    this.claim(seat);
  }

  claim(seat) {
    this.claimedBy = seat;
    this.say(`${this.nameAt(seat)} 亮黑3！`);
    if (this.dealRounds() >= this.dealing.total) return this.finishDeal(seat);
    this.schedule();
    this.changed();
  }

  // Timer during `dealing`: bot claims, the end of the deal, then the claim grace.
  dealTick() {
    const d = this.dealing;
    const now = this.now();
    if (this.claimedBy === null) {
      const due = Object.entries(d.claimAt).filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1])[0];
      if (due) return this.claim(Number(due[0]));
    }
    if (now < this.dealEndAt()) {
      // Push every round so each player sees their cards arrive (and a black 3) as they are dealt.
      this.changed();
      return this.schedule();
    }
    if (this.claimedBy !== null) return this.finishDeal(this.claimedBy);
    if (!d.ended) {
      // Everything is dealt and nobody has shown the black 3 yet: a short grace to do it.
      d.ended = true;
      this.deadline = this.dealEndAt() + this.delays.claimGraceMs;
      this.deadlineSpan = this.delays.claimGraceMs;
      this.schedule();
      this.changed();
      return;
    }
    if (now < this.deadline) return this.schedule();
    const holders = d.order.flatMap((cards, seat) => (cards.some(isBlackThree) ? [seat] : []));
    const pool = holders.length ? holders : this.players.map((_, seat) => seat);
    const seat = pool[Math.floor(this.random() * pool.length)];
    this.say(`没人亮黑3，由 ${this.nameAt(seat)} 先出`);
    this.finishDeal(seat);
  }

  finishDeal(leader) {
    this.prepared = prepareHand(this.match, { leader });
    this.dealing = null;
    this.afterDeal();
  }

  // ---- tribute and returns -------------------------------------------------

  afterDeal() {
    const { tribute } = this.prepared;
    if (tribute.resisted) this.say('抗贡：本局免贡');
    for (const g of tribute.given) this.say(`${this.nameAt(g.from)} 向 ${this.nameAt(g.to)} 上贡`);
    this.returns = this.prepared.pendingReturns.map((r) => ({ ...r, card: null }));
    if (!tribute.given.length && !tribute.resisted) return this.beginPlay(this.prepared.hands);
    this.phase = 'tribute'; // everyone watches the tribute cards move, or sees 抗贡 announced
    this.setDeadline(this.delays.tributeMs);
    this.schedule();
    this.changed();
  }

  startReturns() {
    if (!this.returns.length) return this.beginPlay(this.prepared.hands); // 抗贡: nothing to return
    this.phase = 'returning';
    this.setDeadline(this.noTimer() ? null : this.delays.returnMs);
    this.schedule();
    this.changed();
  }

  submitReturn(playerId, card) {
    this.requirePhase('returning', 'not_returning');
    this.requireRunning();
    const seat = this.activeSeatOf(playerId);
    const pending = this.returns.find((r) => r.from === seat && r.card === null);
    if (!pending) throw new HttpError(409, 'nothing_to_return');
    if (!this.prepared.hands[seat].includes(card)) throw new HttpError(400, 'not_in_hand');
    pending.card = card;
    this.afterReturn();
  }

  afterReturn() {
    if (this.returns.some((r) => r.card === null)) {
      this.schedule();
      this.changed();
      return;
    }
    this.revealHands = completeReturns(this.prepared, this.returns.map(({ from, to, card }) => ({ from, to, card })));
    this.phase = 'return_reveal'; // returned cards become public
    this.setDeadline(this.delays.returnRevealMs);
    this.schedule();
    this.changed();
  }

  beginPlay(hands) {
    this.hand = createHandState({
      hands, teams: this.match.teams, leader: this.prepared.leader, decks: this.match.decks,
    });
    const { handNo, seed, leader, dealt, leftover, tribute } = this.prepared;
    this.handRecord = {
      handNo,
      seed,
      leader,
      tribute: {
        dealt, leftover, pairs: tribute.pairs, resisted: tribute.resisted, given: tribute.given,
        returns: this.returns.map(({ from, to, card }) => ({ from, to, card })),
        claimedBy: this.claimedBy,
      },
      initialHands: hands.map((h) => [...h]),
      actions: [],
      lastAt: this.now(),
    };
    this.actions = [];
    this.events = [];
    this.playedCards = [];
    this.phase = 'playing';
    this.schedule();
    this.changed();
  }

  play(playerId, cards) {
    this.requireRunning();
    this.act({ seat: this.activeSeatOf(playerId), type: 'play', cards });
  }

  pass(playerId) {
    this.requireRunning();
    this.act({ seat: this.activeSeatOf(playerId), type: 'pass' });
  }

  // A player who left mid-match stays on auto-play; their own actions are refused.
  activeSeatOf(playerId) {
    const seat = this.seatOf(playerId);
    if (this.players[seat].leftEarly) throw new HttpError(409, 'left_match');
    return seat;
  }

  // `auto` is only ever set here on the server (timeouts, bots, offline players).
  act(action) {
    this.requirePhase('playing', 'not_playing');
    // Played cards are stored and shown organised (三带一对 as 777 44); the combo is the same either way.
    if (action.type === 'play' && Array.isArray(action.cards)) action = { ...action, cards: displayOrder(action.cards) };
    let result;
    try {
      result = apply(this.hand, action);
    } catch (err) {
      if (err instanceof GameError) throw new HttpError(409, err.code);
      throw err;
    }
    this.hand = result.state;
    this.actions.push(action);
    const at = this.now();
    this.handRecord.actions.push({
      seat: action.seat, type: action.type, cards: action.cards ?? null, auto: Boolean(action.auto),
      combo: result.events.find((e) => e.type === 'play')?.combo.type ?? null, elapsedMs: at - this.handRecord.lastAt,
    });
    this.handRecord.lastAt = at;
    this.events.push(...result.events);
    for (const e of result.events) this.onEvent(e);
    if (this.hand.over) this.finishHand();
    else {
      this.schedule();
      this.changed();
    }
  }

  onEvent(e) {
    // `seq` (per hand) lets clients tell a new play or trick from one they have already animated.
    const id = `${this.match.handNo}:${e.seq}`;
    if (e.type === 'play') {
      this.playedCards.push(...e.cards);
      this.seatActions[e.seat] = { id, cards: e.cards, type: e.combo.type, level: e.combo.level, auto: e.auto };
    } else if (e.type === 'pass') this.seatActions[e.seat] = { id, pass: true, auto: e.auto };
    else if (e.type === 'trick') {
      this.lastTrick = { id, seat: e.seat, points: e.points };
      this.seatActions = {};
      if (e.points > 0) this.say(`${this.nameAt(e.seat)} 收下 ${e.points} 分`);
    } else if (e.type === 'finish') this.say(`${this.nameAt(e.seat)} 第 ${e.place} 个出完`);
  }

  finishHand() {
    const { match, result } = recordHand(this.match, {
      ranking: ranking(this.hand), finished: this.hand.finished, captured: this.hand.captured,
    });
    this.match = match;
    this.result = {
      handNo: match.handNo, ranking: ranking(this.hand), captured: this.hand.captured, ...result,
      remaining: this.hand.hands.map((h) => [...h]), // cards still held at the end, for the review
    };
    const { lastAt, ...record } = this.handRecord;
    this.handLog.push({
      ...record,
      result: { ranking: this.result.ranking, finished: this.hand.finished, captured: this.hand.captured,
        score: result.score, penalties: result.penalties, winner: result.winner, sweep: result.sweep },
      highlights: findHighlights({
        events: this.events, teams: this.match.teams, decks: this.match.decks,
        sweep: result.sweep, resisted: this.prepared.tribute.resisted,
      }),
    });
    if (result.sweep) this.say('完胜！');
    this.phase = isMatchOver(match) ? 'match_over' : 'hand_over';
    if (this.phase === 'match_over') {
      this.say('本轮结束');
      this.settleRatings();
    }
    this.setDeadline(this.phase === 'hand_over' ? this.delays.nextHandMs : null);
    this.schedule();
    this.changed();
  }

  settleRatings() {
    const deltas = computeRatingDeltas(this.match, this.players.map((p, seat) => ({
      seat,
      rated: p.userId !== null && this.ratingsBefore[seat] !== null,
      ratingBefore: this.ratingsBefore[seat],
      leftEarly: p.leftEarly,
    })));
    this.ratingResult = deltas.map(({ seat, delta }) => ({
      seat,
      before: this.ratingsBefore[seat],
      delta,
      after: delta === null ? null : this.ratingsBefore[seat] + delta,
    }));
    try {
      this.onMatchOver(this);
    } catch (err) {
      console.error('failed to record match', err);
    }
  }

  advanceAfterHand() {
    this.clearTimer();
    this.startHand();
  }

  // ---- pause (host only) ---------------------------------------------------

  // Freezes deadlines, timers and the deal clock; every player action gets 409 paused meanwhile.
  pause(byId) {
    this.requireHost(byId);
    if (!PAUSABLE.includes(this.phase)) throw new HttpError(409, 'cannot_pause');
    this.requireRunning();
    const now = this.now();
    this.paused = true;
    this.pausedAt = now;
    this.pausedRemaining = this.deadline === null ? null : Math.max(0, this.deadline - now);
    this.clearTimer();
    this.deadline = null; // deadlineSpan stays, so the countdown keeps its scale after resuming
    this.say('房主暂停了游戏');
    this.changed();
  }

  resume(byId) {
    this.requireHost(byId);
    if (!this.paused) throw new HttpError(409, 'not_paused');
    const now = this.now();
    if (this.dealing) {
      // Shift the deal clock so no card was revealed while paused.
      const shift = now - this.pausedAt;
      this.dealing.startedAt += shift;
      for (const seat of Object.keys(this.dealing.claimAt)) this.dealing.claimAt[seat] += shift;
    }
    if (this.pausedRemaining !== null) this.deadline = now + this.pausedRemaining;
    Object.assign(this, { paused: false, pausedAt: null, pausedRemaining: null });
    this.say('游戏继续');
    if (this.readyToAdvance()) return this.advanceAfterHand(); // everyone got ready while paused
    this.schedule(true);
    this.changed();
  }

  requireRunning() {
    if (this.paused) throw new HttpError(409, 'paused');
  }

  // ---- automatic actions ---------------------------------------------------

  isAutomatic(seat) {
    const p = this.players[seat];
    return p.isBot || p.leftEarly || !this.isPresent(p);
  }

  // Online, or offline during the reconnect grace after a restore.
  isPresent(p) {
    return this.online.has(p.id) || this.graceUntil !== null;
  }

  // `resumed`: keep the deadline restored by resume() instead of starting a fresh turn clock.
  schedule(resumed = false) {
    this.clearTimer();
    if (this.paused) return;
    const untilDeadline = () => Math.max(0, this.deadline - this.now());
    if (this.phase === 'dealing') {
      const rounds = this.dealRounds();
      const nextRound = rounds < this.dealing.total ? this.dealing.startedAt + (rounds + 1) * this.delays.dealRoundMs : Infinity;
      const next = Math.min(this.deadline ?? this.dealEndAt(), nextRound, ...(this.claimedBy === null ? Object.values(this.dealing.claimAt) : []));
      this.setTimer(Math.max(0, next - this.now()), () => this.dealTick());
    } else if (this.phase === 'tribute') {
      this.setTimer(untilDeadline(), () => this.startReturns());
    } else if (this.phase === 'returning') {
      const autoPending = this.returns.some((r) => r.card === null && this.isAutomatic(r.from));
      if (autoPending) this.setTimer(this.delays.botMs, () => this.autoReturns(false));
      else if (this.deadline !== null) this.setTimer(untilDeadline(), () => this.autoReturns(true));
    } else if (this.phase === 'return_reveal') {
      this.setTimer(untilDeadline(), () => this.beginPlay(this.revealHands));
    } else if (this.phase === 'playing') {
      const seat = this.hand.turn;
      if (this.isAutomatic(seat)) {
        this.setDeadline(null);
        this.setTimer(this.delays.botMs, () => this.autoPlay(seat, false));
      } else if (this.noTimer()) {
        this.setDeadline(null);
      } else {
        if (!resumed || this.deadline === null) {
          // Offline during the reconnect grace: the turn clock starts only once the grace is over.
          const graceLeft = this.online.has(this.players[seat].id) ? 0 : Math.max(0, (this.graceUntil ?? 0) - this.now());
          this.setDeadline(graceLeft + this.turnMs());
        }
        this.setTimer(untilDeadline(), () => this.autoPlay(seat, true));
      }
    } else if (this.phase === 'hand_over') {
      this.setTimer(untilDeadline(), () => this.advanceAfterHand());
    }
  }

  autoReturns(everyone) {
    if (this.phase !== 'returning') return;
    for (const r of this.returns) {
      if (r.card === null && (everyone || this.isAutomatic(r.from))) r.card = lowestCard(this.prepared.hands[r.from]);
    }
    this.afterReturn();
  }

  autoPlay(seat, timedOut) {
    if (this.phase !== 'playing' || this.hand.turn !== seat) return;
    const hand = this.hand.hands[seat];
    const trick = this.hand.trick;
    let choice;
    if (timedOut) {
      choice = trick ? { type: 'pass' } : { type: 'play', cards: smallestSingle(hand) };
    } else {
      const teams = this.match.teams;
      const side = (s) => (teams ? teams[s] : s);
      const opponents = this.hand.hands.filter((h, i) => h.length && side(i) !== side(seat));
      choice = botAction({
        hand,
        top: trick?.top ?? null,
        decks: this.match.decks,
        topIsTeammate: Boolean(teams && trick && trick.topSeat !== seat && side(trick.topSeat) === side(seat)),
        trickPoints: trick ? sumPoints(trick.cards) : 0,
        opponentMinCards: Math.min(...opponents.map((h) => h.length)),
      });
    }
    // `auto` marks a human seat played by the server (timeout, offline, left); bots just play.
    this.act({ seat, ...choice, auto: !this.players[seat].isBot });
  }

  setDeadline(ms) {
    this.deadline = ms === null ? null : this.now() + ms;
    this.deadlineSpan = ms;
  }

  setTimer(ms, fn) {
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      // A bug in one room must not take the whole process (and every other room) down.
      try {
        fn();
      } catch (err) {
        console.error(`room ${this.code}: automatic action failed`, err);
      }
    }, ms);
  }

  clearTimer() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  destroy() {
    this.clearTimer();
    if (this.graceTimer) this.timers.clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  // ---- save and restore across a server restart ------------------------------

  // Plain JSON-safe state. Clock values are relative (ms left, ms elapsed) so they survive the restart;
  // timers are never saved, fromSnapshot() schedules them again.
  toSnapshot() {
    const now = this.now();
    const ref = this.paused ? this.pausedAt : now; // the deal clock is frozen while paused
    const d = this.dealing;
    return structuredClone({
      format: 1,
      code: this.code,
      creatorIp: this.creatorIp ?? null,
      players: this.players,
      hostId: this.hostId,
      decks: this.decks,
      turnSeconds: this.turnSeconds,
      dealMode: this.dealMode,
      phase: this.phase,
      dealing: d && {
        order: d.order, total: d.total, ended: d.ended, elapsedMs: ref - d.startedAt,
        claimInMs: Object.fromEntries(Object.entries(d.claimAt).map(([seat, at]) => [seat, at - ref])),
      },
      claimedBy: this.claimedBy,
      revealHands: this.revealHands,
      ready: [...this.ready],
      paused: this.paused,
      pausedRemaining: this.pausedRemaining,
      match: this.match,
      prepared: this.prepared,
      returns: this.returns,
      hand: this.hand,
      actions: this.actions,
      events: this.events,
      playedCards: this.playedCards,
      seatActions: this.seatActions,
      lastTrick: this.lastTrick,
      result: this.result,
      deadlineInMs: this.deadline === null ? null : Math.max(0, this.deadline - now),
      deadlineSpan: this.deadlineSpan,
      log: this.log,
      handRecord: this.handRecord && { ...this.handRecord, lastAt: undefined, sinceLastMs: now - this.handRecord.lastAt },
      handLog: this.handLog,
      ratingsBefore: this.ratingsBefore ?? null,
      startedAt: this.startedAt,
      ratingResult: this.ratingResult,
      matchId: this.matchId,
      version: this.version,
    });
  }

  // deps: the same options as the constructor, minus `code`. Throws on a snapshot it cannot use.
  static fromSnapshot(data, deps = {}) {
    const s = structuredClone(data);
    if (s?.format !== 1 || typeof s.code !== 'string' || !Array.isArray(s.players) || !PHASES.includes(s.phase)) {
      throw new Error('bad_snapshot');
    }
    const room = new Room({ ...deps, code: s.code });
    const now = room.now();
    Object.assign(room, {
      creatorIp: s.creatorIp,
      players: s.players,
      hostId: s.hostId,
      decks: s.decks,
      turnSeconds: s.turnSeconds,
      dealMode: s.dealMode,
      phase: s.phase,
      claimedBy: s.claimedBy,
      revealHands: s.revealHands,
      ready: new Set(s.ready),
      paused: s.paused,
      pausedAt: s.paused ? now : null,
      pausedRemaining: s.pausedRemaining,
      match: s.match,
      prepared: s.prepared,
      returns: s.returns,
      hand: s.hand,
      actions: s.actions,
      events: s.events,
      playedCards: s.playedCards,
      seatActions: s.seatActions,
      lastTrick: s.lastTrick,
      result: s.result,
      deadline: s.deadlineInMs === null ? null : now + s.deadlineInMs,
      deadlineSpan: s.deadlineSpan,
      log: s.log,
      handLog: s.handLog,
      ratingsBefore: s.ratingsBefore,
      startedAt: s.startedAt,
      ratingResult: s.ratingResult,
      matchId: s.matchId,
      version: s.version,
    });
    if (s.dealing) {
      const { elapsedMs, claimInMs, ...rest } = s.dealing;
      room.dealing = {
        ...rest,
        startedAt: now - elapsedMs,
        claimAt: Object.fromEntries(Object.entries(claimInMs).map(([seat, ms]) => [seat, now + ms])),
      };
    }
    if (s.handRecord) {
      const { sinceLastMs, ...record } = s.handRecord;
      room.handRecord = { ...record, lastAt: now - sinceLastMs };
    }
    for (const p of room.players) if (!p.isBot) room.offlineSince.set(p.id, now); // nobody is connected yet
    for (const p of room.players) room.viewFor(p.id); // fails here, not later in a timer, if the state is unusable
    try {
      room.startGrace();
      room.schedule(true);
    } catch (err) {
      room.destroy();
      throw err;
    }
    room.changed();
    return room;
  }

  // Nobody is connected right after a restore: give humans time to reconnect before auto-playing for them.
  startGrace() {
    const grace = this.delays.restoreGraceMs;
    if (!grace || !this.players.some((p) => !p.isBot && !p.leftEarly && !p.gone)) return;
    this.graceUntil = this.now() + grace;
    // A human's pending turn or return keeps what was left of its clock, on top of the grace.
    const humanTurn = this.phase === 'playing' && !this.players[this.hand.turn].isBot && !this.players[this.hand.turn].leftEarly;
    const humanReturn = this.phase === 'returning'
      && this.returns.some((r) => r.card === null && !this.players[r.from].isBot && !this.players[r.from].leftEarly);
    if (!this.paused && (humanTurn || humanReturn) && !this.noTimer()) {
      const left = this.deadline === null ? (humanTurn ? this.turnMs() : this.delays.returnMs) : this.deadline - this.now();
      this.deadline = this.now() + left + grace;
      this.deadlineSpan = left + grace;
    }
    this.graceTimer = this.timers.setTimeout(() => {
      this.graceTimer = null;
      this.graceUntil = null;
      try {
        if (this.paused) return;
        if (this.readyToAdvance()) return this.advanceAfterHand();
        if (this.phase === 'playing' || this.phase === 'returning') {
          this.schedule(true);
          this.changed();
        }
      } catch (err) {
        console.error(`room ${this.code}: ending the reconnect grace failed`, err);
      }
    }, grace);
  }

  // ---- helpers -------------------------------------------------------------

  seatOf(playerId) {
    const seat = this.players.findIndex((p) => p.id === playerId);
    if (seat < 0) throw new HttpError(404, 'no_player');
    return seat;
  }

  nameAt(seat) {
    return this.players[seat]?.name ?? `座位${seat + 1}`;
  }

  requireHost(byId) {
    if (byId !== this.hostId) throw new HttpError(403, 'host_only');
  }

  requirePhase(phase, code) {
    if (this.phase !== phase) throw new HttpError(409, code);
  }

  say(text) {
    this.log.push({ at: this.now(), text });
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  changed() {
    this.version += 1;
    this.updatedAt = this.now();
    this.onChange(this);
  }

  // ---- per-viewer state ----------------------------------------------------

  viewFor(playerId) {
    const seat = this.players.findIndex((p) => p.id === playerId);
    const inHand = this.phase !== 'lobby' && Boolean(this.prepared || this.dealing);
    const rounds = this.phase === 'dealing' ? this.dealRounds() : null;
    const handCards = (s) => {
      // While dealing: only the cards revealed so far, in dealt order.
      if (this.phase === 'dealing') return this.dealing.order[s].slice(0, rounds);
      if (this.phase === 'tribute' || this.phase === 'returning') return this.prepared.hands[s];
      if (this.phase === 'return_reveal') return this.revealHands[s];
      if (this.hand) return this.hand.hands[s];
      return [];
    };
    const trick = this.phase === 'playing' && this.hand.trick
      ? { seat: this.hand.trick.topSeat, cards: this.hand.trick.top.cards, type: this.hand.trick.top.type, points: sumPoints(this.hand.trick.cards) }
      : null;
    const myReturn = this.phase === 'returning' ? this.returns.find((r) => r.from === seat && r.card === null) : null;
    return {
      code: this.code,
      version: this.version,
      phase: this.phase,
      hostId: this.hostId,
      serverNow: this.now(),
      decks: this.match?.decks ?? this.effectiveDecks(),
      decksChoice: this.decks,
      turnSeconds: Math.round(this.turnMs() / 1000),
      turnChoice: this.turnSeconds,
      dealMode: this.dealMode,
      paused: this.paused,
      pausedRemaining: this.pausedRemaining,
      dealRounds: rounds,
      dealTotalRounds: this.phase === 'dealing' ? this.dealing.total : null,
      dealStartedAt: this.phase === 'dealing' ? this.dealing.startedAt : null,
      dealRoundMs: this.phase === 'dealing' ? this.delays.dealRoundMs : null,
      claimedBy: this.claimedBy,
      ready: [...this.ready].sort((a, b) => a - b),
      teams: this.match?.teams ?? null,
      handNo: this.match ? Math.min(this.match.handNo + (this.phase === 'hand_over' || this.phase === 'match_over' ? 0 : 1), HANDS_PER_MATCH) : 0,
      handsPerMatch: HANDS_PER_MATCH,
      totals: this.match?.totals ?? null,
      heads: this.match?.heads ?? null,
      tails: this.match?.tails ?? null,
      sweeps: this.match?.sweeps ?? null,
      players: this.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        seat: i,
        isBot: p.isBot,
        online: p.isBot || this.online.has(p.id),
        cards: inHand ? handCards(i).length : null,
        place: this.hand ? this.hand.finished.indexOf(i) + 1 || null : null,
        captured: this.hand ? this.hand.captured[i] : 0,
        account: p.userId ? this.accountView(p.userId) : null,
        leftEarly: p.leftEarly,
      })),
      ratings: this.phase === 'match_over' ? this.ratingResult : null,
      matchId: this.phase === 'match_over' ? this.matchId : null,
      turn: this.phase === 'playing' ? this.hand.turn : -1,
      deadline: this.deadline,
      deadlineSpan: this.deadlineSpan,
      trick,
      seatActions: this.phase === 'playing' ? this.seatActions : {},
      lastTrick: this.lastTrick,
      tribute: this.prepared && this.phase !== 'lobby'
        ? {
          resisted: this.prepared.tribute.resisted,
          given: this.prepared.tribute.given,
          returns: this.returns.map((r) => ({
            from: r.from, to: r.to, done: r.card !== null,
            card: r.from === seat || r.to === seat || RETURNS_PUBLIC.includes(this.phase) ? r.card : null,
          })),
        }
        : null,
      result: this.result,
      log: this.log.slice(-12),
      you: seat < 0 ? null : {
        id: playerId,
        seat,
        isHost: playerId === this.hostId,
        account: this.players[seat].userId ? this.accountView(this.players[seat].userId) : null,
        hand: inHand ? handCards(seat) : [],
        mustReturnTo: myReturn ? myReturn.to : null,
        // Only the viewer's own view ever carries counter data, and only if an admin enabled it.
        counter: this.phase === 'playing' && this.players[seat].userId && this.counterFor(this.players[seat].userId)
          ? counterView({ decks: this.match.decks, ownHand: this.hand.hands[seat], played: this.playedCards })
          : null,
      },
    };
  }
}
