import { hints } from '/engine/hint.js';
import { identify, beats } from '/engine/combos.js';
import { sortBySize, sortBy510k, bombValues } from '/engine/sort.js';
import { valueOf, isJoker } from '/engine/cards.js';
import {
  TYPE_LABEL, esc, initial, shortName, cardHtml as baseCardHtml, badgeHtml, fanHtml,
} from '/ui.js';
import { Effects } from '/effects.js';
import { quickPicks, comboLabel } from '/engine/picks.js';

const ERROR_TEXT = {
  bad_name: '请输入 1 到 12 个字的昵称', bad_code: '房间码是 4 位', no_room: '房间不存在', room_full: '房间已满',
  in_progress: '对局进行中，无法加入', not_enough_players: '至少需要 4 名玩家', host_only: '只有房主可以操作',
  not_your_turn: '还没轮到你', must_lead: '首家必须出牌', invalid_combo: '不是有效牌型', too_small: '压不过上家',
  not_in_hand: '手里没有这些牌', bad_cards: '请先选牌', nothing_to_return: '无需还贡', bad_token: '登录已失效，请重新加入',
  bad_username: '用户名为 1 到 12 个字，不能有空格', bad_password: '请输入密码', username_taken: '用户名已被注册',
  bad_login: '用户名或密码错误', session_expired: '登录已失效，请重新登录', accounts_disabled: '服务器未开启账号功能',
  short_password: '密码至少 6 位', too_many_attempts: '操作太频繁，请稍后再试', too_many_rooms: '你开的房间太多了，先关掉一些',
  server_busy: '服务器繁忙，请稍后再试', bad_turn_time: '不支持这个时长', left_match: '你已离开本轮，由机器人托管到本轮结束',
  bad_deal_mode: '发牌模式设置无效', not_dealing: '发牌已经结束', paused: '房主已暂停，请稍候', already_claimed: '已经有人亮了黑3',
  no_black_three: '你还没拿到黑桃 3', not_hand_over: '本局还没结束', cannot_pause: '现在不能暂停', not_paused: '游戏没有暂停',
  name_in_use: '这个名字正在牌桌上使用中',
};
const SEAT_TAKEN_TEXT = '你的座位已在其他设备上重新加入';
const PAUSABLE = ['dealing', 'tribute', 'returning', 'return_reveal', 'playing', 'hand_over'];
const TRIBUTE_PHASES = ['tribute', 'returning', 'return_reveal'];
const isBlackThree = (id) => id.startsWith('3S');
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MAX_SEATS = 8;

const $ = (id) => document.getElementById(id);
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;
const LANDSCAPE_MAX_HEIGHT = 500; // phones held sideways; tablets keep the normal layout
const LANDSCAPE_ARC_EXTRA = 0.14; // fraction of pi the landscape seat arc extends below the middle on each side

const isLandscape = () => document.documentElement.classList.contains('landscape');

// The size the app lays out in: when the page is rotated into landscape, width and height swap.
function viewport() {
  const rotated = document.documentElement.classList.contains('rotated');
  return rotated ? { w: window.innerHeight, h: window.innerWidth } : { w: window.innerWidth, h: window.innerHeight };
}

const state = {
  code: null,
  token: null,
  view: null,
  clockOffset: 0,
  selected: new Set(),
  sortMode: readPref('sortMode', 'size'),
  hintKey: null,
  hintList: [],
  hintIndex: -1,
  events: null,
  online: true,
  rejoining: false, // rejoining with a stored token while the server is unreachable
  accountToken: readPref('accountToken', null),
  account: null,
  entryMode: readPref('entryMode', 'guest'),
  invite: null, // room code from an invite link we have not joined yet
  focusCard: null, // last card the player tapped to select; quick picks show plays using it
  swapPick: null, // host's first pick when swapping two seats in the lobby
  picks: [],
  fxSeen: new Set(), // play / trick / head ids already animated
  fxPrimed: false, // false until the first table render, so a reload does not replay old plays
  counterOpen: readPref('counterOpen', window.innerWidth >= 820 ? '1' : '0') === '1',
  forceLandscape: readPref('forceLandscape', '0') === '1',
  dealDrawn: null, // { key, rounds, cards } last dealing progress drawn, so the deal loop redraws only on change
  flip: null, // card positions before the post-deal sort, for the FLIP animation
  reviewKey: null, // hand + phase the review collapse state belongs to
  reviewCollapsed: false,
  playLogOpen: false,
  sound: readPref('sound', '1') === '1',
  returnChimed: null, // hand number the return prompt already chimed for
  urgentSecs: null, // last countdown second a warning tick sounded for
};

const BIG_TRICK_POINTS = 30;
const fx = new Effects($('fx'), document.querySelector('.felt-wrap'));

function readPref(key, fallback) {
  try { return localStorage.getItem(`510k:${key}`) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try {
    if (value === null) localStorage.removeItem(`510k:${key}`);
    else localStorage.setItem(`510k:${key}`, value);
  } catch { /* storage unavailable */ }
}
function readSession(key) {
  try { return sessionStorage.getItem(`510k:${key}`); } catch { return null; }
}
function writeSession(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(`510k:${key}`);
    else sessionStorage.setItem(`510k:${key}`, value);
  } catch { /* storage unavailable */ }
}

// ---- network ----------------------------------------------------------------

async function api(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: state.code, token: state.token, accountToken: state.accountToken ?? undefined, ...body }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(payload.error || 'error'), { code: payload.error, status: res.status });
  return payload;
}

// A definitive "no" from the server (the token or room is not valid), as opposed to a network error,
// a 5xx from a proxy while the server restarts, or rate limiting: those are worth retrying.
const definitive = (err) => err.status >= 400 && err.status < 500 && err.status !== 429;
// Reconnect backoff: 1 s, 2 s, 4 s, then every 5 s.
const backoff = (attempt) => Math.min(5000, 1000 * 2 ** attempt);

async function run(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.code === 'session_expired') setAccount(null, null);
    // Our room token stopped working: someone took the seat back on another device.
    if (err.code === 'bad_token' && state.code) {
      seatTaken();
      return;
    }
    // No answer, or a 5xx while the server restarts: stay in the room and keep the selection.
    if (!err.status || err.status >= 500) {
      toast('网络不稳定，请重试');
      return;
    }
    toast(ERROR_TEXT[err.code] || '网络错误，请重试');
  }
}

// Drop the dead room token and go back to the join screen, keeping the room code ready to rejoin.
function seatTaken() {
  const code = state.code;
  leaveRoomLocally();
  state.invite = code;
  $('codeInput').value = code;
  renderEntry();
  toast(SEAT_TAKEN_TEXT);
}

function setAccount(token, account) {
  state.accountToken = token;
  state.account = account;
  writePref('accountToken', token);
  renderEntry();
  renderAccountChip();
}

function toast(text, kind = 'error') {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('ok', kind === 'ok');
  el.hidden = false;
  clearTimeout(toast.timer);
  // Long enough to read at a relaxed pace: at least 4 seconds, longer for longer messages.
  toast.timer = setTimeout(() => { el.hidden = true; }, Math.max(4000, text.length * 300));
}

const inviteLink = (code) => `${location.origin}/?room=${code}`;

// The async clipboard API needs HTTPS; over plain HTTP fall back to a hidden textarea + execCommand.
async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through */ }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

async function copyInvite() {
  if (!state.code) return;
  if (await copyText(inviteLink(state.code))) {
    toast('邀请链接已复制，发给朋友点开就能加入', 'ok');
    return;
  }
  // Last resort: select the visible link so the player can copy it by hand.
  const link = document.querySelector('.invite-link');
  if (link) window.getSelection().selectAllChildren(link);
  toast('复制失败，请长按链接手动复制');
}

function enterRoom({ code, token }) {
  state.code = code;
  state.token = token;
  state.invite = null;
  writeSession(`token:${code}`, token);
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.replaceState(null, '', url);
  openEvents();
}

// The event stream was refused (not just dropped). Leave only on a definitive answer; while the server is
// unreachable or restarting, keep the token and keep retrying with backoff.
async function recoverRoom(es, attempt = 0) {
  if (state.events !== es) return;
  const midMatch = state.view && state.view.phase !== 'lobby' && state.view.phase !== 'match_over';
  try {
    enterRoom(await api('/api/rooms/join', { code: state.code, token: state.token }));
  } catch (err) {
    if (state.events !== es) return;
    if (!definitive(err)) {
      setTimeout(() => recoverRoom(es, attempt + 1), backoff(attempt));
      return;
    }
    // Mid-match nobody is removed, so a rejected token there means the seat was taken back elsewhere.
    if (err.code === 'bad_token' || (midMatch && err.code !== 'no_room')) {
      seatTaken();
      return;
    }
    leaveRoomLocally();
    toast('房间已关闭或你已被移出');
  }
}

function leaveRoomLocally() {
  if (state.events) state.events.close();
  writeSession(`token:${state.code}`, null);
  Object.assign(state, { code: null, token: null, view: null, events: null, fxPrimed: false });
  state.fxSeen.clear();
  state.selected.clear();
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  render();
}

