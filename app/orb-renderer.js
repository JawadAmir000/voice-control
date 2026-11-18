// Audio-reactive orb, drawn on a <canvas> every frame.
// Every visual parameter eases toward the current state's target, so state changes
// feel continuous rather than switched. Exposes window.Orb = { setState, setLevel, pulse }.
(() => {
  const STATES = {
    idle:       { colors: ['#4f5bd5', '#7c5cff', '#1fb6d6', '#2a3a8f'], speed: 0.22, amp: 0.018, glow: 0.22, swirl: 0, ring: 0, sat: 0.75 },
    paused:     { colors: ['#4b4f63', '#5d6075', '#3a3d4d', '#2b2d38'], speed: 0.10, amp: 0.008, glow: 0.08, swirl: 0, ring: 0, sat: 0.3 },
    listening:  { colors: ['#2f7bff', '#00c6ff', '#7ef9ff', '#3b3bff'], speed: 0.55, amp: 0.035, glow: 0.55, swirl: 0, ring: 0, sat: 1 },
    thinking:   { colors: ['#8b5cf6', '#ec4899', '#6366f1', '#c084fc'], speed: 1.35, amp: 0.03, glow: 0.45, swirl: 1, ring: 0, sat: 1 },
    acting:     { colors: ['#10b981', '#22d3ee', '#a3e635', '#0e7490'], speed: 1.0, amp: 0.028, glow: 0.45, swirl: 0.35, ring: 1, sat: 1 },
    speaking:   { colors: ['#f472b6', '#a78bfa', '#60a5fa', '#fb7185'], speed: 0.8, amp: 0.03, glow: 0.5, swirl: 0, ring: 0, sat: 1 },
    confirming: { colors: ['#f59e0b', '#fb7185', '#fde68a', '#f97316'], speed: 0.5, amp: 0.03, glow: 0.5, swirl: 0, ring: 0, sat: 1 },
    error:      { colors: ['#ef4444', '#f97316', '#7f1d1d', '#fb7185'], speed: 0.4, amp: 0.02, glow: 0.35, swirl: 0, ring: 0, sat: 1 },
  };

  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, k) => a + (b - a) * k;
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  let canvas, ctx, W, H, dpr;
  let state = 'idle';
  const cur = { ...STATES.idle, colors: STATES.idle.colors.map(hex) };
  let inputLevel = 0;   // 0..1 target from mic / speech
  let level = 0;        // smoothed
  let t = 0, swirlAngle = 0, ringAngle = 0, last = performance.now();
  const ripples = [];   // expanding rings while you talk
  let lastRipple = 0, hover = 0, hoverTarget = 0, press = 0;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Smooth pseudo-noise for the edge: sum of drifting sines.
  function edge(theta, time, lvl) {
    return (
      Math.sin(theta * 2 + time * 1.3) * 0.5 +
      Math.sin(theta * 3 - time * 1.7 + 1.3) * 0.35 +
      Math.sin(theta * 5 + time * 2.3 + 2.1) * 0.22 * (0.4 + lvl) +
      Math.sin(theta * 8 - time * 3.1) * 0.12 * lvl
    );
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const target = STATES[state] || STATES.idle;
    const k = 1 - Math.exp(-dt * 3.2);      // parameter easing
    const kc = 1 - Math.exp(-dt * 2.2);     // colour easing (slower = silkier)
    for (const p of ['speed', 'amp', 'glow', 'swirl', 'ring', 'sat']) cur[p] = mix(cur[p], target[p], k);
    target.colors.forEach((h, i) => { const c = hex(h); for (let j = 0; j < 3; j++) cur.colors[i][j] = mix(cur.colors[i][j], c[j], kc); });

    // Fast attack, slow release, like a VU meter.
    level = inputLevel > level ? mix(level, inputLevel, 1 - Math.exp(-dt * 18)) : mix(level, inputLevel, 1 - Math.exp(-dt * 5));
    hover = mix(hover, hoverTarget, 1 - Math.exp(-dt * 10));
    press = mix(press, 0, 1 - Math.exp(-dt * 6));

    t += dt * (0.6 + cur.speed);
    swirlAngle += dt * (0.4 + cur.swirl * 3.2);
    ringAngle += dt * 2.4;

    const cx = W / 2, cy = H / 2;
    const base = Math.min(W, H) * 0.27;
    const breathe = Math.sin(t * 1.1) * 0.018;
    const R = base * (1 + breathe + level * 0.16 + hover * 0.04 - press * 0.06);

    ctx.clearRect(0, 0, W, H);

    // --- halo ---
    const c0 = cur.colors[0], c1 = cur.colors[1];
    const glowA = 0.18 + cur.glow * 0.35 + level * 0.35;
    const halo = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.9);
    halo.addColorStop(0, rgba(c0, glowA));
    halo.addColorStop(0.45, rgba(c1, glowA * 0.35));
    halo.addColorStop(1, rgba(c1, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);

    // --- ripples (listening) ---
    if (state === 'listening' && level > 0.18 && now - lastRipple > 320) {
      ripples.push({ r: R, a: 0.35 + level * 0.4 });
      lastRipple = now;
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.r += dt * base * 1.4;
      rp.a -= dt * 0.7;
      if (rp.a <= 0) { ripples.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(cx, cy, rp.r, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(cur.colors[2], rp.a);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // --- body shape ---
    const amp = cur.amp + level * 0.11;
    const N = 120;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI * 2;
      const r = R * (1 + amp * edge(th, t, level));
      const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();

    ctx.save();
    ctx.shadowColor = rgba(c0, 0.55);
    ctx.shadowBlur = 24 + level * 30;
    ctx.fillStyle = '#0a0b16';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.clip();

    // Luminous base so there are never dark holes between the blobs.
    const baseG = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    baseG.addColorStop(0, rgba(cur.colors[3], 0.85));
    baseG.addColorStop(0.5, rgba(cur.colors[0], 0.7));
    baseG.addColorStop(1, rgba(cur.colors[1], 0.85));
    ctx.fillStyle = baseG;
    ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);

    // Flowing colour blobs inside the sphere.
    ctx.globalCompositeOperation = 'lighter';
    const blobs = [
      { c: cur.colors[0], w: 0.9, ph: 0.0, d: 0.42, s: 1.05 },
      { c: cur.colors[1], w: -0.7, ph: 2.1, d: 0.48, s: 0.95 },
      { c: cur.colors[2], w: 1.25, ph: 4.0, d: 0.36, s: 0.75 },
      { c: cur.colors[3], w: -1.1, ph: 1.0, d: 0.52, s: 0.9 },
    ];
    for (const b of blobs) {
      const a = t * b.w + b.ph + swirlAngle * cur.swirl * Math.sign(b.w);
      const dist = R * b.d * (1 + 0.25 * Math.sin(t * 0.7 + b.ph));
      const x = cx + Math.cos(a) * dist, y = cy + Math.sin(a * 1.15) * dist;
      const rr = R * b.s * (1 + level * 0.25);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, rgba(b.c, 0.6 * cur.sat + 0.1));
      g.addColorStop(0.55, rgba(b.c, 0.2 * cur.sat));
      g.addColorStop(1, rgba(b.c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);
    }

    // Thinking: a rotating shimmer sweeps around the sphere.
    if (cur.swirl > 0.02) {
      const cg = ctx.createConicGradient(swirlAngle * 1.6, cx, cy);
      const s = 0.22 * cur.swirl;
      cg.addColorStop(0, `rgba(255,255,255,${s})`);
      cg.addColorStop(0.12, 'rgba(255,255,255,0)');
      cg.addColorStop(0.5, `rgba(255,255,255,${s * 0.6})`);
      cg.addColorStop(0.62, 'rgba(255,255,255,0)');
      cg.addColorStop(1, `rgba(255,255,255,${s})`);
      ctx.fillStyle = cg;
      ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);
    }

    // Glassy specular highlight + darker rim for depth.
    ctx.globalCompositeOperation = 'source-over';
    const hl = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.45, 0, cx - R * 0.35, cy - R * 0.45, R * 0.9);
    hl.addColorStop(0, 'rgba(255,255,255,0.42)');
    hl.addColorStop(0.35, 'rgba(255,255,255,0.08)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);
    const rim = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R * 1.15);
    rim.addColorStop(0, 'rgba(0,0,0,0)');
    rim.addColorStop(1, 'rgba(5,6,20,0.35)');
    ctx.fillStyle = rim;
    ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);
    ctx.restore();

    // Thin bright edge line.
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(cur.colors[2], 0.25 + level * 0.4);
    ctx.stroke();

    // Acting: a progress arc orbits the sphere.
    if (cur.ring > 0.02) {
      const rr = R * 1.28;
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.5;
      for (let i = 0; i < 2; i++) {
        const a0 = ringAngle * (i ? -0.7 : 1) + i * Math.PI;
        ctx.beginPath();
        ctx.arc(cx, cy, rr + i * 5, a0, a0 + 0.9 + 0.4 * Math.sin(t));
        ctx.strokeStyle = rgba(cur.colors[i ? 2 : 1], 0.75 * cur.ring);
        ctx.stroke();
      }
    }

    // Confirming: slow breathing ring.
    if (state === 'confirming') {
      const p = (Math.sin(now / 420) + 1) / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (1.2 + p * 0.12), 0, Math.PI * 2);
      ctx.strokeStyle = rgba(cur.colors[0], 0.25 + 0.35 * (1 - p));
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    requestAnimationFrame(frame);
  }

  window.Orb = {
    mount(el) {
      canvas = el;
      ctx = canvas.getContext('2d');
      resize();
      new ResizeObserver(resize).observe(canvas);
      canvas.addEventListener('mouseenter', () => (hoverTarget = 1));
      canvas.addEventListener('mouseleave', () => (hoverTarget = 0));
      canvas.addEventListener('mousedown', () => (press = 1));
      requestAnimationFrame(frame);
    },
    setState(s) { if (STATES[s]) state = s; },
    getState() { return state; },
    /** 0..1 loudness of your voice (listening) or of the assistant (speaking). */
    setLevel(v) { inputLevel = Math.max(0, Math.min(1, v)); },
    STATES,
  };
})();
