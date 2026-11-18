// Full-screen, click-through overlay that shows the AI at work:
// a glowing animated screen border, a status pill at the top, and ripples where it clicks.
const $ = (id) => document.getElementById(id);
const preview = !window.vc;
const bus = {};
const bridge = window.vc || { on: (ch, cb) => (bus[ch] = cb), emit: (ch, p) => bus[ch] && bus[ch](p) };
const root = document.documentElement;

// Same palettes as the orb.
const PALETTE = {
  idle:       ['#4f5bd5', '#7c5cff', '#1fb6d6', '#2a3a8f'],
  listening:  ['#2f7bff', '#00c6ff', '#7ef9ff', '#3b3bff'],
  thinking:   ['#8b5cf6', '#ec4899', '#6366f1', '#c084fc'],
  acting:     ['#10b981', '#22d3ee', '#a3e635', '#0e7490'],
  speaking:   ['#f472b6', '#a78bfa', '#60a5fa', '#fb7185'],
  confirming: ['#f59e0b', '#fb7185', '#fde68a', '#f97316'],
  error:      ['#ef4444', '#f97316', '#7f1d1d', '#fb7185'],
};
const SPIN = { listening: '5s', thinking: '2.2s', acting: '3s', speaking: '4s', confirming: '6s', error: '8s', idle: '8s' };
const LABEL = { listening: 'Listening…', thinking: 'Thinking…', acting: 'Working on it…', speaking: 'Speaking', confirming: 'Waiting for your OK', error: 'Something went wrong' };
const ACTIVE = new Set(['listening', 'thinking', 'acting', 'speaking', 'confirming', 'error']);

let state = 'idle';
let detail = '';

function setAction(text, shimmer) {
  const box = $('action');
  const old = box.querySelector('span:not(.out)');
  if (old && old.textContent === text) { old.classList.toggle('shimmer', !!shimmer); return; }
  const s = document.createElement('span');
  s.textContent = text;
  if (shimmer) s.classList.add('shimmer');
  s.classList.add('in');
  box.appendChild(s);
  void s.offsetWidth; // apply the start position, then slide in
  s.classList.remove('in');
  if (old) { old.classList.add('out'); setTimeout(() => old.remove(), 500); }
}

function render() {
  const colors = PALETTE[state] || PALETTE.idle;
  colors.forEach((c, i) => root.style.setProperty(`--c${i + 1}`, c));
  root.style.setProperty('--spin', SPIN[state] || '6s');
  document.body.classList.toggle('on', ACTIVE.has(state));
  const text = LABEL[state] || ''; // just the state; the details stay out of your way
  if (text) setAction(text, state === 'thinking' || state === 'acting');
  $('bars').style.display = state === 'listening' || state === 'speaking' ? 'flex' : 'none';
}

bridge.on('state', (s) => { state = s; render(); });
bridge.on('detail', (d) => { detail = d || ''; render(); });
bridge.on('config', ({ assistantName }) => { if (assistantName) $('brand').textContent = assistantName; });

// Voice / speech loudness drives the glow thickness and the bars.
const bars = [...document.querySelectorAll('#bars i')];
let target = 0, lv = 0;
bridge.on('level', (v) => (target = v));
let shownLv = -1;
function tick(now) {
  const voice = state === 'listening' || state === 'speaking';
  lv += ((voice ? target : 0) - lv) * 0.25;
  // Only touch the style when the level visibly changes (each change repaints the glow).
  if (Math.abs(lv - shownLv) > 0.02 || (lv < 0.01 && shownLv !== 0)) {
    shownLv = lv < 0.01 ? 0 : lv;
    root.style.setProperty('--lv', shownLv.toFixed(2));
  }
  if (voice) {
    bars.forEach((b, i) => { b.style.height = 3 + lv * 13 * (0.45 + 0.55 * Math.abs(Math.sin(now / 140 + i * 1.3))) + 'px'; });
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// A ripple + label wherever the AI clicks.
bridge.on('click', ({ x, y, label }) => {
  const r = document.createElement('div');
  r.className = 'ripple';
  r.style.left = x + 'px';
  r.style.top = y + 'px';
  r.innerHTML = '<i></i><i></i><b></b>' + (label ? `<em></em>` : '');
  if (label) r.querySelector('em').textContent = label;
  $('ripples').appendChild(r);
  setTimeout(() => r.remove(), 1700);
});

// ---------- demo when opened in a browser ----------
if (preview) {
  document.body.style.background = 'linear-gradient(135deg, #1d2333, #2b3550 60%, #1a1f2d)';
  const only = new URLSearchParams(location.search).get('state');
  const levels = () => setInterval(() => (target = state === 'listening' || state === 'speaking' ? Math.random() * 0.9 : 0), 120);
  levels();
  if (only) {
    bridge.emit('state', only);
    bridge.emit('detail', only === 'acting' ? 'Opening Claude' : only === 'thinking' ? 'Open Claude and start a new session' : '');
    if (only === 'acting') setInterval(() => bridge.emit('click', { x: innerWidth * 0.62, y: innerHeight * 0.55, label: 'Clicking New session' }), 1800);
  } else {
    const steps = [
      ['listening', ''], ['thinking', 'Open Claude and start a new session'], ['acting', 'Opening Claude'],
      ['acting', 'Clicking New session'], ['acting', 'Typing "build things for me"'], ['speaking', ''], ['idle', ''],
    ];
    let i = 0;
    const next = () => {
      const [s, d] = steps[i++ % steps.length];
      bridge.emit('detail', d); bridge.emit('state', s);
      if (d.startsWith('Clicking')) bridge.emit('click', { x: innerWidth * 0.6, y: innerHeight * 0.5, label: d });
      setTimeout(next, s === 'idle' ? 1500 : 2600);
    };
    next();
  }
}