function openEvents() {
  if (state.events) state.events.close();
  const es = new EventSource(`/api/events?room=${state.code}&token=${state.token}`);
  state.events = es;
  es.onopen = () => { state.online = true; renderConnection(); };
  es.onerror = () => {
    state.online = false;
    renderConnection();
    // The browser gives up for good on 401/404 (room gone after a restart, or we were removed).
    if (es.readyState === EventSource.CLOSED) recoverRoom(es);
  };
  es.onmessage = (msg) => {
    const view = JSON.parse(msg.data);
    if (state.view && view.code === state.view.code && view.version < state.view.version) return;
    state.clockOffset = view.serverNow - Date.now();
    // The deal just ended: remember where each card sat so the hand can slide into sorted order.
    if (state.view?.phase === 'dealing' && view.phase !== 'dealing') state.flip = captureHand();
    const hand = new Set(view.you?.hand ?? []);
    for (const c of [...state.selected]) if (!hand.has(c)) state.selected.delete(c);
    state.view = view;
    render();
  };
}

// ---- derived state -------------------------------------------------------------

const playerAt = (seat) => state.view.players[seat];
const teamOf = (seat) => (state.view.teams ? state.view.teams[seat] : null);
const teamColor = (seat) => (teamOf(seat) === null ? '' : `--team-color: var(--team-${teamOf(seat)});`);

// Null when nothing is timed (不计时, or no deadline); while paused the countdown stays frozen.
function timeLeft() {
  const v = state.view;
  if (!v) return null;
  let ms;
  if (v.paused) {
    if (v.pausedRemaining === null || v.pausedRemaining === undefined) return null;
    ms = v.pausedRemaining;
  } else {
    if (!v.deadline) return null;
    ms = Math.max(0, v.deadline - (Date.now() + state.clockOffset));
  }
  return { secs: Math.ceil(ms / 1000), fraction: v.deadlineSpan ? Math.min(1, ms / v.deadlineSpan) : 0 };
}

// Dealing progress, run locally from the deal clock between pushes. The hand only ever shows cards the
// server already sent, so `cards` can lag `rounds` until the next push.
function dealProgress(v) {
  let rounds = v.dealRounds || 0;
  if (!v.paused && v.dealStartedAt !== null && v.dealRoundMs) {
    rounds = Math.max(rounds, Math.floor((Date.now() + state.clockOffset - v.dealStartedAt) / v.dealRoundMs));
  }
  rounds = Math.max(0, Math.min(v.dealTotalRounds || 0, rounds));
  const known = v.you ? v.you.hand.length : 0;
  return { rounds, cards: Math.min(known, rounds) };
}

function currentTop() {
  const t = state.view?.trick;
  return t ? identify(t.cards, state.view.decks) : null;
}

function currentHints() {
  const v = state.view;
  const key = `${v.you.hand.join()}|${v.trick ? v.trick.cards.join() : ''}`;
  if (key !== state.hintKey) {
    state.hintKey = key;
    state.hintIndex = -1;
    state.hintList = hints(v.you.hand, currentTop(), v.decks);
  }
  return state.hintList;
}

// ---- markup helpers ------------------------------------------------------------------




const cardHtml = (id, opts = {}) => baseCardHtml(id, { ...opts, selected: state.selected.has(id) });

function avatarHtml(p, sizeVar = '') {
  return `<span class="avatar ${p.isBot ? 'bot' : ''}" style="${teamColor(p.seat)}${sizeVar}">${esc(initial(p.name))}</span>`;
}

// ---- rendering -------------------------------------------------------------------------

function render() {
  const v = state.view;
  const inRoom = Boolean(state.code);
  $('entryView').hidden = inRoom;
  $('lobbyView').hidden = !v || v.phase !== 'lobby';
  $('tableView').hidden = !v || v.phase === 'lobby';
  $('roomBadge').hidden = !inRoom;
  $('roomBadge').textContent = state.code ?? '';
  renderConnection();
  renderAccountChip();
  renderPauseButton(v);
  if (!inRoom) renderEntry();
  if (!v) {
    $('scoreboard').hidden = true;
    $('overlay').hidden = true;
    return;
  }
  // A new hand or phase opens the review expanded again.
  const reviewKey = `${v.handNo}:${v.phase}`;
  if (state.reviewKey !== reviewKey) {
    state.reviewKey = reviewKey;
    state.reviewCollapsed = false;
  }
  if (v.phase === 'lobby') {
    $('scoreboard').hidden = true;
    renderLobby(v);
  } else {
    renderScoreboard(v);
    renderTable(v);
  }
  renderOverlay(v);
  tick();
}

function renderPauseButton(v) {
  const show = Boolean(v && v.you?.isHost && !v.paused && PAUSABLE.includes(v.phase));
  $('pauseBtn').hidden = !show;
  // Narrow phones drop the wordmark to make room for the button.
  document.querySelector('.topbar').classList.toggle('with-pause', show);
}

function renderAccountChip() {
  const chip = $('accountChip');
  chip.hidden = !state.account;
  if (state.account) {
    chip.innerHTML = `<a class="chip-link" href="/u/${encodeURIComponent(state.account.username)}" target="_blank" rel="noopener" title="我的战绩"><span class="chip-name">${esc(state.account.username)}</span>${badgeHtml(state.account, { compact: true })}</a>`;
  }
}

function renderEntry() {
  // Opened from an invite link: say so, and make joining (not creating) the main action.
  const invite = state.invite;
  $('inviteBanner').hidden = !invite;
  if (invite) $('inviteBanner').innerHTML = `你被邀请加入房间 <b>${esc(invite)}</b>${state.account ? '' : '，填个昵称就能进'}`;
  $('joinBtn').className = `btn ${invite ? 'btn-primary' : ''}`;
  $('createBtn').className = `btn btn-block ${invite ? 'btn-ghost' : 'btn-primary'}`;
  $('joinBtn').textContent = invite ? `加入 ${invite}` : '加入';
  const panel = $('accountPanel');
  if (state.account) {
    panel.innerHTML = `
      <div class="signed-in">
        <div><div class="field">已登录</div><div class="signed-name">${esc(state.account.username)}</div></div>
        ${badgeHtml(state.account)}
        <a class="btn btn-sm push-right" href="/u/${encodeURIComponent(state.account.username)}">我的主页</a>
        <button type="button" id="logoutBtn" class="btn btn-ghost btn-sm">退出</button>
      </div>`;
    return;
  }
  const guest = state.entryMode !== 'account';
  panel.innerHTML = `
    <span class="segmented entry-tabs" role="group" aria-label="入座方式">
      <button type="button" data-entry="guest" aria-pressed="${guest}">游客</button>
      <button type="button" data-entry="account" aria-pressed="${!guest}">账号登录</button>
    </span>
    ${guest ? `
      <label class="field" for="nameInput">昵称</label>
      <input id="nameInput" maxlength="12" autocomplete="nickname" value="${esc(readPref('name', ''))}">
      <p class="hint">游客不计段位。登录后每轮结束会结算段位分。</p>` : `
      <label class="field" for="usernameInput">用户名</label>
      <input id="usernameInput" maxlength="12" autocomplete="username">
      <label class="field" for="passwordInput">密码</label>
      <input id="passwordInput" type="password" maxlength="64" autocomplete="current-password">
      <div class="auth-row">
        <button type="button" id="loginBtn" class="btn">登录</button>
        <button type="button" id="registerBtn" class="btn btn-ghost">注册新账号</button>
      </div>
      <p class="hint">玩过另一款牌局游戏的账号可以直接用原密码登录。</p>`}`;
}

function renderConnection() {
  $('connection').hidden = !state.rejoining && (!state.code || state.online);
}

