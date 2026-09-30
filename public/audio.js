// Everything the table plays out loud: short chimes, spoken play calls and quiet background music.
// No sound files: chimes and music are made with Web Audio, and the voice is the phone's own
// Chinese text-to-speech. Browsers only allow sound after a tap, so unlock() runs on the first tap.

let ctx = null;
export function audioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { return null; }
  return ctx;
}

export function beep(notes, volume = 0.25) {
  const ac = audioContext();
  if (!ac) return;
  let t = ac.currentTime + 0.02;
  for (const [freq, secs] of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + secs);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t);
    osc.stop(t + secs + 0.05);
    t += secs * 0.8;
  }
}

// ---- voice ------------------------------------------------------------------

const synth = window.speechSynthesis;
let zhVoice = null;
let voicesKnown = false;
function pickVoice() {
  if (!synth) return;
  const voices = synth.getVoices() || [];
  voicesKnown = voices.length > 0;
  const zh = voices.filter((v) => /^(zh|cmn)[-_]?/i.test(v.lang));
  // Mainland Mandarin first; Taiwan or Cantonese voices still read the characters.
  zhVoice = zh.find((v) => /CN|Hans/i.test(v.lang)) || zh.find((v) => !/HK|yue/i.test(v.lang)) || zh[0] || null;
}
if (synth) {
  pickVoice();
  try { synth.addEventListener('voiceschanged', pickVoice); } catch { synth.onvoiceschanged = pickVoice; }
}

// False when the device has voices but none of them speaks Chinese: a foreign voice would only garble it.
export const voiceAvailable = () => !!synth && (!voicesKnown || !!zhVoice);

let speaking = 0;
export function speak(text) {
  if (!voiceAvailable() || !text) return;
  try {
    // A newer call replaces one still waiting, so fast bot plays never pile up behind each other.
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = zhVoice ? zhVoice.lang : 'zh-CN';
    if (zhVoice) u.voice = zhVoice;
    u.rate = 0.95;
    u.volume = 1;
    const done = () => { speaking = Math.max(0, speaking - 1); if (!speaking) duck(false); };
    u.onstart = () => { speaking += 1; duck(true); };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  } catch { /* speech not supported */ }
}

const RANK_WORD = {
  3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', T: '十', J: 'J', Q: 'Q', K: 'K', A: 'A', 2: '二',
  L: '小王', B: '大王',
};
const TYPE_WORD = {
  triple_pair: '三带二', straight: '顺子', pairs: '连对', triples: '连三',
  x510k: '五十K', p510k: '纯五十K', bomb: '炸弹', joker_bomb: '王炸',
};
// What to say for one seat's action: the card for singles, "对K" for pairs, else the play's name.
export function playWords(action) {
  if (action.pass) return '不要';
  const rank = RANK_WORD[action.cards?.[0]?.[0]] ?? '';
  if (action.type === 'single') return rank;
  if (action.type === 'pair') return `对${rank}`;
  if (action.type === 'triple') return `三个${rank}`;
  if (action.type === 'bomb') return `${action.cards.length}个${rank}，炸弹`;
  return TYPE_WORD[action.type] ?? '';
}

// ---- music ------------------------------------------------------------------

// A slow, soft melody on the pentatonic scale, like a plucked zither over a low drone. Each phrase is
// picked afresh with small steps, so it never loops the same bars but never jumps around either.
const SCALE = [0, 2, 4, 7, 9]; // C D E G A
const ROOT = 261.63; // middle C
const BEAT = 0.75; // seconds, 80 beats a minute
const MUSIC_VOLUME = 0.12;
const DUCKED = 0.3; // share of the music volume kept while the voice speaks

let musicBus = null;
let musicOn = false;
let timer = 0;
let nextTime = 0;
let step = 5; // index into the two-octave pentatonic ladder
let beatNo = 0;

const freqOf = (i) => ROOT * 2 ** ((Math.floor(i / 5) * 12 + SCALE[((i % 5) + 5) % 5]) / 12);

function bus() {
  const ac = audioContext();
  if (!ac) return null;
  if (!musicBus) {
    musicBus = ac.createGain();
    musicBus.gain.value = 0.0001;
    musicBus.connect(ac.destination);
  }
  return musicBus;
}

function pluck(freq, at, secs, volume) {
  const ac = audioContext();
  const out = bus();
  if (!ac || !out) return;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + secs);
  gain.connect(out);
  for (const [mult, type, share] of [[1, 'triangle', 1], [2, 'sine', 0.25]]) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq * mult, at);
    g.gain.value = share;
    osc.connect(g);
    g.connect(gain);
    osc.start(at);
    osc.stop(at + secs + 0.05);
  }
}

function scheduleBeat(at) {
  // Drone: a low root or fifth every two bars.
  if (beatNo % 8 === 0) pluck(ROOT / (beatNo % 16 === 0 ? 2 : 1.5), at, BEAT * 7, 0.5);
  // Melody: most beats get a note, every fourth beat of a phrase rests half the time.
  if (beatNo % 4 === 3 && Math.random() < 0.5) return;
  const move = [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)];
  step = Math.min(10, Math.max(2, step + move));
  // Phrases end back home on C or G.
  if (beatNo % 16 === 15) step = step >= 6 ? 5 : 3;
  const long = beatNo % 4 === 3 || Math.random() < 0.2;
  pluck(freqOf(step), at, long ? BEAT * 2.5 : BEAT * 1.4, 0.55);
  if (long && Math.random() < 0.3) pluck(freqOf(step + 2), at + BEAT / 2, BEAT * 1.6, 0.3);
}

function tick() {
  const ac = audioContext();
  if (!ac || !musicOn) return;
  // Timers slow down in background tabs; start fresh rather than rushing through missed beats.
  if (nextTime < ac.currentTime) nextTime = ac.currentTime + 0.1;
  while (nextTime < ac.currentTime + 1.2) {
    scheduleBeat(nextTime);
    nextTime += BEAT;
    beatNo += 1;
  }
}

function fade(target, secs) {
  const ac = audioContext();
  const out = bus();
  if (!ac || !out) return;
  out.gain.cancelScheduledValues(ac.currentTime);
  out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), ac.currentTime);
  out.gain.exponentialRampToValueAtTime(Math.max(0.0001, target), ac.currentTime + secs);
}

function duck(down) {
  if (musicOn) fade(down ? MUSIC_VOLUME * DUCKED : MUSIC_VOLUME, down ? 0.15 : 0.8);
}

// Turn the music on or off; safe to call on every render. It also rests while the page is hidden.
let musicWanted = false;
export function setMusic(wanted) {
  musicWanted = wanted;
  applyMusic();
}
document.addEventListener('visibilitychange', () => applyMusic());

function applyMusic() {
  const on = musicWanted && !document.hidden;
  if (on === musicOn) return;
  if (on && !audioContext()) return;
  musicOn = on;
  if (on) {
    beatNo = 0;
    nextTime = 0;
    fade(speaking ? MUSIC_VOLUME * DUCKED : MUSIC_VOLUME, 2);
    tick();
    timer = setInterval(tick, 300);
  } else {
    clearInterval(timer);
    fade(0.0001, 0.6);
  }
}

// Called from the first tap: iOS keeps speech locked until something is spoken inside a tap.
let unlocked = false;
export function unlock() {
  audioContext();
  if (unlocked || !synth) return;
  unlocked = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
  } catch { /* speech not supported */ }
}
