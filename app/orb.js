const $ = (id) => document.getElementById(id);
const preview = !window.vc; // opened directly in a browser: run a demo instead of the real app
const bus = {};
const bridge = window.vc || { on: (ch, cb) => (bus[ch] = cb), emit: (ch, p) => bus[ch] && bus[ch](p), audio() {},speakDone() {}, typed() {}, confirm() {}, orbClick() {}, stop() {}, log: console.log, setInteractive() {}, quit() {}, menu() {}, visual() {}, level() {} };

const card = $('card');
Orb.mount($('orb'));

// ---------- state ----------
const LABELS = {
  idle: 'Say “Hey Computer”',
  paused: 'Wake word paused',
  listening: 'Listening',
  thinking: 'Thinking',
  acting: 'Working',
  speaking: 'Speaking',
  confirming: 'Needs your OK',
  error: 'Something went wrong',
};
const ANIMATED_DOTS = new Set(['listening', 'thinking', 'acting']);
let mainStatus = 'idle';   // what the app says
let speaking = false;      // TTS currently playing
let shown = '';            // what the UI currently shows
let hideTimer;

function visualState() {
  if (mainStatus === 'listening') return 'listening'; // your voice always wins
  if (speaking) return 'speaking';
  return mainStatus;
}

function setLabel(text, dots) {
  const box = $('label');
  const old = box.querySelector('span:not(.out)');
  if (old && old.textContent === text && old.classList.contains('dots') === dots) return;
  const s = document.createElement('span');
  s.textContent = text;
  if (dots) s.className = 'dots';
  s.classList.add('in');
  box.appendChild(s);
  void s.offsetWidth; // apply the start position, then slide in
  s.classList.remove('in');
  if (old) { old.classList.add('out'); setTimeout(() => old.remove(), 500); }
}

function render() {
  const st = visualState();
  if (st === shown) return;
  shown = st;
  Orb.setState(st);
  bridge.visual(st);
  setLabel(LABELS[st] || st, ANIMATED_DOTS.has(st));
  const c = Orb.STATES[st]?.colors[0] || '#7c5cff';
  card.style.setProperty('--tint', c + '44');
  card.style.setProperty('--tint-solid', c);
  $('dot').style.background = c;
  if (st === 'idle' || st === 'paused') scheduleHide(7000);
  else showCard();
}

function showCard() {
  clearTimeout(hideTimer);
  card.classList.remove('hidden');
}
function scheduleHide(ms) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (document.activeElement !== $('typed') && !card.matches(':hover')) card.classList.add('hidden');
  }, ms);
}

// ---------- chat: your messages and Nova's, in full, scrollable ----------
const chat = $('chat');
const MAX_MESSAGES = 40;
let liveYou = null; // your bubble while you're still talking
let typeTimer;

/** Keep the newest message in view, unless you've scrolled up to read something. */
let stick = true;
chat.addEventListener('scroll', () => { stick = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 12; });
function scrollDown() { if (stick) chat.scrollTop = chat.scrollHeight; }

function addMessage(who, text) {
  const m = document.createElement('div');
  m.className = 'msg ' + who;
  m.textContent = text || '';
  chat.appendChild(m);
  while (chat.children.length > MAX_MESSAGES) chat.firstElementChild.remove();
  stick = true;
  scrollDown();
  showCard();
  return m;
}

/** Your words: updated live while you speak, then finalised when the command runs. */
function showYou(text, final) {
  if (!text) return;
  if (!liveYou) liveYou = addMessage('you', text);
  else { liveYou.textContent = text; scrollDown(); }
  if (final) liveYou = null;
}