function renderLobby(v) {
  const isHost = v.you?.isHost;
  if (!isHost || !v.players.some((p) => p.id === state.swapPick)) state.swapPick = null;
  const count = v.players.length;
  const teams = count % 2 === 0 && count >= 4;
  const slots = [];
  for (let i = 0; i < MAX_SEATS; i++) {
    const p = v.players[i];
    if (!p) {
      slots.push(`<div class="seat-slot empty">${i < 4 && count < 4 ? '等待玩家' : '空位'}</div>`);
      continue;
    }
    const team = teams ? `--team-color: var(--team-${i % 2});` : '';
    const tags = [
      p.id === v.hostId ? '房主' : null,
      p.id === v.you?.id ? '你' : null,
      p.isBot ? '机器人' : null,
      !p.isBot && !p.online ? '离线' : null,
    ].filter(Boolean).join('，');
    const swappable = isHost && count > 1;
    const picked = state.swapPick === p.id;
    slots.push(`
      <div class="seat-slot ${teams ? 'teamed' : ''} ${swappable ? 'swappable' : ''} ${picked ? 'picked' : ''}" style="${team}"
        ${swappable ? `data-swap="${p.id}" role="button" tabindex="0" aria-pressed="${picked}" aria-label="${esc(p.name)}，点击后再点另一位交换座位"` : ''}>
        <div class="who"><span class="avatar ${p.isBot ? 'bot' : ''}" style="${team}">${esc(initial(p.name))}</span><span class="name">${esc(p.name.replace(/\(机器人\)$/, ''))}</span></div>
        <div class="meta">${i + 1} 号位${teams ? `，${i % 2 === 0 ? '蓝队' : '红队'}` : ''}${tags ? `，${tags}` : ''}</div>
        ${p.account ? `<div>${badgeHtml(p.account, { compact: true })}</div>` : ''}
        ${isHost && p.id !== v.you.id ? `<button class="btn btn-ghost btn-sm remove" data-remove="${p.id}">移出</button>` : ''}
      </div>`);
  }
  const perPlayer = count ? Math.floor((54 * v.decks) / count) : 0;
  const left = count ? (54 * v.decks) % count : 0;
  const deckOptions = [null, 2, 3, 4].map((d) => {
    const label = d === null ? `默认 ${count >= 7 ? 3 : 2} 副` : `${d} 副`;
    return `<option value="${d ?? ''}" ${v.decksChoice === d ? 'selected' : ''}>${label}</option>`;
  }).join('');
  const mode = count < 4 ? '还差 ' + (4 - count) + ' 人开局' : teams ? `${count / 2} 对 ${count / 2} 隔位组队` : '各自为战';
  $('lobbyView').innerHTML = `
    <div class="lobby-head">
      <div>
        <h2>房间码，发给朋友即可加入</h2>
        <div class="lobby-code">${esc(v.code)}</div>
      </div>
      <div class="head-actions">
        <button type="button" class="btn btn-primary btn-sm head-copy" data-action="copy-link">复制邀请链接</button>
        <a class="btn" href="/rules.html" target="_blank" rel="noopener">规则</a>
        <button id="leaveBtn" class="btn btn-danger">离开房间</button>
      </div>
    </div>
    <div class="invite-row">
      <span class="invite-link">${esc(inviteLink(v.code))}</span>
      <button id="copyLinkBtn" type="button" class="btn btn-primary btn-sm">复制邀请链接</button>
    </div>
    <div class="seat-grid">${slots.join('')}</div>
    ${isHost && count > 1 ? `<p class="swap-hint">${state.swapPick ? '再点另一位玩家，和他交换座位' : `点两位玩家交换座位${teams ? '，换座就是换队' : ''}`}</p>` : ''}
    <div class="lobby-controls">
      <label class="decks">副数
        <select id="decksSelect" ${isHost ? '' : 'disabled'}>${deckOptions}</select>
      </label>
      <label class="decks">出牌限时
        <select id="turnSelect" ${isHost ? '' : 'disabled'}>${[...(v.turnChoice === null ? [null] : []), 0, 10, 15, 20, 30, 45, 60].map((sec) => `
          <option value="${sec ?? ''}" ${v.turnChoice === sec ? 'selected' : ''}>${sec === null ? `默认 ${v.turnChoice === null ? v.turnSeconds : 15} 秒` : sec === 0 ? '不计时' : `${sec} 秒`}</option>`).join('')}
        </select>
      </label>
      <span class="decks deal-mode">
        <span id="dealModeLabel">发牌模式</span>
        <button type="button" id="dealModeBtn" class="switch" role="switch" aria-checked="${v.dealMode}" aria-labelledby="dealModeLabel"
          title="${isHost ? '每局一张张发牌，先亮黑桃 3 的人先出' : '只有房主可以更改'}" ${isHost ? '' : 'disabled'}><span class="knob"></span></button>
        <span class="deal-state">${v.dealMode ? '开' : '关'}</span>
      </span>
      <span class="note">${mode}${count >= 4 ? `，每人 ${perPlayer} 张${left ? `，余 ${left} 张给首家` : ''}` : ''}</span>
      <span class="spacer"></span>
      ${isHost ? `<button id="addBotBtn" class="btn" ${count >= MAX_SEATS ? 'disabled' : ''}>加机器人</button>` : ''}
      ${isHost ? `<button id="startBtn" class="btn btn-primary" ${count < 4 ? 'disabled' : ''}>开始 10 局</button>` : '<span class="note">等待房主开局</span>'}
    </div>`;
}

function renderScoreboard(v) {
  const sb = $('scoreboard');
  sb.hidden = false;
  const dots = Array.from({ length: v.handsPerMatch }, (_, i) => {
    const n = i + 1;
    const cls = n < v.handNo || (n === v.handNo && (v.phase === 'hand_over' || v.phase === 'match_over')) ? 'done' : n === v.handNo ? 'now' : '';
    return `<i class="${cls}"></i>`;
  }).join('');
  // Totals cover finished hands; while a hand is being played, the points captured so far show as "本局 +N".
  const live = v.phase === 'playing';
  const handPts = (seats) => seats.reduce((sum, seat) => sum + (v.players[seat].captured ?? 0), 0);
  const handTag = (pts) => (live ? `<span class="hand-pts" title="本局已收分，未计罚分"><span class="long">本局 </span>+${pts}</span>` : '');
  let scores = '';
  if (v.totals && v.teams) {
    scores = [0, 1].map((team) => {
      const members = v.players.filter((p) => v.teams[p.seat] === team);
      const names = members.map((p) => p.name.replace(/\(机器人\)$/, '')).join('、');
      return `<span class="team-score" style="--team-color: var(--team-${team})"><span class="num">${v.totals[team]}</span>${handTag(handPts(members.map((p) => p.seat)))}<span class="who">${esc(names)}</span></span>`;
    }).join('');
  } else if (v.totals) {
    const leader = v.players.reduce((a, b) => (v.totals[b.seat] > v.totals[a.seat] ? b : a));
    const mine = v.you ? v.you.seat : null;
    scores = `<span class="team-score" style="--team-color: var(--accent)"><span class="num">${mine === null ? 0 : v.totals[mine]}</span>${mine === null ? '' : handTag(handPts([mine]))}<span class="who">我的累计</span></span>
      <span class="team-score" style="--team-color: var(--muted)"><span class="num">${v.totals[leader.seat]}</span><span class="who">领先 ${esc(leader.name.replace(/\(机器人\)$/, ''))}</span></span>`;
  }
  sb.innerHTML = `<span class="hand-label"><span class="long">第 </span>${v.handNo} / ${v.handsPerMatch}<span class="long"> 局</span></span><span class="hand-progress" aria-hidden="true">${dots}</span>${scores}`;
}

// Portrait: everyone around the table, me at the bottom. Landscape: my seat moves into the dock,
// and the others spread clockwise from the left edge, over the top, to the right edge.
function seatAngle(seat, v) {
  const n = v.players.length;
  const rel = (seat - (v.you?.seat ?? 0) + n) % n;
  if (isLandscape() && rel > 0) {
    // The arc reaches a little below the middle on both sides so side seats do not stack up.
    const spread = LANDSCAPE_ARC_EXTRA * Math.PI;
    return Math.PI - spread + ((rel - 1) * (Math.PI + 2 * spread)) / Math.max(1, n - 2);
  }
  return Math.PI / 2 + (rel * 2 * Math.PI) / n;
}

// Seats sit on an ellipse around the rail; narrow screens and big tables pull them in.
function seatRadius(v) {
  const { w, h } = viewport();
  const narrow = w < 560;
  const crowded = v.players.length >= 7;
  const short = h <= LANDSCAPE_MAX_HEIGHT;
  if (isLandscape()) return { x: 43, y: 40 };
  return { x: narrow ? (crowded ? 35 : 37) : 43, y: short ? 38 : 42 };
}

function seatPoint(seat, v, scale = 1) {
  const a = seatAngle(seat, v);
  const r = seatRadius(v);
  return { x: 50 + r.x * scale * Math.cos(a), y: 50 + r.y * scale * Math.sin(a) };
}

// Where a seat's latest play lands: between the seat and the centre.
// In landscape my own plays land just above the dock.
function playPoint(seat, v) {
  if (isLandscape() && seat === v.you?.seat) return { x: 50, y: 82 };
  const a = seatAngle(seat, v);
  const narrow = viewport().w < 560;
  const r = seatRadius(v);
  const scale = isLandscape() ? 0.5 : narrow || v.players.length >= 7 ? 0.5 : 0.56;
  return { x: 50 + r.x * scale * Math.cos(a), y: 50 + r.y * scale * Math.sin(a) };
}

