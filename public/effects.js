// Table effects: short, self-removing DOM animations layered over the felt.
// Strength follows the play: normal < 510K < bomb < big bomb (6+) < joker bomb.
// With reduced motion only the text stamps remain (no shake, rings or sparks).

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const BIG_BOMB_LEVEL = 6;

export class Effects {
  constructor(layer, stage) {
    this.layer = layer; // absolutely positioned over the table stage
    this.stage = stage; // element that shakes
  }

  spawn(className, { x = 50, y = 50, html = '', ms = 1200, vars = {} } = {}) {
    const el = document.createElement('div');
    el.className = `fx ${className}`;
    el.style.setProperty('--x', `${x}%`);
    el.style.setProperty('--y', `${y}%`);
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
    el.innerHTML = html;
    this.layer.append(el);
    setTimeout(() => el.remove(), ms);
    return el;
  }

  shake(strength) {
    if (reducedMotion()) return;
    this.stage.classList.remove('shake-md', 'shake-lg', 'shake-xl');
    void this.stage.offsetWidth; // restart the animation
    this.stage.classList.add(`shake-${strength}`);
    clearTimeout(this.shakeTimer);
    this.shakeTimer = setTimeout(() => this.stage.classList.remove(`shake-${strength}`), 900);
  }

  sparks(x, y, count, palette) {
    if (reducedMotion()) return;
    const bits = Array.from({ length: count }, (_, i) => {
      const angle = (360 / count) * i + Math.random() * 12;
      const dist = 60 + Math.random() * 110;
      const color = palette[i % palette.length];
      return `<i style="--a:${angle}deg;--d:${dist}px;--c:${color};--t:${0.5 + Math.random() * 0.4}s"></i>`;
    }).join('');
    this.spawn('fx-sparks', { x, y, html: bits, ms: 1100 });
  }

  ring(x, y, kind, delay = 0) {
    if (reducedMotion()) return;
    this.spawn(`fx-ring fx-ring-${kind}`, { x, y, ms: 1200 + delay, vars: { '--delay': `${delay}ms` } });
  }

  stamp(text, kind) {
    this.spawn(`fx-stamp fx-stamp-${kind}`, { html: `<span>${text}</span>`, ms: kind === 'king' ? 1900 : 1400 });
  }

  // A play landed at (x, y), in percent of the table stage.
  play({ type, level, x, y }) {
    if (type === 'x510k' || type === 'p510k') {
      const pure = type === 'p510k';
      this.ring(x, y, pure ? 'pure' : 'gold');
      this.sparks(x, y, pure ? 14 : 8, ['#ffd36a', '#fff3c4']);
      this.stamp(pure ? '纯 510K' : '510K', pure ? 'pure' : 'gold');
    } else if (type === 'bomb') {
      const big = level >= BIG_BOMB_LEVEL;
      this.shake(big ? 'lg' : 'md');
      this.ring(x, y, 'fire');
      if (big) {
        this.ring(x, y, 'fire', 160);
        this.spawn('fx-flash', { ms: 700 });
      }
      this.sparks(x, y, big ? 30 : 16, ['#ff7a3d', '#ffc14d', '#fff1c9', '#ff4d4d']);
      this.stamp(`${level} 炸`, big ? 'bigbomb' : 'bomb');
    } else if (type === 'joker_bomb') {
      this.shake('xl');
      this.spawn('fx-dim', { ms: 1700 });
      this.spawn('fx-flash fx-flash-king', { ms: 900 });
      this.ring(x, y, 'king');
      this.ring(x, y, 'king', 200);
      this.ring(50, 50, 'king', 380);
      this.sparks(x, y, 44, ['#ff3d6e', '#ffb800', '#3dffb0', '#3db4ff', '#b43dff', '#ffffff']);
      this.stamp('王炸', 'king');
    }
  }

  points({ x, y, points }) {
    this.spawn('fx-points', { x, y, html: `+${points}<small>分</small>`, ms: 1300 });
  }

  banner(text) {
    this.spawn('fx-banner', { html: `<span>${text}</span>`, ms: 1800 });
  }
}
