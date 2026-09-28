import crypto from 'node:crypto';
import { defaultDecks, sumPoints, MIN_PLAYERS, MAX_PLAYERS } from '../engine/cards.js';
import { createHandState, apply, ranking, GameError } from '../engine/game.js';
import { createMatch, prepareHand, completeReturns, recordHand, isMatchOver, HANDS_PER_MATCH } from '../engine/match.js';
import { botAction } from '../engine/bot.js';
import { computeRatingDeltas } from '../engine/rating.js';
import { smallestSingle } from '../engine/hint.js';
import { lowestCard } from '../engine/tribute.js';
import { HttpError } from './http.js';

export const DEFAULT_DELAYS = { turnMs: 15000, returnMs: 15000, botMs: 700, nextHandMs: 6000 };
const LOG_LIMIT = 40;
const BOT_NAMES = ['小白', '阿福', '老K', '十点', '五哥', '炸弹王', '顺子', '对子'];

const randomToken = () => crypto.randomBytes(24).toString('hex');
const randomId = () => `p_${crypto.randomBytes(6).toString('hex')}`;

// One room: lobby, a 10-hand match, and the automatic actions (bots, timeouts, next hand).
// All game rules live in ../engine; this class only sequences them and guards who may act.
export class Room {
  // accountView(userId) -> public account or null; onMatchOver(room) persists a finished match.
  constructor({
    code, delays = DEFAULT_DELAYS, timers = globalThis, now = Date.now, onChange = () => {},
    accountView = () => null, onMatchOver = () => {},
  }) {
    this.code = code;
    this.delays = delays;
    this.timers = timers;
    this.now = now;
    this.onChange = onChange;
    this.accountView = accountView;
    this.onMatchOver = onMatchOver;
    this.startedAt = null;
    this.ratingResult = null;
    this.players = [];
    this.hostId = null;
    this.decks = null; // null = default for the player count
    this.phase = 'lobby'; // lobby | returning | playing | hand_over | match_over
    this.online = new Set();
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

  findByUser(userId) {
    return this.players.find((p) => p.userId !== null && p.userId === userId) ?? null;
  }

  // Leaving mid-match hands the seat to auto-play until the match ends (spec 3.3) and
  // counts as leaving early for the rating. It cannot be undone by coming back.
  markLeft(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player || player.leftEarly || this.phase === 'lobby' || this.phase === 'match_over') return;
    player.leftEarly = true;
    this.online.delete(playerId);
    this.passHost(playerId);
    this.say(`${player.name} 离开了牌桌，由机器人托管到本轮结束`);
    this.schedule();
    this.changed();
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
    if (this.waitsOn(playerId)) this.schedule();
    this.changed();
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
    this.ratingsBefore = this.players.map((p) => (p.userId ? this.accountView(p.userId)?.rating ?? null : null));
    for (const p of this.players) p.leftEarly = false;
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
    Object.assign(this, { phase: 'lobby', match: null, prepared: null, hand: null, result: null, returns: [], deadline: null, deadlineSpan: null });
    this.changed();
  }

  nextHand(byId) {
    this.requireHost(byId);
    this.requirePhase('hand_over', 'not_finished');
    this.advanceAfterHand();
  }

  startHand() {
    this.prepared = prepareHand(this.match);
    this.result = null;
    this.lastTrick = null;
    this.seatActions = {};
    const { tribute, handNo } = this.prepared;
    this.say(`第 ${handNo + 1} 局开始`);
    if (tribute.resisted) this.say('抗贡：本局免贡');
    for (const g of tribute.given) this.say(`${this.nameAt(g.from)} 向 ${this.nameAt(g.to)} 上贡`);
    this.returns = this.prepared.pendingReturns.map((r) => ({ ...r, card: null }));
    if (this.returns.length) {
      this.phase = 'returning';
      this.setDeadline(this.delays.returnMs);
      this.schedule();
      this.changed();
    } else {
      this.beginPlay(this.prepared.hands);
    }
  }

  submitReturn(playerId, card) {
    this.requirePhase('returning', 'not_returning');
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
    const hands = completeReturns(this.prepared, this.returns.map(({ from, to, card }) => ({ from, to, card })));
    this.beginPlay(hands);
  }

  beginPlay(hands) {
    this.hand = createHandState({
      hands, teams: this.match.teams, leader: this.prepared.leader, decks: this.match.decks,
    });
    this.actions = [];
    this.events = [];
    this.phase = 'playing';
    this.schedule();
    this.changed();
  }

  play(playerId, cards) {
    this.act({ seat: this.activeSeatOf(playerId), type: 'play', cards });
  }

  pass(playerId) {
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
    let result;
    try {
      result = apply(this.hand, action);
    } catch (err) {
      if (err instanceof GameError) throw new HttpError(409, err.code);
      throw err;
    }
    this.hand = result.state;
    this.actions.push(action);
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
    this.result = { handNo: match.handNo, ranking: ranking(this.hand), captured: this.hand.captured, ...result };
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

  // ---- automatic actions ---------------------------------------------------

  isAutomatic(seat) {
    const p = this.players[seat];
    return p.isBot || p.leftEarly || !this.online.has(p.id);
  }

  schedule() {
    this.clearTimer();
    if (this.phase === 'returning') {
      const autoPending = this.returns.some((r) => r.card === null && this.isAutomatic(r.from));
      const ms = autoPending ? this.delays.botMs : Math.max(0, this.deadline - this.now());
      this.setTimer(ms, () => this.autoReturns(!autoPending));
    } else if (this.phase === 'playing') {
      const seat = this.hand.turn;
      if (this.isAutomatic(seat)) {
        this.setDeadline(null);
        this.setTimer(this.delays.botMs, () => this.autoPlay(seat, false));
      } else {
        this.setDeadline(this.delays.turnMs);
        this.setTimer(this.delays.turnMs, () => this.autoPlay(seat, true));
      }
    } else if (this.phase === 'hand_over') {
      this.setTimer(Math.max(0, this.deadline - this.now()), () => this.advanceAfterHand());
    }
  }

  autoReturns(everyone) {
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
    this.act({ seat, ...choice, auto: true });
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
    const inHand = this.phase !== 'lobby' && this.prepared;
    const handCards = (s) => {
      if (this.phase === 'returning') return this.prepared.hands[s];
      if (this.hand && this.prepared) return this.hand.hands[s];
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
            card: r.from === seat || r.to === seat ? r.card : null,
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
      },
    };
  }
}