function renderTable(v) {
  // Layout size (offsetWidth/Height), not the on-screen box, so this also holds when the page is rotated.
  const wrap = document.querySelector('.felt-wrap');
  const stage = { width: wrap.offsetWidth, height: wrap.offsetHeight };
  const effects = [];
  const seats = [];
  const landscape = isLandscape();
  const dealing = v.phase === 'dealing' ? dealProgress(v) : null;
  state.dealDrawn = dealing ? { key: v.handNo, ...dealing } : null;
  const cardCount = (p) => (dealing ? dealing.rounds : p.cards ?? 0);
  for (const p of v.players) {
    const isMe = p.id === v.you?.id;
    const { x, y } = landscape && isMe ? { x: 50, y: 100 } : seatPoint(p.seat, v);
    const cls = ['seat'];
    if (landscape && isMe) cls.push('is-hidden-me');
    if (v.turn === p.seat) cls.push('is-turn');
    if (p.place) cls.push('is-out');
    if (!p.online) cls.push('is-offline');
    const backs = cardCount(p) ? Array.from({ length: Math.min(4, Math.ceil(cardCount(p) / 7)) }, () => '<i></i>').join('') : '';
    const badge = p.place
      ? `<span class="badge">${p.place === 1 ? '头游' : `第 ${p.place}`}</span>`
      : !p.online ? '<span class="badge muted">托管</span>' : '';
    seats.push(`
      <div class="${cls.join(' ')}" style="--x:${x}%;--y:${y}%">
        <div class="ring" data-ring="${p.seat}">${avatarHtml(p)}${isMe ? '' : `<span class="backs">${backs}</span>`}${badge}</div>
        <div class="nameplate">
          <span class="name">${esc(p.name.replace(/\(机器人\)$/, ''))}${isMe ? '<span class="long">（你）</span>' : ''}</span>
          <span class="stats"><span>${cardCount(p)} 张</span><span class="pts">${p.captured} 分</span></span>
          ${p.account ? badgeHtml(p.account, { compact: true }) : ''}
        </div>
      </div>`);

    const action = v.seatActions[p.seat];
    if (action) {
      const { x: px, y: py } = playPoint(p.seat, v);
      const isTop = v.trick && v.trick.seat === p.seat;
      const fresh = state.fxPrimed && !state.fxSeen.has(action.id);
      // Fresh plays fly in from the player's seat; older ones stay put across re-renders.
      const dx = ((x - px) / 100) * stage.width;
      const dy = ((y - py) / 100) * stage.height;
      // The winning play is shown large; on crowded landscape tables the others shrink so they do not overlap.
      const crowdedLandscape = landscape && v.players.length >= 6 && !isTop;
      const size = action.cards && (action.cards.length > 8 || crowdedLandscape) ? 'sm' : 'md';
      const body = action.pass ? '<span class="pass-tag">不要</span>' : fanHtml(action.cards, size);
      seats.push(`<div class="played ${isTop ? 'is-top' : ''} ${fresh ? 'fresh' : ''}" style="--x:${px}%;--y:${py}%;--dx:${dx}px;--dy:${dy}px">${body}</div>`);
      if (fresh && action.cards) effects.push(() => fx.play({ type: action.type, level: action.level, x: px, y: py }));
      state.fxSeen.add(action.id);
    }
    const headKey = `head:${v.handNo}:${p.seat}`;
    if (p.place === 1 && !state.fxSeen.has(headKey)) {
      if (state.fxPrimed) effects.push(() => fx.banner(`${esc(p.name.replace(/\(机器人\)$/, ''))} 头游`));
      state.fxSeen.add(headKey);
    }
  }
  const trick = v.lastTrick;
  if (trick?.id && !state.fxSeen.has(trick.id)) {
    if (state.fxPrimed && trick.points >= BIG_TRICK_POINTS) {
      const { x, y } = seatPoint(trick.seat, v, 0.72);
      effects.push(() => fx.points({ x, y, points: trick.points }));
    }
    state.fxSeen.add(trick.id);
  }
  effects.push(...phaseEffects(v));
  $('seats').innerHTML = seats.join('');
  state.fxPrimed = true;
  for (const run of effects) run();

  const t = v.trick;
  let center;
  if (v.phase === 'dealing') {
    center = dealCenter(v, dealing);
  } else if (TRIBUTE_PHASES.includes(v.phase) && v.tribute) {
    center = tributePanel(v);
  } else if (v.phase === 'hand_over' || v.phase === 'match_over') {
    const lastTrick = v.lastTrick ? `<span class="idle small">${esc(shortName(playerAt(v.lastTrick.seat).name))} 收下最后一墩 ${v.lastTrick.points} 分</span>` : '';
    center = state.reviewCollapsed ? `${reviewBar(v)}${lastTrick}` : '<span class="idle">本局结束</span>';
  } else if (t) {
    center = `<span class="points-pill">${t.points}<small>分在桌上</small></span>
      <span class="trick-label">${esc(playerAt(t.seat).name.replace(/\(机器人\)$/, ''))} 的 <b>${TYPE_LABEL[t.type] ?? ''}</b> 最大</span>`;
  } else if (v.lastTrick) {
    center = `<span class="idle">${esc(playerAt(v.lastTrick.seat).name.replace(/\(机器人\)$/, ''))} 收下 ${v.lastTrick.points} 分，重新出牌</span>`;
  } else {
    center = v.phase === 'playing' ? `<span class="idle">${esc(playerAt(v.turn).name.replace(/\(机器人\)$/, ''))} 先出</span>` : '';
  }
  $('centerArea').innerHTML = turnIndicator(v) + center;
  announceMyTurn(v);
  $('logTicker').innerHTML = [...v.log].slice(-3).reverse().map((l) => `<li>${esc(l.text)}</li>`).join('');

  if (dealing) renderDealHand(v, dealing.cards);
  else renderHand(v);
  renderActions(v);
  renderQuickPicks(v);
  renderCounter(v);
  renderPlayLog(v);
}

// Where a seat sits on the stage for effects; in landscape my own seat is the dock.
function seatSpot(seat, v) {
  if (isLandscape() && seat === v.you?.seat) return { x: 50, y: 96 };
  return seatPoint(seat, v);
}

// One-off effects tied to the phase: the black 3 claim, tribute and return cards flying between seats,
// and the 抗贡 stamp. Each runs once per hand; a reload marks them seen without playing them.
function phaseEffects(v) {
  const out = [];
  const once = (key, fn) => {
    if (state.fxSeen.has(key)) return;
    state.fxSeen.add(key);
    if (state.fxPrimed) out.push(fn);
  };
  const name = (seat) => esc(shortName(playerAt(seat).name));
  if (v.claimedBy !== null && v.claimedBy !== undefined && v.phase !== 'lobby') {
    once(`claim:${v.handNo}`, () => fx.stamp(`${name(v.claimedBy)} 亮黑3！`, 'claim'));
  }
  const t = v.tribute;
  if (v.phase === 'tribute' && t && t.given.length) {
    once(`tribute:${v.handNo}`, () => t.given.forEach((g, i) => fx.flyCard({
      html: baseCardHtml(g.card, { size: 'md' }), from: seatSpot(g.from, v), to: seatSpot(g.to, v), delay: 300 + i * 450,
    })));
  }
  if (v.phase === 'return_reveal' && t) {
    once(`return:${v.handNo}`, () => t.returns.filter((r) => r.card).forEach((r, i) => fx.flyCard({
      html: baseCardHtml(r.card, { size: 'md' }), from: seatSpot(r.from, v), to: seatSpot(r.to, v), delay: 200 + i * 350,
    })));
  }
  // 抗贡 shows during the tribute phase; should play start without one, stamp it before anyone has played.
  const fresh = v.phase === 'tribute' || (v.phase === 'playing' && !v.lastTrick && !Object.keys(v.seatActions).length);
  if (t && t.resisted && fresh) {
    once(`resist:${v.handNo}`, () => fx.stamp('抗贡：本局免贡', 'resist', 3000));
  }
  return out;
}

function dealCenter(v, d) {
  const total = v.dealTotalRounds || 0;
  let status = '';
  if (v.claimedBy !== null && v.claimedBy !== undefined) {
    status = `<span class="deal-status"><b>${esc(shortName(playerAt(v.claimedBy).name))}</b> 亮黑3，先出牌</span>`;
  } else if (d.rounds >= total) {
    status = '<span class="deal-status">发完了，谁有黑桃 3 快亮！</span>';
  }
  return `<div class="deal-deck"><span class="deck-stack" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="deal-count">发牌 <b>${d.rounds}</b> / ${total}</span></div>${status}`;
}

// Caption panel in the middle of the felt while tribute is given, returned and shown.
function tributePanel(v) {
  const t = v.tribute;
  if (t.resisted) return '<div class="tribute-panel"><h3>抗贡</h3><p class="tp-wait">有人握有全部的王，本局免贡</p></div>';
  if (!t.given.length) return '';
  const name = (seat) => `<b>${esc(shortName(playerAt(seat).name))}</b>`;
  const card = (id) => (id ? baseCardHtml(id, { size: 'xs' }) : '<span class="card-slot" aria-label="未公开"></span>');
  let title;
  let lines;
  if (v.phase === 'return_reveal') {
    title = '还贡';
    lines = t.returns.map((r) => `<li>${name(r.from)} 还贡 ${name(r.to)} ${card(r.card)}</li>`);
  } else {
    title = '上贡';
    lines = t.given.map((g) => `<li>${name(g.from)} → ${name(g.to)} 上贡 ${card(g.card)}</li>`);
  }
  let foot = '';
  if (v.phase === 'returning') {
    const waiting = t.returns.filter((r) => !r.done).map((r) => name(r.from));
    if (waiting.length) foot = `<p class="tp-wait"><span class="timer sm" data-timer></span><span>等待 ${waiting.join('、')} 选牌还贡</span></p>`;
  }
  return `<div class="tribute-panel phase-${v.phase}"><h3>${title}</h3><ul>${lines.join('')}</ul>${foot}</div>`;
}

const COUNTER_RANKS = ['2', 'A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3'];

// Only present in this player's own view, and only when an admin enabled it for their account.
function renderCounter(v) {
  const panel = $('counterPanel');
  const c = v.you?.counter;
  panel.hidden = !c;
  if (!c) return;
  const cell = (label, n) => `<span class="cc ${n ? '' : 'gone'}"><b>${label}</b><i>${n}</i></span>`;
  panel.classList.toggle('open', state.counterOpen);
  panel.innerHTML = `
    <button type="button" id="counterToggle" class="counter-head" aria-expanded="${state.counterOpen}">
      记牌器<span>余 ${c.points} 分</span>
    </button>
    <div class="counter-body">
      <div class="cc-grid">${cell('大王', c.remaining.B)}${cell('小王', c.remaining.L)}${COUNTER_RANKS.map((r) => cell(r === 'T' ? '10' : r, c.remaining[r])).join('')}</div>
      <div class="cc-points"><span>5 还有 <b>${c.fives}</b></span><span>10 还有 <b>${c.tens}</b></span><span>K 还有 <b>${c.kings}</b></span></div>
    </div>`;
}

