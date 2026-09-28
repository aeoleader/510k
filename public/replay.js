import { createHandState, apply } from '/engine/game.js';
import { sumPoints } from '/engine/cards.js';
import { sortBySize } from '/engine/sort.js';
import { esc, cardHtml, fanHtml, badgeHtml, initial, shortName, TYPE_LABEL } from '/ui.js';

const TAGS = {
  big_bomb: '大炸', big_trick: '大墩', steal: '截胡', gift: '送分', team_bomb: '误炸队友',
  auto: '超时托管', sweep: '完胜', resisted: '抗贡',
};
const STEP_MS = 900;
const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  handIdx: 0,
  hand: null, // prepared hand: { states, snaps, leads, markers }
  step: 0,
  view: 'all', // 'all' or a seat number
  playing: false,
  speed: 1,
  timer: null,
};

function readToken() {
  try { return localStorage.getItem('510k:accountToken'); } catch { return null; }
}

async function load() {
  const id = Number(location.pathname.match(/^\/replay\/(\d+)$/)?.[1] ?? new URL(location.href).searchParams.get('id'));
  if (!Number.isInteger(id)) {
    $('status').textContent = '回放地址不正确。';
    return;
  }
  const res = await fetch('/api/matches/replay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountToken: readToken() ?? undefined, matchId: id }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const text = payload.error === 'login_required' ? '登录后才能查看回放，请先回到首页登录。' : payload.error === 'no_match' ? '找不到这一轮对局。' : '加载失败，请刷新重试。';
    $('status').textContent = text;
    return;
  }
  state.data = payload;
  if (!payload.hands.length) {
    $('status').textContent = '这一轮没有回放记录（回放功能上线前打的对局，或记录不完整）。';
    return;
  }
  selectHand(0);
}

// Re-run a stored hand with the engine, keeping a snapshot of what the table shows after each step.
function prepare(h) {
  const d = state.data;
  let s = createHandState({ hands: h.initialHands, teams: d.teams, leader: h.leader, decks: d.decks });
  const states = [s];
  const snaps = [{ acts: {}, closed: false, top: null, trickCards: [], lastTrick: null }];
  const leads = [];
  const seqToStep = new Map();
  h.actions.forEach((action, i) => {
    const prev = snaps[i];
    if (!s.trick) leads.push(i + 1);
    const r = apply(s, { seat: action.seat, type: action.type, cards: action.cards, auto: action.auto });
    s = r.state;
    const snap = {
      acts: prev.closed ? {} : { ...prev.acts },
      closed: false,
      top: prev.closed ? null : prev.top,
      trickCards: prev.closed ? [] : [...prev.trickCards],
      lastTrick: prev.lastTrick,
    };
    for (const e of r.events) {
      seqToStep.set(e.seq, i + 1);
      if (e.type === 'play') {
        snap.acts[e.seat] = { cards: e.cards, type: e.combo.type, auto: e.auto };
        snap.top = { seat: e.seat, type: e.combo.type };
        snap.trickCards.push(...e.cards);
      } else if (e.type === 'pass') snap.acts[e.seat] = { pass: true, auto: e.auto };
      else if (e.type === 'trick') {
        snap.closed = true;
        snap.lastTrick = { seat: e.seat, points: e.points };
      }
    }
    states.push(s);
    snaps.push(snap);
  });
  const markers = h.highlights.map((hl) => ({ ...hl, step: hl.eventSeq < 0 ? h.actions.length : seqToStep.get(hl.eventSeq) ?? 0 }));
  return { states, snaps, leads, markers, actions: h.actions };
}

function selectHand(i) {
  stop();
  state.handIdx = i;
  state.hand = prepare(state.data.hands[i]);
  state.step = 0;
  state.controlsFor = null; // rebuild the control bar for this hand
  render();
}

function go(step) {
  const max = state.hand.states.length - 1;
  state.step = Math.max(0, Math.min(max, step));
  if (state.step === max) stop();
  render();
}

function play() {
  if (state.step >= state.hand.states.length - 1) state.step = 0;
  state.playing = true;
  clearInterval(state.timer);
  state.timer = setInterval(() => go(state.step + 1), STEP_MS / state.speed);
  renderControls();
}

function stop() {
  state.playing = false;
  clearInterval(state.timer);
}

const nextLead = () => state.hand.leads.find((l) => l > state.step) ?? state.hand.states.length - 1;
const prevLead = () => [...state.hand.leads].reverse().find((l) => l < state.step) ?? 0;

// ---- rendering ---------------------------------------------------------------------------