// Nova's reply appears word by word, roughly in step with her voice.
let typing = null; // { el, text } of the reply still being revealed
function typeReply(text) {
  clearInterval(typeTimer);
  if (typing) typing.el.textContent = typing.text; // finish the previous reply instantly
  liveYou = null;
  const m = addMessage('nova', '');
  typing = { el: m, text: text || '' };
  const words = (text || '').split(/(\s+)/);
  let i = 0;
  typeTimer = setInterval(() => {
    m.textContent += words.slice(i, i + 2).join('');
    i += 2;
    scrollDown();
    if (i >= words.length) { clearInterval(typeTimer); typing = null; }
  }, 70);
}

// ---------- events from the app ----------
bridge.on('status', ({ status, detail, conversation }) => {
  mainStatus = status;
  // Only the listening hint and "Next: …" are shown; what it's doing step by step stays hidden.
  $('detail').textContent = status === 'listening' ? detail || '' : '';
  card.classList.toggle('convo', !!conversation && status !== 'idle' && status !== 'paused');
  render();
});
bridge.on('transcript', (t) => showYou(t, true));
bridge.on('heard', (t) => { if (mainStatus === 'confirming') showYou(t, true); });
// Your words appear as you speak (one phrase at a time), before the command runs.
bridge.on('transcript-live', (t) => showYou(t, false));
bridge.on('queued', (t) => { $('detail').textContent = `Next: ${t}`; });
bridge.on('tts', (cmd) => {
  if (cmd === 'pause') { speechSynthesis.pause(); playCtx?.suspend(); }
  else if (cmd === 'resume') { speechSynthesis.resume(); playCtx?.resume(); }
  else if (cmd === 'cancel') { speechSynthesis.cancel(); stopPlayer(true); }
});

// ---------- in-app voice player (Piper audio from the voice process) ----------
// Played through this page's audio, so the browser's echo cancellation removes it from the mic.
let playCtx, playAn, playBuf, playId = -1, nextAt = 0, sources = [], gotLast = false;
function ensurePlayer() {
  if (!playCtx) {
    playCtx = new AudioContext();
    playAn = playCtx.createAnalyser();
    playAn.fftSize = 1024;
    playBuf = new Float32Array(playAn.fftSize);
    playAn.connect(playCtx.destination);
  }
  if (playCtx.state === 'suspended') playCtx.resume();
}
function finishPlayback() {
  if (playId < 0) return;
  playId = -1;
  speaking = false;
  render();
  bridge.speakDone();
}
function stopPlayer(report) {
  for (const src of sources) { try { src.onended = null; src.stop(); } catch {} }
  sources = [];
  if (report) finishPlayback();
}
bridge.on('tts-start', ({ id }) => { stopPlayer(false); playId = id; gotLast = false; nextAt = 0; ensurePlayer(); });
bridge.on('tts-chunk', ({ id, samples, sampleRate, last }) => {
  if (id !== playId) return;
  const data = samples instanceof Float32Array ? samples : new Float32Array(samples);
  if (data.length) {
    const buf = playCtx.createBuffer(1, data.length, sampleRate);
    buf.copyToChannel(data, 0);
    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(playAn);
    const at = Math.max(playCtx.currentTime + 0.03, nextAt); // queue sentences back to back
    src.start(at);
    nextAt = at + buf.duration;
    sources.push(src);
    src.onended = () => { sources = sources.filter((x) => x !== src); if (gotLast && sources.length === 0) finishPlayback(); };
    if (!speaking) { speaking = true; speechStart = performance.now(); render(); }
  }
  if (last) { gotLast = true; if (sources.length === 0) finishPlayback(); }
});
function playerLevel() {
  playAn.getFloatTimeDomainData(playBuf);
  let sum = 0;
  for (let i = 0; i < playBuf.length; i++) sum += playBuf[i] * playBuf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / playBuf.length) + 1e-9);
  return Math.max(0, Math.min(1, (db + 45) / 32));
}
bridge.on('reply', (t) => { typeReply(t); showCard(); });
bridge.on('vad', (on) => { voiceActive = on; });
bridge.on('confirm', (q) => {
  $('confirm').classList.toggle('show', !!q);
  if (q) { typeReply(q); showCard(); }
});
bridge.on('config', ({ hotkey, assistantName }) => {
  if (hotkey) $('hk').textContent = hotkey.replace('Control', 'Ctrl');
  if (assistantName) { LABELS.idle = `Say “Hello ${assistantName}”`; shown = ''; render(); }
});