// Floating panel with every play of this hand, grouped by trick, newest at the bottom.
function renderPlayLog(v) {
  const panel = $('playLog');
  const btn = $('playLogBtn');
  const sound = $('soundBtn');
  sound.setAttribute('aria-pressed', String(state.sound));
  sound.textContent = state.sound ? '声音：开' : '声音：关';
  const plays = v.plays || [];
  btn.hidden = !plays.length && v.phase !== 'playing';
  btn.setAttribute('aria-expanded', String(state.playLogOpen));
  btn.classList.toggle('on', state.playLogOpen);
  const wasHidden = panel.hidden;
  panel.hidden = !state.playLogOpen || btn.hidden;
  if (panel.hidden) return;
  const name = (seat) => esc(shortName(playerAt(seat).name)) + (seat === v.you?.seat ? '（你）' : '');
  const rounds = [[]];
  for (const p of plays) {
    const round = rounds[rounds.length - 1];
    if (p.trick) {
      round.push(`<li class="pl-trick">${name(p.seat)} 收下这一轮${p.points ? `，得 <b>${p.points}</b> 分` : '（没有分）'}</li>`);
      rounds.push([]);
    } else if (p.pass) {
      round.push(`<li><span class="pl-name">${name(p.seat)}</span><span class="pl-pass">不要${p.auto ? '（自动）' : ''}</span></li>`);
    } else {
      round.push(`<li><span class="pl-name">${name(p.seat)}</span><span class="pl-play"><span class="pl-type">${TYPE_LABEL[p.type] ?? ''}${p.auto ? '（自动）' : ''}</span>${fanHtml(p.cards, 'sm')}</span></li>`);
    }
  }
  if (!rounds[rounds.length - 1].length) rounds.pop();
  const body = rounds.length
    ? rounds.map((r, i) => `<li class="pl-round"><h4>第 ${i + 1} 轮</h4><ol>${r.join('')}</ol></li>`).join('')
    : '<li class="pl-empty">这一局还没有人出牌</li>';
  const list = panel.querySelector('.pl-list');
  const atBottom = wasHidden || !list || list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  panel.innerHTML = `
    <div class="pl-head"><h3>本局出牌记录</h3><button id="playLogClose" type="button" class="btn">关闭</button></div>
    <ol class="pl-list">${body}</ol>`;
  // Stay with the newest play unless the player scrolled up to read older ones.
  const fresh = panel.querySelector('.pl-list');
  if (atBottom) fresh.scrollTop = fresh.scrollHeight;
  else fresh.scrollTop = list.scrollTop;
}

// Short chimes made with Web Audio (no sound files). Browsers only allow sound after a tap, so the
// context is created on the first tap anywhere and reused.
let audio = null;
function audioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    if (!audio) audio = new AC();
    if (audio.state === 'suspended') audio.resume();
  } catch { return null; }
  return audio;
}
document.addEventListener('pointerdown', () => { if (state.sound) audioContext(); }, { passive: true });

function beep(notes, volume = 0.25) {
  if (!state.sound) return;
  const ctx = audioContext();
  if (!ctx) return;
  let t = ctx.currentTime + 0.02;
  for (const [freq, secs] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + secs);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + secs + 0.05);
    t += secs * 0.8;
  }
}
const chimeMyTurn = () => beep([[660, 0.18], [880, 0.32]]);
const chimeUrgent = () => beep([[990, 0.12]], 0.18);

const GROUP_GAP = 12; // extra space before each 510K group, px
const TWO_ROW_MIN_CARDS = 14;
const MIN_STEP = 12; // smallest visible slice of a covered card, px

// Lay the hand out to fit the dock width: cards overlap just enough to fit, and on
// portrait phones a long hand splits into two rows (higher cards on top).
// "Whose turn": a label in the middle of the felt with an arrow pointing at that seat.
function turnIndicator(v) {
  if (v.phase !== 'playing' || v.turn < 0) return '';
  if (v.turn === v.you?.seat) return '<span class="turn-now me">轮到你出牌</span>';
  const deg = (seatAngle(v.turn, v) * 180) / Math.PI;
  return `<span class="turn-now"><i class="turn-arrow" style="--a:${deg}deg" aria-hidden="true"></i>轮到 <b>${esc(playerAt(v.turn).name.replace(/\(机器人\)$/, ''))}</b></span>`;
}

// When the turn comes to me: a banner, a short vibration where supported, and a lit-up dock.
function announceMyTurn(v) {
  const mine = v.phase === 'playing' && v.turn === v.you?.seat;
  document.querySelector('.dock').classList.toggle('my-turn', mine);
  if (mine && !state.wasMyTurn && state.fxPrimed) {
    fx.banner('轮到你了');
    chimeMyTurn();
    try { navigator.vibrate?.(40); } catch { /* not supported */ }
  }
  state.wasMyTurn = mine;
}

// Card width and overlap for a row of `widest` cards with `gaps` px of group spacing.
function handSizing(area, widest, gaps) {
  const baseWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 64;
  const available = Math.max(160, area.clientWidth - 24);
  const { h } = viewport();
  // Short hands get bigger cards (up to 35% larger) when the row has room; long ones keep the base size.
  const roomy = (available - gaps) / (1 + 0.5 * (widest - 1));
  // Landscape phones: size cards from the screen height (about a fifth of it), not the portrait base size.
  const landscapeWidth = Math.round(Math.min(66, Math.max(46, (h * 0.2) / 1.4)));
  const cardWidth = isLandscape() ? landscapeWidth : Math.round(Math.max(baseWidth, Math.min(baseWidth * 1.35, roomy)));
  const step = Math.max(MIN_STEP, Math.min(cardWidth * 0.5, (available - gaps - cardWidth) / Math.max(1, widest - 1)));
  area.style.setProperty('--pull', `${cardWidth - step}px`);
  area.style.setProperty('--card-w', `${cardWidth}px`);
}

const twoRowHand = (count) => {
  const { w, h } = viewport();
  return w < 700 && h > LANDSCAPE_MAX_HEIGHT && count >= TWO_ROW_MIN_CARDS;
};

function renderHand(v) {
  const area = $('handArea');
  delete area.dataset.deal;
  const hand = v.you?.hand ?? [];
  if (!hand.length) {
    state.flip = null;
    area.innerHTML = `<div class="hand-empty">${v.phase === 'playing' ? '你已出完，等待本局结束' : ''}</div>`;
    return;
  }
  const bombs = bombValues(hand);
  const groups = state.sortMode === '510k'
    ? (({ groups: g, rest }) => [...g, rest])(sortBy510k(hand)).filter((g) => g.length)
    : [sortBySize(hand)];
  const cards = groups.flatMap((g) => g.map((c, i) => ({ id: c, groupStart: i === 0 })));

  const twoRows = twoRowHand(cards.length);
  const rows = twoRows ? [cards.slice(0, Math.ceil(cards.length / 2)), cards.slice(Math.ceil(cards.length / 2))] : [cards];
  const widest = Math.max(...rows.map((r) => r.length));
  const gaps = Math.max(...rows.map((r) => r.filter((c, i) => i > 0 && c.groupStart).length)) * GROUP_GAP;
  handSizing(area, widest, gaps);

  const cardEl = ({ id, groupStart }, i) => {
    const html = cardHtml(id, { selectable: true, bomb: !isJoker(id) && bombs.has(valueOf(id)) });
    return i > 0 && groupStart ? html.replace('class="card', 'class="card gs') : html;
  };
  area.classList.toggle('two', twoRows);
  area.innerHTML = rows.map((r) => `<div class="row">${r.map(cardEl).join('')}</div>`).join('');
  if (state.flip) {
    applyFlip(area, state.flip);
    state.flip = null;
  }
}

// While dealing: my cards in dealt order, face up. The layout is sized for the full hand up front, and new
// cards are appended (not re-rendered) so each one's fly-in animation runs to the end.
function renderDealHand(v, shown) {
  const area = $('handArea');
  const total = v.dealTotalRounds;
  const twoRows = twoRowHand(total);
  const split = twoRows ? Math.ceil(total / 2) : total;
  const key = `${v.handNo}|${twoRows}|${total}|${isLandscape()}`;
  let drawn = area.dataset.deal === key ? area.querySelectorAll('.card').length : -1;
  if (drawn < 0 || drawn > shown) {
    const again = area.dataset.deal && area.dataset.deal.split('|')[0] === String(v.handNo);
    handSizing(area, split, 0);
    area.classList.toggle('two', twoRows);
    area.innerHTML = twoRows ? '<div class="row"></div><div class="row"></div>' : '<div class="row"></div>';
    area.dataset.deal = key;
    // A relayout (rotation) redraws what was already dealt without flying it in again.
    drawn = 0;
    if (again || !state.fxPrimed) appendDealCards(area, v.you.hand.slice(0, shown), 0, split, false);
    else appendDealCards(area, v.you.hand.slice(0, shown), 0, split, true, v.dealRoundMs);
    return;
  }
  if (shown > drawn) appendDealCards(area, v.you.hand.slice(drawn, shown), drawn, split, true, v.dealRoundMs);
}

function appendDealCards(area, cards, from, split, animate, roundMs = 120) {
  const rows = area.querySelectorAll('.row');
  // Cards that arrive together (a late push) still come in one after another.
  const stagger = Math.min(roundMs, 45);
  cards.forEach((id, k) => {
    const i = from + k;
    const row = rows[i < split ? 0 : 1] || rows[0];
    const html = baseCardHtml(id).replace('class="card', `data-deal="${id}" class="card${animate ? ' deal-in' : ''}`);
    row.insertAdjacentHTML('beforeend', html);
    if (animate) row.lastElementChild.style.animationDelay = `${k * stagger}ms`;
  });
}

// Screen positions of the cards in my hand, keyed by card id.
function captureHand() {
  const map = new Map();
  for (const el of document.querySelectorAll('#handArea .card')) {
    map.set(el.dataset.card || el.dataset.deal, el.getBoundingClientRect());
  }
  return map;
}