function render() {
  const d = state.data;
  const h = d.hands[state.handIdx];
  const main = $('replayView');
  if (!main.dataset.ready) {
    main.dataset.ready = '1';
    main.innerHTML = `
      <section class="replay-head" id="head"></section>
      <nav class="hand-tabs" id="handTabs" aria-label="选择局"></nav>
      <div class="replay-body">
        <section class="replay-table" id="table" aria-live="polite"></section>
        <aside class="replay-side" id="side"></aside>
      </div>
      <section class="replay-controls" id="controls"></section>`;
    renderHead();
  }
  $('handTabs').innerHTML = d.hands.map((hand, i) => {
    const w = hand.result.winner;
    const cls = [i === state.handIdx ? 'active' : '', d.teams && w !== null ? `win-${w}` : ''].join(' ');
    return `<button type="button" class="${cls}" data-hand="${i}">第 ${hand.handNo + 1} 局${hand.result.sweep ? '<small>完胜</small>' : ''}</button>`;
  }).join('');
  renderTable(h);
  renderSide(h);
  renderControls();
}

function renderHead() {
  const d = state.data;
  const when = new Date(d.endedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const sides = d.teams ? [0, 1] : d.players.map((p) => p.seat);
  const label = (side) => (d.teams
    ? d.players.filter((p) => p.team === side).map((p) => esc(shortName(p.name))).join('、')
    : esc(shortName(d.players[side].name)));
  const best = Math.max(...d.totals);
  $('head').innerHTML = `
    <div class="replay-meta">${when}，${d.playerCount} 人 ${d.decks} 副牌，${d.teams ? '组队' : '各自为战'}</div>
    <div class="replay-scores">${sides.map((side) => `
      <span class="team-score ${d.totals[side] === best ? 'lead' : ''}" style="--team-color:${d.teams ? `var(--team-${side})` : 'var(--muted)'}">
        <span class="num">${d.totals[side]}</span><span class="who">${label(side)}</span>
      </span>`).join('')}</div>
    <label class="view-pick">视角
      <select id="viewSelect">
        <option value="all">上帝视角（看所有手牌）</option>
        ${d.players.map((p) => `<option value="${p.seat}">${esc(shortName(p.name))}</option>`).join('')}
      </select>
    </label>`;
}

function renderTable(h) {
  const d = state.data;
  const s = state.hand.states[state.step];
  const snap = state.hand.snaps[state.step];
  const turn = s.over ? -1 : s.turn;
  const rows = d.players.map((p) => {
    const act = snap.acts[p.seat];
    const visible = state.view === 'all' || Number(state.view) === p.seat;
    const hand = s.hands[p.seat];
    const cards = visible
      ? (hand.length ? `<div class="fan mini-hand">${sortBySize(hand).map((c) => cardHtml(c, { size: 'sm' })).join('')}</div>` : '<span class="muted">已出完</span>')
      : `<span class="muted">${hand.length} 张</span>`;
    const place = s.finished.indexOf(p.seat) + 1;
    const actHtml = act
      ? (act.pass ? '<span class="pass-tag">不要</span>' : `${fanHtml(act.cards, 'sm')}<span class="act-type">${TYPE_LABEL[act.type] ?? ''}</span>`)
      : '';
    return `
      <div class="replay-row ${turn === p.seat ? 'is-turn' : ''} ${snap.top?.seat === p.seat && !snap.closed ? 'is-top' : ''}">
        <div class="who">
          <span class="avatar ${p.isBot ? 'bot' : ''}" style="${d.teams ? `--team-color: var(--team-${p.team});` : ''}--size:34px">${esc(initial(p.name))}</span>
          <div>
            <div class="name">${esc(shortName(p.name))}${place ? ` <span class="place">${place === 1 ? '头游' : `第 ${place}`}</span>` : ''}</div>
            <div class="stats"><span>${hand.length} 张</span><span class="pts">${s.captured[p.seat]} 分</span>${act?.auto ? '<span>托管</span>' : ''}</div>
          </div>
        </div>
        <div class="act">${actHtml}</div>
        <div class="cards">${cards}</div>
      </div>`;
  }).join('');
  const trickPts = s.trick ? sumPoints(s.trick.cards) : 0;
  let info;
  if (state.step === 0) info = `${esc(shortName(d.players[h.leader].name))} 先出`;
  else if (s.over) info = '本局结束';
  else if (snap.closed && snap.lastTrick) info = `${esc(shortName(d.players[snap.lastTrick.seat].name))} 收下 ${snap.lastTrick.points} 分`;
  else if (snap.top) info = `${esc(shortName(d.players[snap.top.seat].name))} 的 ${TYPE_LABEL[snap.top.type] ?? ''} 最大，桌面 ${trickPts} 分`;
  else info = '';
  const tribute = state.step === 0 ? tributeNote(h) : '';
  $('table').innerHTML = `<div class="replay-info">${info}${tribute}</div>${rows}${s.over ? resultNote(h) : ''}`;
}

function tributeNote(h) {
  const d = state.data;
  const t = h.tribute;
  if (t.resisted) return '<div class="tribute-note">抗贡：本局免贡</div>';
  if (!t.given.length) return '';
  const name = (seat) => esc(shortName(d.players[seat].name));
  const lines = t.given.map((g) => {
    const back = t.returns.find((r) => r.from === g.to && r.to === g.from);
    return `${name(g.from)} 贡 ${fanHtml([g.card], 'sm')} 给 ${name(g.to)}${back?.card ? `，还 ${fanHtml([back.card], 'sm')}` : ''}`;
  });
  return `<div class="tribute-note">${lines.join('<br>')}</div>`;
}

function resultNote(h) {
  const d = state.data;
  const r = h.result;
  const sides = d.teams ? [0, 1] : d.players.map((p) => p.seat);
  const label = (side) => (d.teams ? (side === 0 ? '蓝队' : '红队') : esc(shortName(d.players[side].name)));
  const pen = r.penalties.map((p) => `${label(p.from)} 罚 ${p.amount} 分`).join('，');
  return `<div class="replay-result">本局得分：${sides.map((side) => `${label(side)} ${r.score[side]}`).join('，')}${r.sweep ? '，完胜' : ''}${pen ? `。${pen}` : ''}</div>`;
}

function renderSide() {
  const d = state.data;
  const markers = state.hand.markers;
  $('side').innerHTML = `
    <h2>关键手</h2>
    ${markers.length ? `<ol class="highlight-list">${markers.map((m, i) => `
      <li><button type="button" data-marker="${i}" class="${m.step === state.step ? 'active' : ''}">
        <span class="tag tag-${m.tag}">${TAGS[m.tag] ?? m.tag}</span>
        <span>${m.seats.map((seat) => esc(shortName(d.players[seat].name))).join(' / ')}${m.points ? `，${m.points} 分` : ''}</span>
      </button></li>`).join('')}</ol>` : '<p class="muted">这一局没有关键手。</p>'}`;
}

// The control bar is built once per hand; stepping only updates values, so a slider drag,
// keyboard focus and hover survive autoplay.
function renderControls() {
  const max = state.hand.states.length - 1;
  if (state.controlsFor !== state.handIdx) {
    state.controlsFor = state.handIdx;
    const markers = state.hand.markers.map((m) => `<i class="marker tag-${m.tag}" style="left:${max ? (m.step / max) * 100 : 0}%" title="${TAGS[m.tag] ?? m.tag}"></i>`).join('');
    $('controls').innerHTML = `
      <div class="timeline">
        <input id="scrub" type="range" min="0" max="${max}" value="0" aria-label="回放进度">
        <div class="markers" aria-hidden="true">${markers}</div>
      </div>
      <div class="control-row">
        <button type="button" class="btn btn-ghost btn-sm" data-go="prevLead">上一墩</button>
        <button type="button" class="btn btn-ghost btn-sm" data-go="prev">上一步</button>
        <button type="button" class="btn btn-primary" data-go="toggle" id="playBtn">播放</button>
        <button type="button" class="btn btn-ghost btn-sm" data-go="next">下一步</button>
        <button type="button" class="btn btn-ghost btn-sm" data-go="nextLead">下一墩</button>
        <span class="segmented" role="group" aria-label="播放速度">
          ${[1, 2, 4].map((sp) => `<button type="button" data-speed="${sp}">${sp}×</button>`).join('')}
        </span>
        <span class="step-label" id="stepLabel"></span>
      </div>`;
  }
  const scrub = $('scrub');
  if (document.activeElement !== scrub || !scrubbing) scrub.value = String(state.step);
  $('playBtn').textContent = state.playing ? '暂停' : '播放';
  for (const b of document.querySelectorAll('[data-speed]')) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === state.speed));
  const action = state.step > 0 ? state.hand.actions[state.step - 1] : null;
  $('stepLabel').textContent = `${state.step} / ${max}${action ? `，用时 ${(action.elapsedMs / 1000).toFixed(1)} 秒` : ''}`;
}

