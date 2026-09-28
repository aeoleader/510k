import { hints } from '/engine/hint.js';
import { identify, beats } from '/engine/combos.js';
import { sortBySize, sortBy510k, bombValues } from '/engine/sort.js';
import { valueOf, isJoker } from '/engine/cards.js';
import {
  TYPE_LABEL, esc, initial, cardHtml as baseCardHtml, badgeHtml, fanHtml,
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
};
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
  if (!res.ok) throw Object.assign(new Error(payload.error || 'error'), { code: payload.error });
  return payload;
}

async function run(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.code === 'session_expired') setAccount(null, null);
    toast(ERROR_TEXT[err.code] || '网络错误，请重试');
  }
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
  toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
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

async function recoverRoom(es) {
  if (state.events !== es) return;
  try {
    enterRoom(await api('/api/rooms/join', { code: state.code, token: state.token }));
  } catch {
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

function timeLeft() {
  const v = state.view;
  if (!v?.deadline) return null;
  const ms = Math.max(0, v.deadline - (Date.now() + state.clockOffset));
  return { secs: Math.ceil(ms / 1000), fraction: v.deadlineSpan ? ms / v.deadlineSpan : 0 };
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
  if (!inRoom) renderEntry();
  if (!v) {
    $('scoreboard').hidden = true;
    $('overlay').hidden = true;
    return;
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
  $('connection').hidden = !state.code || state.online;
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
        <select id="turnSelect" ${isHost ? '' : 'disabled'}>${[null, 10, 15, 20, 30, 45, 60].map((sec) => `
          <option value="${sec ?? ''}" ${v.turnChoice === sec ? 'selected' : ''}>${sec === null ? `默认 ${v.turnChoice === null ? v.turnSeconds : 15} 秒` : `${sec} 秒`}</option>`).join('')}
        </select>
      </label>
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
  const handTag = (pts) => (live ? `<span class="hand-pts" title="本局已收分，未计罚分">本局 +${pts}</span>` : '');
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
  for (const p of v.players) {
    const isMe = p.id === v.you?.id;
    const { x, y } = landscape && isMe ? { x: 50, y: 100 } : seatPoint(p.seat, v);
    const cls = ['seat'];
    if (landscape && isMe) cls.push('is-hidden-me');
    if (v.turn === p.seat) cls.push('is-turn');
    if (p.place) cls.push('is-out');
    if (!p.online) cls.push('is-offline');
    const backs = p.cards ? Array.from({ length: Math.min(4, Math.ceil(p.cards / 7)) }, () => '<i></i>').join('') : '';
    const badge = p.place
      ? `<span class="badge">${p.place === 1 ? '头游' : `第 ${p.place}`}</span>`
      : !p.online ? '<span class="badge muted">托管</span>' : '';
    seats.push(`
      <div class="${cls.join(' ')}" style="--x:${x}%;--y:${y}%">
        <div class="ring" data-ring="${p.seat}">${avatarHtml(p)}${isMe ? '' : `<span class="backs">${backs}</span>`}${badge}</div>
        <div class="nameplate">
          <span class="name">${esc(p.name.replace(/\(机器人\)$/, ''))}${isMe ? '<span class="long">（你）</span>' : ''}</span>
          <span class="stats"><span>${p.cards ?? 0} 张</span><span class="pts">${p.captured} 分</span></span>
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
  $('seats').innerHTML = seats.join('');
  state.fxPrimed = true;
  for (const run of effects) run();

  const t = v.trick;
  let center;
  if (t) {
    center = `<span class="points-pill">${t.points}<small>分在桌上</small></span>
      <span class="trick-label">${esc(playerAt(t.seat).name.replace(/\(机器人\)$/, ''))} 的 <b>${TYPE_LABEL[t.type] ?? ''}</b> 最大</span>`;
  } else if (v.phase === 'returning') {
    center = '<span class="idle">上贡完成，等待还贡</span>';
  } else if (v.lastTrick) {
    center = `<span class="idle">${esc(playerAt(v.lastTrick.seat).name.replace(/\(机器人\)$/, ''))} 收下 ${v.lastTrick.points} 分，重新出牌</span>`;
  } else {
    center = v.phase === 'playing' ? `<span class="idle">${esc(playerAt(v.turn).name.replace(/\(机器人\)$/, ''))} 先出</span>` : '';
  }
  $('centerArea').innerHTML = turnIndicator(v) + center;
  announceMyTurn(v);
  $('logTicker').innerHTML = [...v.log].slice(-3).reverse().map((l) => `<li>${esc(l.text)}</li>`).join('');

  renderHand(v);
  renderActions(v);
  renderQuickPicks(v);
  renderCounter(v);
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
    try { navigator.vibrate?.(40); } catch { /* not supported */ }
  }
  state.wasMyTurn = mine;
}

function renderHand(v) {
  const area = $('handArea');
  const hand = v.you?.hand ?? [];
  if (!hand.length) {
    area.innerHTML = `<div class="hand-empty">${v.phase === 'playing' ? '你已出完，等待本局结束' : ''}</div>`;
    return;
  }
  const bombs = bombValues(hand);
  const groups = state.sortMode === '510k'
    ? (({ groups: g, rest }) => [...g, rest])(sortBy510k(hand)).filter((g) => g.length)
    : [sortBySize(hand)];
  const cards = groups.flatMap((g) => g.map((c, i) => ({ id: c, groupStart: i === 0 })));

  const baseWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 64;
  const available = Math.max(160, area.clientWidth - 24);
  const { w, h } = viewport();
  const twoRows = w < 700 && h > LANDSCAPE_MAX_HEIGHT && cards.length >= TWO_ROW_MIN_CARDS;
  const rows = twoRows ? [cards.slice(0, Math.ceil(cards.length / 2)), cards.slice(Math.ceil(cards.length / 2))] : [cards];
  const widest = Math.max(...rows.map((r) => r.length));
  const gaps = Math.max(...rows.map((r) => r.filter((c, i) => i > 0 && c.groupStart).length)) * GROUP_GAP;
  // Short hands get bigger cards (up to 35% larger) when the row has room; long ones keep the base size.
  const roomy = (available - gaps) / (1 + 0.5 * (widest - 1));
  // Landscape phones: size cards from the screen height (about a fifth of it), not the portrait base size.
  const landscapeWidth = Math.round(Math.min(66, Math.max(46, (h * 0.2) / 1.4)));
  const cardWidth = isLandscape() ? landscapeWidth : Math.round(Math.max(baseWidth, Math.min(baseWidth * 1.35, roomy)));
  const step = Math.max(MIN_STEP, Math.min(cardWidth * 0.5, (available - gaps - cardWidth) / Math.max(1, widest - 1)));

  const cardEl = ({ id, groupStart }, i) => {
    const html = cardHtml(id, { selectable: true, bomb: !isJoker(id) && bombs.has(valueOf(id)) });
    return i > 0 && groupStart ? html.replace('class="card', 'class="card gs') : html;
  };
  area.classList.toggle('two', twoRows);
  area.style.setProperty('--pull', `${cardWidth - step}px`);
  area.style.setProperty('--card-w', `${cardWidth}px`);
  area.innerHTML = rows.map((r) => `<div class="row">${r.map(cardEl).join('')}</div>`).join('');
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
  return `<span class="my-info">${esc(me.name.replace(/\(机器人\)$/, ''))} ${me.cards ?? 0} 张 <span class="pts">${me.captured} 分</span>${place}</span>`;
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
  }
  const clear = state.selected.size ? '<button id="clearBtn" class="btn btn-ghost btn-sm">取消选择</button>' : '';
  $('actionBar').innerHTML = `${sort}${main}${clear}`;
}

function renderOverlay(v) {
  const overlay = $('overlay');
  let html = '';
  const mustReturn = v.phase === 'returning' && v.you && v.you.mustReturnTo !== null;
  if (mustReturn) {
    const to = playerAt(v.you.mustReturnTo);
    const one = state.selected.size === 1 ? [...state.selected][0] : null;
    html = `
      <div class="dialog">
        <h2>还一张牌给 ${esc(to.name.replace(/\(机器人\)$/, ''))}</h2>
        <p>对方刚向你上贡。从下方手牌里点一张还给他，超时会自动还最小的一张。</p>
        <div class="actions">
          <span class="timer" data-timer></span>
          <span class="note">${one ? '已选 1 张' : '还没选牌'}</span>
          <button id="returnBtn" class="btn btn-primary" ${one ? '' : 'disabled'}>还这张</button>
        </div>
      </div>`;
  } else if (v.phase === 'hand_over' || v.phase === 'match_over') {
    html = resultDialog(v);
  }
  overlay.hidden = !html;
  overlay.innerHTML = html;
  overlay.classList.toggle('passive', Boolean(mustReturn));
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
  const order = r ? r.ranking.map((seat) => `<span>${short(playerAt(seat))}</span>`).join('') : '';
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
  return `
    <div class="dialog" role="dialog" aria-label="${title}">
      <h2>${title}${r?.sweep ? ' <span class="sweep">完胜</span>' : ''}</h2>
      <div class="standings">${standings}</div>
      ${order ? `<div class="finish-order" aria-label="出完顺序">${order}</div>` : ''}
      ${penalties ? `<div class="penalty">${penalties}</div>` : ''}
      ${ratingLine}
      <div class="actions">
        ${over && v.matchId && state.account ? `<a class="btn" href="/replay/${v.matchId}" target="_blank" rel="noopener">看回放</a>` : ''}
        ${over
          ? (v.you?.isHost ? '<button id="restartBtn" class="btn btn-primary">回到大厅</button>' : '<span class="note">等待房主操作</span>')
          : `<span class="note">下一局 <span data-secs></span> 秒后开始</span>${v.you?.isHost ? '<button id="nextBtn" class="btn btn-primary">马上开始</button>' : ''}`}
      </div>
    </div>`;
}

// Countdown visuals update between server pushes.
function tick() {
  const left = timeLeft();
  const v = state.view;
  for (const el of document.querySelectorAll('[data-timer]')) {
    el.textContent = left ? left.secs : '';
    el.style.setProperty('--p', left ? left.fraction : 0);
  }
  for (const el of document.querySelectorAll('[data-secs]')) el.textContent = left ? left.secs : '';
  for (const el of document.querySelectorAll('[data-ring]')) {
    const active = v?.phase === 'playing' && Number(el.dataset.ring) === v.turn && left;
    el.style.setProperty('--p', active ? left.fraction : 0);
  }
}
setInterval(tick, 200);

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
    case 'restartBtn': run(() => api('/api/rooms/restart')); break;
    case 'clearBtn': state.selected.clear(); render(); break;
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
const roomFromUrl = new URL(location.href).searchParams.get('room');
if (roomFromUrl) {
  const code = roomFromUrl.toUpperCase();
  $('codeInput').value = code;
  const token = readSession(`token:${code}`);
  if (token) run(async () => enterRoom(await api('/api/rooms/join', { code, token })));
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