// FLIP: start each card where it sat before (dealt order) and slide it into its sorted place.
function applyFlip(area, before) {
  if (reducedMotion() || !before.size) return;
  const rotated = document.documentElement.classList.contains('rotated');
  for (const el of area.querySelectorAll('.card')) {
    if (typeof el.animate !== 'function') return;
    const from = before.get(el.dataset.card);
    const to = el.getBoundingClientRect();
    let frames;
    if (from) {
      const sx = from.left - to.left;
      const sy = from.top - to.top;
      // The rotated page turns screen offsets by 90 degrees.
      const dx = rotated ? sy : sx;
      const dy = rotated ? -sx : sy;
      frames = [{ transform: `translate(${dx}px, ${dy}px)`, opacity: 1 }, { transform: 'translate(0px, 0px)', opacity: 1 }];
    } else {
      // Cards that were not in the dealt hand (the leftover) drop in.
      frames = [{ transform: 'translate(0px, -40px)', opacity: 0 }, { transform: 'translate(0px, 0px)', opacity: 1 }];
    }
    el.animate(frames, { duration: 600, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  }
}

// Tap toggles a card; pressing and sliding across cards applies the same choice to each.
function setupHandGestures() {
  const area = $('handArea');
  let drag = null;
  const mark = (el, select) => {
    const id = el.dataset.card;
    if (select) state.selected.add(id);
    else state.selected.delete(id);
    el.classList.toggle('selected', select);
    el.setAttribute('aria-pressed', String(select));
  };
  area.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-card]');
    if (!el || e.button > 0) return;
    e.preventDefault();
    if (state.view?.phase === 'returning') {
      state.selected = new Set([el.dataset.card]);
      render();
      return;
    }
    drag = { select: !state.selected.has(el.dataset.card), seen: new Set([el.dataset.card]) };
    if (drag.select) state.focusCard = el.dataset.card;
    mark(el, drag.select);
    area.setPointerCapture?.(e.pointerId);
  });
  area.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('#handArea [data-card]');
    if (!el || drag.seen.has(el.dataset.card)) return;
    drag.seen.add(el.dataset.card);
    mark(el, drag.select);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    render();
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);
}
setupHandGestures();

// Tappable plays above the hand: what beats the last play, or, after tapping a card,
// the plays that use that card.
// My own seat info, shown in the dock in landscape (where my seat is not drawn on the felt).
function myInfoHtml(v) {
  if (!isLandscape() || !v.you) return '';
  const me = v.players[v.you.seat];
  const place = me.place ? `<b class="place">${me.place === 1 ? '头游' : `第 ${me.place}`}</b>` : '';
  const count = v.phase === 'dealing' ? dealProgress(v).rounds : me.cards ?? 0;
  return `<span class="my-info">${esc(me.name.replace(/\(机器人\)$/, ''))} ${count} 张 <span class="pts">${me.captured} 分</span>${place}</span>`;
}

function renderQuickPicks(v) {
  const el = $('quickPicks');
  const myTurn = v.phase === 'playing' && v.turn === v.you?.seat;
  if (!myTurn || !v.you.hand.length) {
    state.picks = [];
    const info = myInfoHtml(v);
    el.hidden = !info;
    el.innerHTML = info;
    return;
  }
  const focus = state.focusCard && state.selected.has(state.focusCard) ? state.focusCard : null;
  state.picks = quickPicks(v.you.hand, currentTop(), v.decks, focus);
  const chosen = [...state.selected].sort().join();
  el.hidden = false;
  el.innerHTML = myInfoHtml(v) + (state.picks.length
    ? `<span class="picks-label">${focus ? '含这张' : v.trick ? '能压' : '可出'}</span>${state.picks.map((p, i) => `
        <button type="button" class="pick ${p.combo.cat ? 'special' : ''} ${[...p.cards].sort().join() === chosen ? 'on' : ''}" data-pick="${i}">${esc(comboLabel(p.combo))}</button>`).join('')}`
    : `<span class="picks-label">${focus ? '这张牌没有能出的组合' : '要不起'}</span>`);
}

function renderActions(v) {
  const sort = `<button type="button" id="sortBtn" class="btn btn-ghost sort-btn" title="切换手牌整理方式"><span class="long">整理：</span>${state.sortMode === '510k' ? '510K 优先' : '按大小'}</button>`;
  let main = '';
  const myTurn = v.phase === 'playing' && v.turn === v.you?.seat;
  if (myTurn) {
    const options = currentHints();
    const selected = [...state.selected];
    const combo = selected.length ? identify(selected, v.decks) : null;
    const canPlay = Boolean(combo && beats(combo, currentTop()));
    const stuck = !options.length && v.trick;
    main = `
      <span class="spacer"></span>
      <span class="timer" data-timer></span>
      <button id="passBtn" class="btn ${stuck ? 'btn-primary' : ''}" ${v.trick ? '' : 'disabled'}>${stuck ? '要不起' : '不要'}</button>
      <button id="hintBtn" class="btn" ${options.length ? '' : 'disabled'}>提示</button>
      <button id="playBtn" class="btn btn-primary" ${canPlay ? '' : 'disabled'}>出牌${combo ? ` · ${TYPE_LABEL[combo.type]}` : ''}</button>`;
  } else if (v.phase === 'playing' && v.turn >= 0) {
    main = `<span class="spacer"></span><span class="status">等待 ${esc(playerAt(v.turn).name.replace(/\(机器人\)$/, ''))} 出牌</span>`;
  } else if (v.phase === 'dealing') {
    main = `<span class="spacer"></span>${dealAction(v)}`;
  }
  const clear = state.selected.size ? '<button id="clearBtn" class="btn btn-ghost btn-sm">取消选择</button>' : '';
  $('actionBar').innerHTML = `${sort}${main}${clear}`;
}

// The 亮黑3 button shows once a spade 3 has reached my hand and nobody has claimed yet.
function dealAction(v) {
  const d = dealProgress(v);
  const me = v.you ? v.players[v.you.seat] : null;
  const claimed = v.claimedBy !== null && v.claimedBy !== undefined;
  const mine = v.you ? v.you.hand.slice(0, d.cards).some(isBlackThree) : false;
  if (!claimed && mine && me && !me.leftEarly && !v.paused) {
    return '<button id="claimBtn" type="button" class="btn btn-claim">亮黑3</button>';
  }
  if (claimed) return `<span class="status">${esc(shortName(playerAt(v.claimedBy).name))} 亮了黑3</span>`;
  if (v.deadline) return '<span class="timer" data-timer></span><span class="status">没人亮黑3 就随机先出</span>';
  return '<span class="status">发牌中…</span>';
}

function renderOverlay(v) {
  const overlay = $('overlay');
  let html = '';
  let mode = '';
  const mustReturn = v.phase === 'returning' && v.you && v.you.mustReturnTo !== null;
  if (v.paused) {
    mode = 'paused';
    html = `
      <div class="pause-card" role="dialog" aria-label="房主已暂停">
        <span class="pause-icon" aria-hidden="true"><i></i><i></i></span>
        <h2>房主已暂停</h2>
        <p>计时已停住，继续后接着打。</p>
        ${v.you?.isHost ? '<button id="resumeBtn" type="button" class="btn btn-primary">继续游戏</button>' : '<span class="note">等待房主继续</span>'}
      </div>`;
  } else if (mustReturn) {
    if (state.fxPrimed && state.returnChimed !== v.handNo) chimeMyTurn();
    state.returnChimed = v.handNo;
    mode = 'passive';
    html = returnDialog(v);
  } else if ((v.phase === 'hand_over' || v.phase === 'match_over') && !state.reviewCollapsed) {
    // Collapsed, the review shrinks to a bar in the middle of the felt (see renderTable).
    html = resultDialog(v);
  }
  overlay.hidden = !html;
  overlay.innerHTML = html;
  overlay.classList.toggle('passive', mode === 'passive');
  overlay.classList.toggle('paused', mode === 'paused');
}

// The receiver picks one card to give back: the tribute they got, the card picked so far, a big countdown.
function returnDialog(v) {
  const to = playerAt(v.you.mustReturnTo);
  const got = v.tribute ? v.tribute.given.find((g) => g.to === v.you.seat && g.from === v.you.mustReturnTo) : null;
  const one = state.selected.size === 1 ? [...state.selected][0] : null;
  const timed = Boolean(v.deadline) || (v.paused && v.pausedRemaining !== null);
  const toName = esc(shortName(to.name));
  return `
    <div class="dialog return-dialog" role="dialog" aria-label="还贡">
      <div class="rd-head">
        <h2>还一张牌给 ${toName}</h2>
        ${timed ? '<span class="timer big" data-timer></span>' : ''}
      </div>
      <div class="rd-cards">
        ${got ? `<figure><figcaption>${toName} 上贡给你</figcaption>${baseCardHtml(got.card, { size: 'md' })}</figure>
        <span class="rd-arrow" aria-hidden="true">⇄</span>` : ''}
        <figure><figcaption>${one ? '你要还' : '还没选牌'}</figcaption>${one ? baseCardHtml(one, { size: 'md' }) : '<span class="card-slot md"></span>'}</figure>
      </div>
      <p>从下方手牌里点一张还给 ${toName}${timed ? '，超时会自动还最小的一张' : ''}。</p>
      <div class="actions">
        <button id="returnBtn" class="btn btn-primary" ${one ? '' : 'disabled'}>还这张</button>
      </div>
    </div>`;
}

// Humans the next hand waits on and how many of them are ready, as the server counts them
// (during the reconnect grace after a restart, offline humans still count).
function readyCount(v) {
  if (v.readyWaiting) return { ready: v.readyWaiting.ready, of: v.readyWaiting.needed };
  const waiting = v.players.filter((p) => !p.isBot && p.online && !p.leftEarly);
  return { ready: waiting.filter((p) => v.ready.includes(p.seat)).length, of: waiting.length };
}