// ---------- speaking (free Windows voices) ----------
let speechEnv = 0, speechStart = 0;
function speak(text, voiceName, onDone) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const v = voices.find((x) => voiceName && x.name.toLowerCase().includes(voiceName.toLowerCase()))
    || voices.find((x) => /natural/i.test(x.name) && /^en/i.test(x.lang))
    || voices.find((x) => /^en/i.test(x.lang));
  if (v) u.voice = v;
  u.rate = 1.05;
  u.onstart = () => { speaking = true; speechStart = performance.now(); render(); };
  u.onboundary = () => { speechEnv = 0.75 + Math.random() * 0.25; };   // a kick on every word
  u.onend = u.onerror = () => { speaking = false; render(); onDone && onDone(); };
  speechSynthesis.speak(u);
}
bridge.on('speak', ({ text, voice }) => speak(text, voice, () => bridge.speakDone()));

// ---------- chime when it starts listening ----------
let actx;
function chime() {
  try {
    actx = actx || new AudioContext();
    const now = actx.currentTime;
    [[523.25, 0], [783.99, 0.07]].forEach(([f, d]) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + d);
      g.gain.exponentialRampToValueAtTime(0.12, now + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + d + 0.35);
      o.connect(g).connect(actx.destination);
      o.start(now + d); o.stop(now + d + 0.4);
    });
  } catch {}
}
bridge.on('chime', chime);

// ---------- microphone ----------
let analyser, micBuf, voiceActive = false;
async function startMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule('mic-worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'mic-capture');
    node.port.onmessage = (e) => bridge.audio(e.data);
    src.connect(node);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    micBuf = new Float32Array(analyser.fftSize);
    src.connect(analyser);
    bridge.log('mic started', stream.getAudioTracks()[0]?.label);
  } catch (e) {
    bridge.log('mic error', String(e));
    mainStatus = 'error';
    render();
    typeReply('Microphone not available: ' + e.message);
  }
}

function micLevel() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(micBuf);
  let sum = 0;
  for (let i = 0; i < micBuf.length; i++) sum += micBuf[i] * micBuf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / micBuf.length) + 1e-9);
  return Math.max(0, Math.min(1, (db + 58) / 38)); // ~-58 dB floor → 0, ~-20 dB → 1
}

// ---------- per-frame level routing + mini equalizer ----------
const bars = [...document.querySelectorAll('#eq i')];
const barLv = bars.map(() => 0);
let lastLevelSent = 0;
function tick(now) {
  const st = visualState();
  let lv = 0;
  if (st === 'listening' || st === 'confirming') lv = micLevel();
  else if (st === 'speaking' && sources.length) {
    lv = playerLevel(); // the real voice loudness
  } else if (st === 'speaking') {
    // Windows speech fallback: synthetic envelope (word kicks + syllable wobble).
    speechEnv *= 0.9;
    const s = (now - speechStart) / 1000;
    lv = Math.min(1, 0.22 + speechEnv * 0.55 + 0.18 * Math.abs(Math.sin(s * 11.3) * Math.sin(s * 4.1 + 1)));
  } else if (st === 'idle') lv = micLevel() * 0.35;
  Orb.setLevel(lv);
  if (now - lastLevelSent > 50) { lastLevelSent = now; bridge.level(Math.round(lv * 100) / 100); }

  const active = st === 'listening' || st === 'speaking' || st === 'confirming';
  bars.forEach((b, i) => {
    const wob = active ? lv * (0.55 + 0.45 * Math.abs(Math.sin(now / 130 + i * 1.7))) : (st === 'thinking' || st === 'acting') ? 0.18 + 0.12 * Math.sin(now / 220 + i * 0.9) : 0.08;
    barLv[i] += (wob - barLv[i]) * 0.35;
    b.style.height = 4 + barLv[i] * 14 + 'px';
  });
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- controls ----------
$('orb').addEventListener('click', () => { showCard(); chime(); bridge.orbClick(); });
$('close').addEventListener('click', () => card.classList.add('hidden'));
$('quit').addEventListener('click', () => bridge.quit());
$('orb').addEventListener('contextmenu', (e) => { e.preventDefault(); bridge.menu(); });
$('yes').addEventListener('click', () => bridge.confirm(true));
$('no').addEventListener('click', () => bridge.confirm(false));
$('typed').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) { bridge.typed(e.target.value.trim()); e.target.value = ''; }
  if (e.key === 'Escape') bridge.stop();
});
card.addEventListener('mouseenter', showCard);
card.addEventListener('mouseleave', () => { if (shown === 'idle' || shown === 'paused') scheduleHide(2500); });