let scrubbing = false;

// ---- events --------------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.hand) selectHand(Number(b.dataset.hand));
  else if (b.dataset.marker) { stop(); go(state.hand.markers[Number(b.dataset.marker)].step); }
  else if (b.dataset.speed) {
    state.speed = Number(b.dataset.speed);
    if (state.playing) play();
    else renderControls();
  } else if (b.dataset.go) {
    const go_ = b.dataset.go;
    if (go_ === 'toggle') { if (state.playing) { stop(); renderControls(); } else play(); return; }
    stop();
    if (go_ === 'prev') go(state.step - 1);
    else if (go_ === 'next') go(state.step + 1);
    else if (go_ === 'prevLead') go(prevLead());
    else if (go_ === 'nextLead') go(nextLead());
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'scrub') return;
  scrubbing = true;
  stop();
  go(Number(e.target.value));
});
document.addEventListener('change', (e) => { if (e.target.id === 'scrub') scrubbing = false; });

document.addEventListener('change', (e) => {
  if (e.target.id === 'viewSelect') { state.view = e.target.value; render(); }
});

document.addEventListener('keydown', (e) => {
  if (!state.hand || e.target.closest('input, select')) return;
  if (e.key === 'ArrowRight') { stop(); go(state.step + 1); }
  else if (e.key === 'ArrowLeft') { stop(); go(state.step - 1); }
  else if (e.key === ' ') { e.preventDefault(); if (state.playing) { stop(); renderControls(); } else play(); }
});

load();