function readyControls(v) {
  if (v.phase !== 'hand_over' || !v.you) return '';
  const me = v.players[v.you.seat];
  if (me.leftEarly) return '';
  if (!v.ready.includes(v.you.seat)) return '<button id="readyBtn" type="button" class="btn btn-primary">准备好了</button>';
  const c = readyCount(v);
  return `<span class="ready-done">✓ 已准备<small>等待其他人 ${c.ready}/${c.of}</small></span>`;
}

function reviewBar(v) {
  const over = v.phase === 'match_over';
  const timed = !over && (Boolean(v.deadline) || (v.paused && v.pausedRemaining !== null));
  return `
    <div class="review-bar" role="region" aria-label="本局复盘">
      <div class="rb-line"><span class="rb-title">${over ? '本轮结束' : `第 ${v.result.handNo} 局结束`}</span>
      ${timed ? '<span class="note">下一局 <span data-secs></span> 秒</span>' : ''}</div>
      <div class="rb-line">${readyControls(v)}<button id="reviewToggleBtn" type="button" class="btn btn-sm">展开复盘</button></div>
    </div>`;
}

function resultDialog(v) {
  const r = v.result;
  const over = v.phase === 'match_over';
  const short = (p) => esc(p.name.replace(/\(机器人\)$/, ''));
  const sides = v.teams ? [0, 1] : v.players.map((p) => p.seat);
  const label = (side) => (v.teams
    ? v.players.filter((p) => v.teams[p.seat] === side).map(short).join('、')
    : short(playerAt(side)));
  const color = (side) => (v.teams ? `var(--team-${side})` : 'var(--muted)');
  const rows = sides
    .map((side) => ({ side, hand: r?.score[side] ?? 0, total: v.totals[side] }))
    .sort((a, b) => b.total - a.total);
  const standings = rows.map((x, i) => `
    <div class="standing ${i === 0 ? 'lead' : ''}">
      <span class="rank">${i + 1}</span>
      <span class="names"><span class="dot" style="--team-color:${color(x.side)}"></span><span>${label(x.side)}</span></span>
      <span class="delta ${x.hand > 0 ? 'pos' : ''}">本局 ${x.hand > 0 ? '+' : ''}${x.hand}</span>
      <span class="total">${x.total}</span>
    </div>`).join('');
  const penalties = (r?.penalties ?? []).map((p) => `${label(p.from)} 有人没出完，罚 ${p.amount} 分`).join('；');
  const title = over ? '本轮结束' : `第 ${r.handNo} 局结束`;
  const mine = over && v.ratings && v.you ? v.ratings[v.you.seat] : null;
  const ratingLine = !over ? '' : mine && mine.delta !== null
    ? `<div class="rating-change ${mine.delta >= 0 ? 'up' : 'down'}">
         <span>段位分 ${mine.before} → <b>${mine.after}</b></span>
         <span class="delta">${mine.delta >= 0 ? '+' : ''}${mine.delta}</span>
         ${badgeHtml(v.you.account)}
       </div>`
    : '<div class="rating-change">游客或机器人不计段位</div>';
  const timed = !over && (Boolean(v.deadline) || (v.paused && v.pausedRemaining !== null));
  return `
    <div class="dialog review" role="dialog" aria-label="${title}">
      <div class="review-head">
        <h2>${title}${r?.sweep ? ' <span class="sweep">完胜</span>' : ''}</h2>
        <button id="reviewToggleBtn" type="button" class="btn btn-ghost btn-sm" title="收起，看看牌桌">收起</button>
      </div>
      <div class="standings">${standings}</div>
      ${r ? reviewPlayers(v, r) : ''}
      ${penalties ? `<div class="penalty">${penalties}</div>` : ''}
      ${ratingLine}
      <div class="actions">
        ${over && v.matchId && state.account ? `<a class="btn" href="/replay/${v.matchId}" target="_blank" rel="noopener">看回放</a>` : ''}
        ${over && state.account ? `<a class="btn" href="/u/${encodeURIComponent(state.account.username)}" target="_blank" rel="noopener">我的战绩</a>` : ''}
        ${over
          ? (v.you?.isHost ? '<button id="restartBtn" class="btn btn-primary">回到大厅</button>' : '<span class="note">等待房主操作</span>')
          : `${timed ? '<span class="note">下一局 <span data-secs></span> 秒后开始</span>' : '<span class="note">大家准备好就开始下一局</span>'}${readyControls(v)}${v.you?.isHost ? '<button id="nextBtn" class="btn">马上开始</button>' : ''}`}
      </div>
    </div>`;
}

// Overlap for the review's small fans, so even a full hand fits one line.
const fanStep = (n) => Math.max(5, Math.min(14, Math.floor(200 / Math.max(1, n - 1))));

// Per player: finish place, points captured this hand, and the cards still held (face up).
function reviewPlayers(v, r) {
  const place = new Map((r.ranking || []).map((seat, i) => [seat, i + 1]));
  const rows = [...v.players].sort((a, b) => (place.get(a.seat) || 99) - (place.get(b.seat) || 99)).map((p) => {
    const n = place.get(p.seat);
    const left = r.remaining ? r.remaining[p.seat] || [] : [];
    const out = !left.length;
    return `
      <li class="rv-row" style="${teamColor(p.seat)}">
        <span class="rv-place ${n === 1 ? 'head' : ''}">${n === 1 ? '头游' : n ? `第 ${n}` : ''}</span>
        <span class="rv-name">${esc(shortName(p.name))}${p.seat === v.you?.seat ? '<small>（你）</small>' : ''}</span>
        <span class="rv-pts">收 <b>${r.captured ? r.captured[p.seat] : 0}</b> 分</span>
        <span class="rv-cards ${out ? 'out' : ''}">${out ? '已出完' : `<span class="fan rv-fan" style="--step:${fanStep(left.length)}px">${left.map((c) => baseCardHtml(c, { size: 'xs' })).join('')}</span><small>${left.length} 张</small>`}</span>
      </li>`;
  }).join('');
  return `<ul class="review-players" aria-label="本局复盘">${rows}</ul>`;
}

// Countdown visuals update between server pushes.
function tick() {
  const left = timeLeft();
  const v = state.view;
  for (const el of document.querySelectorAll('[data-timer]')) {
    // No deadline (不计时, or nothing timed right now): no countdown at all.
    el.hidden = !left;
    el.textContent = left ? left.secs : '';
    el.style.setProperty('--p', left ? left.fraction : 0);
  }
  // My own turn or return in its last five seconds: the countdown turns red and ticks.
  const mine = v && ((v.phase === 'playing' && v.turn === v.you?.seat) || (v.phase === 'returning' && v.you?.mustReturnTo !== null));
  const urgent = Boolean(mine && left && !v.paused && left.secs <= 5);
  for (const el of document.querySelectorAll('[data-timer]')) el.classList.toggle('urgent', urgent);
  if (urgent && state.urgentSecs !== left.secs && left.secs > 0) {
    state.urgentSecs = left.secs;
    chimeUrgent();
    if (left.secs === 5) { try { navigator.vibrate?.(60); } catch { /* not supported */ } }
  }
  if (!urgent) state.urgentSecs = null;
  for (const el of document.querySelectorAll('[data-secs]')) el.textContent = left ? left.secs : '';
  for (const el of document.querySelectorAll('[data-ring]')) {
    const active = v?.phase === 'playing' && Number(el.dataset.ring) === v.turn && left;
    el.style.setProperty('--p', active ? left.fraction : 0);
  }
}
setInterval(tick, 200);

// While dealing, redraw whenever the local deal clock reveals another round (between server pushes).
setInterval(() => {
  const v = state.view;
  if (!v || v.phase !== 'dealing' || v.paused || !state.dealDrawn) return;
  const d = dealProgress(v);
  if (d.rounds !== state.dealDrawn.rounds || d.cards !== state.dealDrawn.cards) {
    renderTable(v);
    tick();
  }
}, 40);

// ---- events ---------------------------------------------------------------------------

// Host swaps two lobby seats: first tap picks, second tap swaps, tapping the same seat cancels.
function onSwapSlot(slot) {
  const id = slot.dataset.swap;
  if (!state.swapPick || state.swapPick === id) {
    state.swapPick = state.swapPick === id ? null : id;
    render();
    return;
  }
  const first = state.swapPick;
  state.swapPick = null;
  run(() => api('/api/rooms/swap-seats', { a: first, b: id }));
  render();
}