// Let clicks pass through the transparent parts of the window to the apps underneath.
let interactive = null;
document.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  let hit = !!(el && el.closest('.hit') && !card.classList.contains('hidden'));
  if (!hit) {
    const r = $('orb').getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    hit = Math.hypot(dx, dy) < r.width * 0.32;
  }
  if (hit !== interactive) { interactive = hit; bridge.setInteractive(hit); }
});

speechSynthesis.getVoices();
render();
if (!preview) startMic();

// ---------- demo when previewed outside the app ----------
if (preview) {
  document.body.style.background = 'radial-gradient(circle at 30% 20%, #2b3a55, #11131c)';
  let fake = 0;
  micLevel = () => (shown === 'listening' ? (fake = fake * 0.8 + Math.random() * 0.35 * (Math.sin(performance.now() / 300) > -0.3 ? 1 : 0.1)) : 0.02);
  const steps = [
    () => { bridge.emit('status', { status: 'idle' }); },
    () => { chime(); bridge.emit('status', { status: 'listening', conversation: true, detail: 'Just talk — say “that’s all” when you’re done' }); },
    () => { bridge.emit('transcript', 'Open Claude and start a new session'); bridge.emit('status', { status: 'thinking', detail: 'Open Claude and start a new session' }); },
    () => { bridge.emit('status', { status: 'acting', detail: 'Opening Claude' }); },
    () => { bridge.emit('status', { status: 'confirming' }); bridge.emit('confirm', 'I\'m about to click "Send". Should I go ahead?'); },
    () => { bridge.emit('confirm', null); bridge.emit('status', { status: 'idle' }); speaking = true; speechStart = performance.now(); render(); bridge.emit('reply', 'Done — Claude is open with a new session.'); const k = setInterval(() => (speechEnv = 0.8 + Math.random() * 0.2), 260); setTimeout(() => { clearInterval(k); speaking = false; render(); }, 3200); },
  ];
  const only = new URLSearchParams(location.search).get('state');
  if (only) {
    // ?state=thinking etc. pins one state (used for screenshots)
    if (only === 'speaking') { speaking = true; setInterval(() => (speechEnv = 0.8 + Math.random() * 0.2), 260); }
    bridge.emit('status', { status: only === 'speaking' ? 'idle' : only, detail: only === 'acting' ? 'Opening Claude' : only === 'listening' ? 'Just talk — say “that’s all” when you’re done' : '', conversation: only !== 'idle' });
    bridge.emit('transcript', 'Open Claude and start a new session');
    if (only === 'confirming') bridge.emit('confirm', 'I\'m about to click "Send". Should I go ahead?');
    showCard();
    clearTimeout(hideTimer);
  } else {
    let i = 0;
    const next = () => { steps[i++ % steps.length](); setTimeout(next, i % steps.length === 1 ? 4500 : 3600); };
    next();
  }
}