document.addEventListener('click', (e) => {
  const slot = e.target.closest('[data-swap]');
  if (slot && !e.target.closest('button')) {
    onSwapSlot(slot);
    return;
  }
  const target = e.target.closest('button');
  if (!target) return;
  const cardId = target.dataset.card;
  if (cardId) {
    if (e.detail !== 0) return; // pointer taps are handled by the hand gestures; this is keyboard activation
    if (state.view?.phase === 'returning') state.selected = new Set([cardId]);
    else if (state.selected.has(cardId)) state.selected.delete(cardId);
    else {
      state.selected.add(cardId);
      state.focusCard = cardId;
    }
    render();
    return;
  }
  if (target.dataset.entry) {
    state.entryMode = target.dataset.entry;
    writePref('entryMode', state.entryMode);
    renderEntry();
    return;
  }
  if (target.dataset.pick) {
    const pick = state.picks[Number(target.dataset.pick)];
    if (pick) state.selected = new Set(pick.cards);
    render();
    return;
  }
  if (target.dataset.remove) {
    run(() => api('/api/rooms/remove-player', { playerId: target.dataset.remove }));
    return;
  }
  switch (target.id) {
    case 'createBtn':
      run(async () => enterRoom(await api('/api/rooms/create', { name: guestName() })));
      break;
    case 'joinBtn':
      run(async () => enterRoom(await api('/api/rooms/join', { code: $('codeInput').value.trim().toUpperCase(), name: guestName() })));
      break;
    case 'loginBtn':
    case 'registerBtn':
      run(async () => {
        const res = await api(target.id === 'loginBtn' ? '/api/auth/login' : '/api/auth/register', {
          username: $('usernameInput').value.trim(), password: $('passwordInput').value,
        });
        setAccount(res.accountToken, res.account);
      });
      break;
    case 'logoutBtn':
      run(async () => { await api('/api/auth/logout'); setAccount(null, null); });
      break;
    case 'addBotBtn': run(() => api('/api/rooms/add-bot')); break;
    case 'startBtn': run(() => api('/api/rooms/start')); break;
    case 'leaveBtn': run(async () => { await api('/api/rooms/leave'); leaveRoomLocally(); }); break;
    case 'nextBtn': run(() => api('/api/rooms/next')); break;
    case 'readyBtn': run(() => api('/api/rooms/ready')); break;
    case 'claimBtn': run(() => api('/api/rooms/claim-three')); break;
    case 'pauseBtn': run(() => api('/api/rooms/pause')); break;
    case 'resumeBtn': run(() => api('/api/rooms/resume')); break;
    case 'dealModeBtn':
      if (state.view) run(() => api('/api/rooms/deal-mode', { on: !state.view.dealMode }));
      break;
    case 'reviewToggleBtn':
      state.reviewCollapsed = !state.reviewCollapsed;
      render();
      break;
    case 'restartBtn': run(() => api('/api/rooms/restart')); break;
    case 'clearBtn': state.selected.clear(); render(); break;
    case 'playLogBtn':
    case 'playLogClose':
      state.playLogOpen = target.id === 'playLogBtn' ? !state.playLogOpen : false;
      render();
      break;
    case 'soundBtn':
      state.sound = !state.sound;
      writePref('sound', state.sound ? '1' : '0');
      if (state.sound) beep([[880, 0.15]]);
      render();
      break;
    case 'rotateBtn': toggleLandscape(); break;
    case 'copyLinkBtn':
    case 'roomBadge':
      copyInvite();
      break;

    case 'counterToggle':
      state.counterOpen = !state.counterOpen;
      writePref('counterOpen', state.counterOpen ? '1' : '0');
      render();
      break;
    case 'sortBtn':
      state.sortMode = state.sortMode === '510k' ? 'size' : '510k';
      writePref('sortMode', state.sortMode);
      render();
      break;
    case 'hintBtn': {
      const options = currentHints();
      if (!options.length) break;
      state.hintIndex = (state.hintIndex + 1) % options.length;
      state.selected = new Set(options[state.hintIndex].cards);
      render();
      break;
    }
    case 'passBtn': run(async () => { await api('/api/rooms/pass'); state.selected.clear(); }); break;
    case 'playBtn': run(async () => { await api('/api/rooms/play', { cards: [...state.selected] }); state.selected.clear(); render(); }); break;
    case 'returnBtn': run(async () => { await api('/api/rooms/return', { card: [...state.selected][0] }); state.selected.clear(); }); break;
    default:
      if (target.dataset.action === 'copy-link') copyInvite();
      break;
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'turnSelect') {
    const value = e.target.value;
    run(() => api('/api/rooms/set-turn-time', { seconds: value === '' ? null : Number(value) }));
  }
  if (e.target.id === 'decksSelect') {
    const value = e.target.value;
    run(() => api('/api/rooms/set-decks', { decks: value === '' ? null : Number(value) }));
  }
});

$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (e.target.dataset?.swap) {
    e.preventDefault();
    onSwapSlot(e.target);
    return;
  }
  if (e.key !== 'Enter') return;
  if (e.target.id === 'nameInput') $(state.invite ? 'joinBtn' : 'createBtn').click();
  if (e.target.id === 'passwordInput') $('loginBtn')?.click();
});
document.addEventListener('input', (e) => { if (e.target.id === 'nameInput') writePref('name', e.target.value.trim()); });

function guestName() {
  return state.account ? '' : ($('nameInput')?.value ?? '');
}

// ---- boot -------------------------------------------------------------------------------

if (state.accountToken) {
  api('/api/auth/me').then((res) => setAccount(state.accountToken, res.account)).catch((err) => {
    if (err.code === 'session_expired') setAccount(null, null);
  });
}
// Back into the room with the token this tab stored. If the server cannot be reached (it may be restarting),
// keep the token and retry; only a definitive answer drops it.
function bootJoin(code, token, attempt = 0) {
  state.rejoining = true;
  renderConnection();
  api('/api/rooms/join', { code, token }).then((res) => {
    state.rejoining = false;
    enterRoom(res);
  }).catch((err) => {
    if (!definitive(err)) {
      setTimeout(() => bootJoin(code, token, attempt + 1), backoff(attempt));
      return;
    }
    state.rejoining = false;
    state.invite = code;
    writeSession(`token:${code}`, null);
    // A guest token that stopped working falls through to a nameless join (bad_name).
    const gone = err.code === 'bad_token' || err.code === 'bad_name';
    toast(gone ? '你的座位已失效，可能已在其他设备上重新加入' : ERROR_TEXT[err.code] || '网络错误，请重试');
    render();
  });
}

const roomFromUrl = new URL(location.href).searchParams.get('room');
if (roomFromUrl) {
  const code = roomFromUrl.toUpperCase();
  $('codeInput').value = code;
  const token = readSession(`token:${code}`);
  if (token) bootJoin(code, token);
  else state.invite = code;
}
render();

// ---- landscape --------------------------------------------------------------------
// Phones held sideways get the compact landscape layout. Going fullscreen needs a user gesture, so
// in landscape the first tap anywhere enters fullscreen (and locks landscape where allowed). iOS
// Safari has no fullscreen for pages: it gets a one-time tip to add the game to the home screen.
// The 横屏 button also works with the phone upright: where orientation cannot be locked the page
// rotates itself.

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
const canFullscreen = () => Boolean(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
const isStandalone = () => window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;

async function enterFullscreen() {
  const el = document.documentElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!request || fullscreenElement()) return;
  await request.call(el, { navigationUI: 'hide' });
  try { await screen.orientation?.lock?.('landscape'); } catch { /* lock not allowed here */ }
}

async function leaveFullscreen() {
  try { screen.orientation?.unlock?.(); } catch { /* nothing locked */ }
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (fullscreenElement() && exit) await exit.call(document);
}

let fullscreenArmed = false;
function armFullscreenOnTap() {
  if (fullscreenArmed || fullscreenElement() || !canFullscreen() || isStandalone()) return;
  fullscreenArmed = true;
  const go = () => {
    document.removeEventListener('click', go, true);
    document.removeEventListener('touchend', go, true);
    // Stay armed until the request settles: entering fullscreen fires resize, which would re-arm.
    const settle = isLandscape() ? enterFullscreen() : Promise.resolve();
    settle.catch(() => { /* the browser said no; keep playing windowed */ }).then(() => { fullscreenArmed = false; });
  };
  document.addEventListener('click', go, true);
  document.addEventListener('touchend', go, true);
  toast('轻触屏幕进入全屏', 'ok');
}

function applyOrientation() {
  const root = document.documentElement;
  // Real pixel sizes for layout: dvh/dvw units are missing in older Chromium-based phone browsers.
  root.style.setProperty('--vw', `${window.innerWidth}px`);
  root.style.setProperty('--vh', `${window.innerHeight}px`);
  const portrait = window.innerHeight > window.innerWidth;
  const rotated = IS_TOUCH && state.forceLandscape && portrait;
  const landscape = rotated || (!portrait && window.innerHeight <= LANDSCAPE_MAX_HEIGHT);
  const changed = root.classList.contains('landscape') !== landscape;
  root.classList.toggle('rotated', rotated);
  root.classList.toggle('landscape', landscape);
  const btn = $('rotateBtn');
  btn.hidden = !IS_TOUCH || (!portrait && !state.forceLandscape);
  btn.textContent = state.forceLandscape ? '竖屏' : '横屏';
  if (IS_TOUCH && landscape && !rotated) {
    if (canFullscreen()) armFullscreenOnTap();
    else if (!isStandalone() && !readSession('iosTip')) {
      writeSession('iosTip', '1');
      toast('想要全屏：点分享按钮，选"添加到主屏幕"，从主屏幕打开', 'ok');
    }
  }
  if (state.view && state.view.phase !== 'lobby') renderTable(state.view);
  else if (changed) render();
}

async function toggleLandscape() {
  state.forceLandscape = !state.forceLandscape;
  writePref('forceLandscape', state.forceLandscape ? '1' : '0');
  try {
    if (state.forceLandscape) await enterFullscreen();
    else await leaveFullscreen();
  } catch {
    // Not supported (e.g. iOS Safari): applyOrientation rotates the page instead.
  }
  applyOrientation();
}

window.addEventListener('resize', applyOrientation);
window.addEventListener('orientationchange', () => setTimeout(applyOrientation, 150));
document.addEventListener('fullscreenchange', applyOrientation);
document.addEventListener('webkitfullscreenchange', applyOrientation);
applyOrientation();
