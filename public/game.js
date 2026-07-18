/* VoltVipers client — rendering, audio, UI, store */
'use strict';

/* ================= state ================= */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const mmCanvas = document.getElementById('minimap');
const mmCtx = mmCanvas.getContext('2d');
let W = innerWidth, H = innerHeight;
function resize() { W = canvas.width = innerWidth; H = canvas.height = innerHeight; }
addEventListener('resize', resize); resize();

let CONFIG = { skins: {}, coinPacks: {}, reviveCost: 60, boostPackCost: 120, stripeMode: 'simulated' };
/* Apple App Store guideline 3.1.1: inside the native iOS shell, digital goods must go
   through Apple In-App Purchase — never Stripe. When running under Capacitor we hide
   the Stripe coin packs and defer to a StoreKit bridge (window.VV_IAP) if present. */
const NATIVE_SHELL = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
let WORLD_SIZE = 4200;

const save = {
  get coins() { return +(localStorage.getItem('vv_coins') || 0); },
  set coins(v) { localStorage.setItem('vv_coins', Math.max(0, Math.floor(v))); refreshCoinLabels(); },
  get owned() { try { return JSON.parse(localStorage.getItem('vv_owned') || '["volt","magma"]'); } catch (e) { return ['volt', 'magma']; } },
  set owned(v) { localStorage.setItem('vv_owned', JSON.stringify(v)); },
  get skin() { return localStorage.getItem('vv_skin') || 'volt'; },
  set skin(v) { localStorage.setItem('vv_skin', v); },
  get name() { return localStorage.getItem('vv_name') || ''; },
  set name(v) { localStorage.setItem('vv_name', v); },
  get boostLives() { return +(localStorage.getItem('vv_boost') || 0); },
  set boostLives(v) { localStorage.setItem('vv_boost', Math.max(0, v)); },
};

let ws = null, myId = null, playing = false;
let snakesById = new Map(); // id -> {cur, prev, lastT, data}
let orbsById = new Map();
let topList = [], feedSeen = new Set(), blips = [];
let myMass = 0, lastMass = 0, bestRank = 99;
let camX = WORLD_SIZE / 2, camY = WORLD_SIZE / 2, zoom = 1;
let mouseX = 0, mouseY = 0, boosting = false;
let shake = 0, flash = 0, flashColor = '255,255,255';
let killsThisLife = 0;
let particles = [];
let combo = 0, comboTimer = 0;
const ORB_PALETTE = ['#39ff14', '#4cc9f0', '#f72585', '#ffd700', '#0aff9d', '#c77dff', '#ff5e13', '#b8f3ff'];

/* ================= audio ================= */
let AC = null, masterGain = null;
function audio() {
  if (!AC) {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = AC.createGain(); masterGain.gain.value = 0.5; masterGain.connect(AC.destination);
  }
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
function tone(freq, dur, type, vol, slideTo) {
  try {
    const ac = audio(); const o = ac.createOscillator(); const g = ac.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ac.currentTime + dur);
    g.gain.value = vol || 0.15;
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    o.connect(g); g.connect(masterGain); o.start(); o.stop(ac.currentTime + dur);
  } catch (e) {}
}
function noiseBurst(dur, vol) {
  try {
    const ac = audio(); const n = ac.sampleRate * dur; const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ac.createBufferSource(); src.buffer = buf;
    const g = ac.createGain(); g.gain.value = vol || 0.25;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    src.connect(f); f.connect(g); g.connect(masterGain); src.start();
  } catch (e) {}
}
const sEat = c => tone(300 + Math.min(c, 20) * 45, 0.09, 'square', 0.09, 420 + Math.min(c, 20) * 45);
const sKill = () => { noiseBurst(0.35, 0.3); tone(90, 0.4, 'sawtooth', 0.2, 40); };
const sDeath = () => { tone(340, 0.7, 'sawtooth', 0.22, 60); noiseBurst(0.5, 0.2); };
const sClick = () => tone(650, 0.05, 'square', 0.06);
const sBuy = () => { tone(523, 0.1, 'sine', 0.15); setTimeout(() => tone(659, 0.1, 'sine', 0.15), 90); setTimeout(() => tone(784, 0.18, 'sine', 0.18), 180); };
const sRevive = () => { tone(200, 0.3, 'sawtooth', 0.18, 800); };
const sStreak = () => { tone(440, 0.08, 'square', 0.1); setTimeout(() => tone(554, 0.08, 'square', 0.1), 80); setTimeout(() => tone(659, 0.15, 'square', 0.12), 160); };
const sZap = () => { noiseBurst(0.12, 0.18); tone(1800, 0.12, 'sawtooth', 0.08, 300); };
const sJackpot = () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.16, 'square', 0.13), i * 90)); noiseBurst(0.2, 0.1); };

/* ================= helpers ================= */
const $ = id => document.getElementById(id);
function refreshCoinLabels() {
  $('coinVal').textContent = save.coins;
  $('storeCoins').textContent = save.coins;
}
function toast(msg, ms) {
  const t = $('toast'); t.innerHTML = msg; t.style.opacity = 1;
  clearTimeout(t._h); t._h = setTimeout(() => t.style.opacity = 0, ms || 2600);
}
function announce(msg, color) {
  const a = $('announce'); a.textContent = msg; a.style.color = color || 'var(--pink)';
  a.style.textShadow = `0 0 20px ${color || '#f72585'}`;
  a.style.opacity = 1; clearTimeout(a._h); a._h = setTimeout(() => a.style.opacity = 0, 1600);
}
function skinColors(key) { return (CONFIG.skins[key] || { colors: ['#39ff14', '#0aff9d'] }).colors; }

/* ================= networking ================= */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === 'joined') {
      myId = m.id; WORLD_SIZE = m.world; playing = true;
      bestRank = 99; combo = 0; lastMass = 0; killsThisLife = 0;
      $('death').classList.add('hidden'); $('menu').classList.add('hidden');
      showHud(true);
      if (m.revived) { sRevive(); announce('⚡ REVIVED ⚡', '#0aff9d'); }
    } else if (m.t === 's') {
      handleState(m);
    } else if (m.t === 'dead') {
      onDeath(m);
    } else if (m.t === 'crate') {
      save.coins = save.coins + m.coins;
      sZap(); sJackpot();
      flash = 0.35; flashColor = '255,215,0';
      announce(`⚡ VOLT CRATE! +${m.coins} 🪙`, '#ffd700');
      spawnBurst(W / 2, H / 2, '#ffd700', 34);
    } else if (m.t === 'bounty') {
      save.coins = save.coins + m.coins;
      sJackpot(); shake = 18;
      flash = 0.5; flashColor = '255,215,0';
      announce(`💰 BOUNTY CLAIMED! +${m.coins} 🪙`, '#ffd700');
      spawnBurst(W / 2, H / 2, '#ffd700', 60);
    }
  };
  ws.onclose = () => { if (playing) setTimeout(connect, 1200); };
}
function handleState(m) {
  const now = performance.now();
  const seen = new Set();
  for (const s of m.snakes) {
    seen.add(s.id);
    const e = snakesById.get(s.id);
    if (e) { e.prev = e.cur; e.cur = s; e.lastT = now; }
    else snakesById.set(s.id, { prev: s, cur: s, lastT: now });
  }
  for (const id of [...snakesById.keys()]) if (!seen.has(id)) snakesById.delete(id);

  const orbSeen = new Set();
  for (const o of m.orbs) { orbSeen.add(o[0]); if (!orbsById.has(o[0])) orbsById.set(o[0], o); }
  for (const id of [...orbsById.keys()]) if (!orbSeen.has(id)) orbsById.delete(id);

  topList = m.top; blips = m.blips;

  const mine = snakesById.get(myId);
  if (mine) {
    myMass = mine.cur.m;
    if (lastMass > 0 && myMass > lastMass) onEat(myMass - lastMass);
    lastMass = myMass;
    const rank = topList.findIndex(r => r.n === mine.cur.n);
    if (rank >= 0 && rank + 1 < bestRank) {
      bestRank = rank + 1;
      if (bestRank === 1) announce('👑 YOU ARE #1 👑', '#ffd700');
      else if (bestRank <= 3) announce(`TOP ${bestRank}!`, '#ffd700');
    }
  }
  // kill feed
  const fEl = $('feed'); fEl.innerHTML = '';
  for (const f of m.feed) {
    const key = f.k + '>' + f.v + '@' + f.t;
    if (!feedSeen.has(key)) {
      feedSeen.add(key);
      if (mine && f.k === mine.cur.n) {
        sKill(); shake = 14;
        flash = 0.3; flashColor = '247,37,133';
        save.coins = save.coins + 15;
        spawnBurst(W / 2, H / 2, '#f72585', 26);
        killsThisLife++;
        const streaks = { 2: ['⚡ DOUBLE KILL! +30 🪙', 30], 3: ['🔥 TRIPLE KILL! +60 🪙', 60], 5: ['💀 RAMPAGE! +120 🪙', 120], 8: ['👑 UNSTOPPABLE! +300 🪙', 300] };
        if (streaks[killsThisLife]) {
          const [txt, bonus] = streaks[killsThisLife];
          save.coins = save.coins + bonus;
          setTimeout(() => { announce(txt, '#ffd700'); sStreak(); }, 900);
        } else {
          announce(`💀 ELIMINATED ${f.v}`, '#f72585');
        }
      }
    }
    const d = document.createElement('div');
    d.innerHTML = `<b>${esc(f.k)}</b> ⚡ ${esc(f.v)}`;
    fEl.appendChild(d);
  }
  if (feedSeen.size > 200) feedSeen = new Set([...feedSeen].slice(-50));
  renderLeaderboard();
}
function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

function sendInput() {
  if (!ws || ws.readyState !== 1 || !playing) return;
  const a = Math.atan2(mouseY - H / 2, mouseX - W / 2);
  ws.send(JSON.stringify({ t: 'input', a, b: boosting }));
}
setInterval(sendInput, 50);
/* boost crackle audio */
setInterval(() => { if (boosting && playing && AC) { noiseBurst(0.05, 0.04); if (Math.random() < 0.3) tone(1200 + Math.random() * 800, 0.06, 'sawtooth', 0.03, 400); } }, 160);

/* ================= gameplay events ================= */
function onEat(gain) {
  combo++; comboTimer = 90;
  sEat(combo);
  const c = $('combo');
  if (combo >= 3) {
    c.textContent = `COMBO ×${combo}`;
    c.style.opacity = 1; c.style.transform = `translateX(-50%) scale(${1 + Math.min(combo, 15) * 0.03})`;
  }
  const mine = snakesById.get(myId);
  if (mine) spawnBurst(W / 2, H / 2, skinColors(mine.cur.sk)[0], 6 + Math.min(gain, 10));
}
function onDeath(m) {
  playing = false; sDeath(); shake = 24;
  spawnBurst(W / 2, H / 2, '#f72585', 60);
  save.coins = save.coins + m.coins;
  $('dMass').textContent = m.mass;
  $('dKills').textContent = m.kills;
  $('dRank').textContent = bestRank === 99 ? '–' : '#' + bestRank;
  $('reviveCostLbl').textContent = CONFIG.reviveCost;
  $('reviveBtn').style.display = save.coins >= CONFIG.reviveCost ? '' : 'none';
  // count-up the earned coins for dopamine
  let shown = 0; const target = m.coins;
  const iv = setInterval(() => {
    shown = Math.min(target, shown + Math.max(1, Math.floor(target / 30)));
    $('dCoins').textContent = shown;
    if (shown >= target) clearInterval(iv);
  }, 40);
  setTimeout(() => $('death').classList.remove('hidden'), 700);
  showHud(false);
}
function showHud(on) {
  for (const id of ['hudScore', 'hudCoins', 'leader', 'prizeTicker']) $(id).style.display = on ? '' : 'none';
  mmCanvas.classList.toggle('hidden', !on);
  $('boostBtn').style.display = (on && IS_TOUCH) ? 'flex' : 'none';
}
function renderLeaderboard() {
  const mine = snakesById.get(myId);
  const rows = topList.map((r, i) =>
    `<div class="row ${mine && r.n === mine.cur.n ? 'me' : ''}"><span><span class="rank">${i + 1}</span> ${esc(r.n)}</span><span>${r.m}</span></div>`).join('');
  $('leaderRows').innerHTML = rows;
}

/* ================= particles / fx ================= */
function spawnBurst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 5;
    particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 30 + Math.random() * 25, color, r: 1.5 + Math.random() * 3 });
  }
  if (particles.length > 500) particles.splice(0, particles.length - 500);
}

/* ================= render loop ================= */
function lerp(a, b, t) { return a + (b - a) * t; }
/* jagged lightning bolt between two points (world space, current transform) */
function bolt(x1, y1, x2, y2, color, width, alpha) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len; // normal
  const segs = Math.max(3, Math.floor(len / 26));
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.globalAlpha = alpha; ctx.shadowColor = color; ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.moveTo(x1, y1);
  for (let i = 1; i < segs; i++) {
    const t = i / segs, j = (Math.random() - 0.5) * len * 0.22;
    ctx.lineTo(x1 + dx * t + nx * j, y1 + dy * t + ny * j);
  }
  ctx.lineTo(x2, y2); ctx.stroke();
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}
/* arcs crackling along a snake's spine */
function electrify(pts, color, chance) {
  for (let i = 0; i + 5 < pts.length; i += 6) {
    if (Math.random() < chance) {
      bolt(pts[i], pts[i + 1], pts[i + 4], pts[i + 5], color, 2.2, 0.6 + Math.random() * 0.4);
    }
  }
}
/* wild sparks shooting off a point */
function headSparks(x, y, color, n, reach) {
  for (let i = 0; i < n; i++) {
    if (Math.random() < 0.55) {
      const a = Math.random() * 6.283;
      bolt(x, y, x + Math.cos(a) * reach, y + Math.sin(a) * reach, color, 1.6, 0.7);
    }
  }
}
function draw() {
  requestAnimationFrame(draw);
  const now = performance.now();
  ctx.fillStyle = '#05060f'; ctx.fillRect(0, 0, W, H);

  const mine = snakesById.get(myId);
  if (mine) {
    const t = Math.min(1, (now - mine.lastT) / 110);
    const hx = lerp(mine.prev.x, mine.cur.x, t), hy = lerp(mine.prev.y, mine.cur.y, t);
    camX = lerp(camX, hx, 0.12); camY = lerp(camY, hy, 0.12);
    const targetZoom = Math.max(0.55, 1.05 - Math.sqrt(myMass) / 90);
    zoom = lerp(zoom, targetZoom, 0.02);
  }
  let sx = 0, sy = 0;
  if (shake > 0) { sx = (Math.random() - 0.5) * shake; sy = (Math.random() - 0.5) * shake; shake *= 0.85; if (shake < 0.5) shake = 0; }

  ctx.save();
  ctx.translate(W / 2 + sx, H / 2 + sy); ctx.scale(zoom, zoom); ctx.translate(-camX, -camY);

  // grid
  const grid = 90;
  ctx.strokeStyle = 'rgba(20, 60, 90, 0.35)'; ctx.lineWidth = 1;
  const x0 = Math.floor((camX - W / zoom / 2) / grid) * grid, x1 = camX + W / zoom / 2;
  const y0 = Math.floor((camY - H / zoom / 2) / grid) * grid, y1 = camY + H / zoom / 2;
  ctx.beginPath();
  for (let x = x0; x < x1; x += grid) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  for (let y = y0; y < y1; y += grid) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
  ctx.stroke();

  // world border (electrified wall)
  const flicker = 0.7 + Math.random() * 0.3;
  ctx.strokeStyle = `rgba(247, 37, 133, ${0.85 * flicker})`; ctx.lineWidth = 8;
  ctx.shadowColor = '#f72585'; ctx.shadowBlur = 24 + Math.random() * 22;
  ctx.strokeRect(0, 0, WORLD_SIZE, WORLD_SIZE);
  ctx.shadowBlur = 0;
  // crackling arcs along whichever walls are in view
  const vx0 = camX - W / zoom / 2, vx1 = camX + W / zoom / 2;
  const vy0 = camY - H / zoom / 2, vy1 = camY + H / zoom / 2;
  const walls = [];
  if (vy0 < 40) walls.push([Math.max(0, vx0), 0, Math.min(WORLD_SIZE, vx1), 0]);
  if (vy1 > WORLD_SIZE - 40) walls.push([Math.max(0, vx0), WORLD_SIZE, Math.min(WORLD_SIZE, vx1), WORLD_SIZE]);
  if (vx0 < 40) walls.push([0, Math.max(0, vy0), 0, Math.min(WORLD_SIZE, vy1)]);
  if (vx1 > WORLD_SIZE - 40) walls.push([WORLD_SIZE, Math.max(0, vy0), WORLD_SIZE, Math.min(WORLD_SIZE, vy1)]);
  for (const [wx1, wy1, wx2, wy2] of walls) {
    if (Math.random() < 0.7) bolt(wx1, wy1, wx2, wy2, '#ff4d9d', 2, 0.6);
    if (Math.random() < 0.4) bolt(wx1, wy1, wx2, wy2, '#ffffff', 1, 0.5);
  }

  // orbs (c=8 → ⚡ Volt Crate)
  const pulse = Math.sin(now / 300);
  for (const o of orbsById.values()) {
    if (o[4] === 8) {
      const r = 9 + pulse * 2.5;
      ctx.fillStyle = '#ffd700'; ctx.shadowColor = '#ffd700'; ctx.shadowBlur = 22;
      ctx.beginPath(); ctx.arc(o[1], o[2], r, 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#05060f'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('⚡', o[1], o[2] + 4);
      if (Math.random() < 0.25) {
        const a = Math.random() * 6.28;
        bolt(o[1], o[2], o[1] + Math.cos(a) * 26, o[2] + Math.sin(a) * 26, '#ffd700', 1.2, 0.7);
      }
      continue;
    }
    const r = (o[3] >= 6 ? 6.5 : o[3] >= 4 ? 5 : 3.5) + pulse * 0.7;
    ctx.fillStyle = ORB_PALETTE[o[4]];
    ctx.shadowColor = ORB_PALETTE[o[4]]; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(o[1], o[2], r, 0, 7); ctx.fill();
  }
  ctx.shadowBlur = 0;

  // snakes
  for (const e of snakesById.values()) {
    const s = e.cur, t = Math.min(1, (now - e.lastT) / 110);
    const cols = skinColors(s.sk);
    const r = (5 + Math.sqrt(s.m) * 0.55);
    const pts = s.p, ppts = e.prev.p;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // glow pass
    ctx.strokeStyle = cols[0]; ctx.lineWidth = r * 2.5; ctx.globalAlpha = s.b ? 0.35 : 0.16;
    ctx.shadowColor = cols[0]; ctx.shadowBlur = s.b ? 34 : 18;
    strokePath(pts, ppts, t);
    // body pass
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    const grad = ctx.createLinearGradient(s.x - 100, s.y - 100, s.x + 100, s.y + 100);
    grad.addColorStop(0, cols[0]); grad.addColorStop(1, cols[1]);
    ctx.strokeStyle = grad; ctx.lineWidth = r * 2;
    strokePath(pts, ppts, t);
    // head
    const hx = lerp(e.prev.x, s.x, t), hy = lerp(e.prev.y, s.y, t);
    ctx.fillStyle = '#fff'; ctx.shadowColor = cols[0]; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc(hx, hy, r * 0.95, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
    // eyes
    const a = s.a;
    ctx.fillStyle = '#05060f';
    ctx.beginPath(); ctx.arc(hx + Math.cos(a - 0.5) * r * 0.5, hy + Math.sin(a - 0.5) * r * 0.5, r * 0.22, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(hx + Math.cos(a + 0.5) * r * 0.5, hy + Math.sin(a + 0.5) * r * 0.5, r * 0.22, 0, 7); ctx.fill();
    // ⚡ electric arcs: always on the bounty viper, crackle while boosting
    if (s.g) {
      electrify(s.p, '#ffd700', 0.5);
      ctx.strokeStyle = '#ffd700'; ctx.globalAlpha = 0.5 + pulse * 0.3; ctx.lineWidth = 3;
      ctx.shadowColor = '#ffd700'; ctx.shadowBlur = 25;
      ctx.beginPath(); ctx.arc(hx, hy, r * 1.9, 0, 7); ctx.stroke();
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    } else if (s.b) {
      electrify(s.p, '#ffffff', 0.5);
      electrify(s.p, cols[0], 0.4);
      headSparks(hx, hy, '#ffffff', 3, r * 3.2);
      headSparks(hx, hy, cols[0], 2, r * 4.5);
    }
    if (s.g) headSparks(hx, hy, '#ffd700', 3, r * 3.5);
    // name
    if (s.g) {
      ctx.fillStyle = '#ffd700'; ctx.shadowColor = '#ffd700'; ctx.shadowBlur = 12;
      ctx.font = `bold ${Math.max(13, r)}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillText('💰 ' + s.n + ' 💰', hx, hy - r - 12);
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = 'rgba(216,255,240,0.9)'; ctx.font = `${Math.max(11, r * 0.9)}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(s.n, hx, hy - r - 8);
    }
  }

  ctx.restore();

  // particles (screen space)
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vx *= 0.96; p.vy *= 0.96; p.life--;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    ctx.globalAlpha = Math.min(1, p.life / 25);
    ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;

  // ⚡ full-screen flash on kills / crates / bounty
  if (flash > 0.01) {
    ctx.fillStyle = `rgba(${flashColor},${flash})`;
    ctx.fillRect(0, 0, W, H);
    flash *= 0.86;
  }

  // combo decay
  if (comboTimer > 0) { comboTimer--; if (comboTimer === 0) { combo = 0; $('combo').style.opacity = 0; } }

  $('scoreVal').textContent = myMass;

  // minimap
  mmCtx.clearRect(0, 0, 120, 120);
  mmCtx.strokeStyle = 'rgba(10,255,157,0.4)'; mmCtx.strokeRect(1, 1, 118, 118);
  for (const b of blips) {
    mmCtx.fillStyle = b[2] === 1 ? '#39ff14' : b[2] === 2 ? '#ffd700' : 'rgba(247,37,133,0.8)';
    mmCtx.beginPath(); mmCtx.arc(b[0] * 1.2, b[1] * 1.2, b[2] ? 3.5 : 2, 0, 7); mmCtx.fill();
  }
}
function strokePath(pts, ppts, t) {
  ctx.beginPath();
  for (let i = 0; i + 1 < pts.length; i += 2) {
    let x = pts[i], y = pts[i + 1];
    if (ppts && i + 1 < ppts.length) { x = lerp(ppts[i], x, t); y = lerp(ppts[i + 1], y, t); }
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
requestAnimationFrame(draw);

/* ================= input ================= */
addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; });
addEventListener('mousedown', () => { if (playing) boosting = true; });
addEventListener('mouseup', () => boosting = false);
/* mobile boost button: hold to boost */
const IS_TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
const boostBtn = $('boostBtn');
boostBtn.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); if (playing) { boosting = true; boostBtn.classList.add('pressed'); } }, { passive: false });
boostBtn.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); boosting = false; boostBtn.classList.remove('pressed'); }, { passive: false });
boostBtn.addEventListener('touchcancel', () => { boosting = false; boostBtn.classList.remove('pressed'); });
addEventListener('keydown', e => { if (e.code === 'Space') { boosting = true; e.preventDefault(); } });
addEventListener('keyup', e => { if (e.code === 'Space') boosting = false; });
addEventListener('touchmove', e => { const t = e.touches[0]; mouseX = t.clientX; mouseY = t.clientY; }, { passive: true });
addEventListener('touchstart', e => { const t = e.touches[0]; mouseX = t.clientX; mouseY = t.clientY; }, { passive: true });

/* ================= UI: menu / death / modals ================= */
function join() {
  audio(); sClick();
  const name = ($('nameInput').value || '').trim() || 'viper_' + Math.floor(Math.random() * 999);
  save.name = name;
  let startBoost = false;
  if (save.boostLives > 0) { save.boostLives = save.boostLives - 1; startBoost = true; toast('⚡ Head Start active! +600 mass'); }
  const go = () => ws.send(JSON.stringify({ t: 'join', name, skin: save.skin, startBoost }));
  if (!ws || ws.readyState !== 1) { connect(); ws.addEventListener('open', go, { once: true }); }
  else go();
}
$('playBtn').onclick = join;
$('respawnBtn').onclick = () => { $('death').classList.add('hidden'); join(); };
$('shareBtn').onclick = async () => {
  sClick();
  const url = location.origin;
  const mass = $('dMass').textContent, kills = $('dKills').textContent;
  const msg = `I just hit ${mass} mass with ${kills} kills in VoltVipers ⚡ Think you can cut me off? ${url}`;
  const btn = $('shareBtn');
  try {
    if (navigator.share) { await navigator.share({ title: 'VoltVipers ⚡', text: msg, url }); return; }
    await navigator.clipboard.writeText(msg);
    btn.textContent = '✅ LINK COPIED — GO PASTE IT';
  } catch (e) {
    try { const t = document.createElement('textarea'); t.value = msg; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); btn.textContent = '✅ LINK COPIED — GO PASTE IT'; }
    catch (e2) { btn.textContent = url; }
  }
  setTimeout(() => { btn.textContent = '⚡ CHALLENGE YOUR FRIENDS'; }, 2500);
};
$('menuBtn').onclick = () => { sClick(); $('death').classList.add('hidden'); $('menu').classList.remove('hidden'); buildMenuSkins(); };
$('reviveBtn').onclick = () => {
  if (save.coins < CONFIG.reviveCost) return;
  save.coins = save.coins - CONFIG.reviveCost;
  sRevive();
  ws.send(JSON.stringify({ t: 'revive' }));
};
$('nameInput').value = save.name;
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });

function openStore() { sClick(); buildStore(); $('store').classList.remove('hidden'); $('prizes').classList.add('hidden'); $('spin').classList.add('hidden'); }
function openPrizes() { sClick(); loadPrizes(); $('prizes').classList.remove('hidden'); $('store').classList.add('hidden'); $('spin').classList.add('hidden'); }
function closeModals() { sClick(); $('store').classList.add('hidden'); $('prizes').classList.add('hidden'); $('spin').classList.add('hidden'); }
window.openStore = openStore; window.openPrizes = openPrizes; window.closeModals = closeModals;

/* ================= 🎡 Daily Volt Spin ================= */
const WHEEL = [
  { v: 25, w: 25 }, { v: 40, w: 20 }, { v: 50, w: 18 }, { v: 75, w: 14 },
  { v: 100, w: 10 }, { v: 150, w: 7 }, { v: 200, w: 4 }, { v: 250, w: 2 },
];
let wheelAngle = 0, spinning = false;
function spinAvailable() { return localStorage.getItem('vv_spinday') !== new Date().toISOString().slice(0, 10); }
function buildWheel() {
  const wheel = $('wheel');
  if (wheel.querySelector('.wedge')) return; // build once; labels rotate with the wheel
  WHEEL.forEach((seg, i) => {
    const mid = (i + 0.5) * 45 - 90; // wedge 0 starts under the top pointer
    const rad = mid * Math.PI / 180, R = 88;
    const d = document.createElement('div');
    d.className = 'wedge'; d.style.left = '0'; d.style.top = '0';
    const s = document.createElement('span');
    s.textContent = seg.v + '🪙';
    s.style.left = (126 + Math.cos(rad) * R) + 'px';
    s.style.top = (126 + Math.sin(rad) * R) + 'px';
    d.appendChild(s);
    wheel.appendChild(d);
  });
}
function openSpin() {
  sClick(); buildWheel();
  $('spin').classList.remove('hidden'); $('store').classList.add('hidden'); $('prizes').classList.add('hidden');
  const ok = spinAvailable();
  $('spinBtn').disabled = !ok;
  $('spinBtn').style.opacity = ok ? 1 : 0.4;
  $('spinBtn').textContent = ok ? 'SPIN ⚡' : 'COME BACK TOMORROW';
  $('spinHint').textContent = ok ? 'Free coins, once a day. Good luck!' : 'You already spun today — your next free spin unlocks at midnight.';
}
window.openSpin = openSpin;
$('spinBtn').onclick = () => {
  if (spinning || !spinAvailable()) return;
  spinning = true; audio(); sZap();
  // weighted pick
  const total = WHEEL.reduce((a, s) => a + s.w, 0);
  let roll = Math.random() * total, idx = 0;
  for (let i = 0; i < WHEEL.length; i++) { roll -= WHEEL[i].w; if (roll <= 0) { idx = i; break; } }
  const prize = WHEEL[idx].v;
  // rotate so wedge idx lands under the top pointer
  const target = 360 * 5 - (idx * 45 + 22.5) + (Math.random() * 24 - 12);
  wheelAngle += target;
  $('wheel').style.transform = `rotate(${wheelAngle}deg)`;
  let ticks = 0;
  const tickIv = setInterval(() => { tone(600 + ticks * 8, 0.03, 'square', 0.05); ticks++; }, 130);
  setTimeout(() => {
    clearInterval(tickIv);
    localStorage.setItem('vv_spinday', new Date().toISOString().slice(0, 10));
    save.coins = save.coins + prize;
    sJackpot();
    toast(`🎡 +${prize} 🪙 — see you tomorrow!`, 3500);
    $('spinBtn').disabled = true; $('spinBtn').style.opacity = 0.4;
    $('spinBtn').textContent = 'COME BACK TOMORROW';
    $('spinHint').textContent = 'Your next free spin unlocks at midnight.';
    $('spinBadge').classList.add('hidden');
    spinning = false;
  }, 3600);
};
addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });

/* ================= skins ================= */
function skinDot(key) {
  const c = skinColors(key);
  return `background: radial-gradient(circle at 35% 35%, ${c[1]}, ${c[0]}); box-shadow: 0 0 12px ${c[0]};`;
}
function buildMenuSkins() {
  const row = $('skinRow'); row.innerHTML = '';
  for (const key of save.owned) {
    if (!CONFIG.skins[key]) continue;
    const d = document.createElement('div');
    d.className = 'skin' + (save.skin === key ? ' sel' : '');
    d.innerHTML = `<div class="dot" style="${skinDot(key)}"></div>`;
    d.title = CONFIG.skins[key].name;
    d.onclick = () => { sClick(); save.skin = key; buildMenuSkins(); };
    row.appendChild(d);
  }
}
function buildStore() {
  refreshCoinLabels();
  // coin packs
  const packs = $('packRows'); packs.innerHTML =
    '<div style="margin:4px 0 6px;font-size:11px;letter-spacing:2px;color:var(--dim)">COIN PACKS</div>';
  if (NATIVE_SHELL) {
    // iOS shell: Stripe stays hidden. StoreKit bridge (VV_IAP) renders Apple IAP rows instead.
    if (window.VV_IAP && window.VV_IAP.buildRows) {
      window.VV_IAP.buildRows(packs, coins => { save.coins = save.coins + coins; sBuy(); toast(`+${coins} 🪙!`); });
    } else {
      packs.innerHTML += '<div class="sub" style="margin:6px 0">Coin packs are coming soon on the App Store. Earn coins by playing!</div>';
    }
  } else {
    for (const [key, p] of Object.entries(CONFIG.coinPacks)) {
      const row = document.createElement('div'); row.className = 'shoprow';
      row.innerHTML = `<div><div class="nm">🪙 ${p.name}</div><div class="sub">Instant delivery</div></div>`;
      const b = document.createElement('button'); b.className = 'btn gold'; b.textContent = '$' + (p.usd / 100).toFixed(2);
      b.onclick = () => buyPack(key);
      row.appendChild(b); packs.appendChild(row);
    }
  }
  // boost
  $('boostBuyBtn').textContent = CONFIG.boostPackCost + ' 🪙';
  $('boostBuyBtn').onclick = () => {
    if (save.coins < CONFIG.boostPackCost) { toast('Not enough coins — grab a pack!'); return; }
    save.coins = save.coins - CONFIG.boostPackCost;
    save.boostLives = save.boostLives + 3;
    sBuy(); toast('⚡ Head Start ×3 purchased!');
  };
  // skins
  const row = $('storeSkinRow'); row.innerHTML = '';
  for (const [key, s] of Object.entries(CONFIG.skins)) {
    const owned = save.owned.includes(key);
    const d = document.createElement('div');
    d.className = 'skin' + (save.skin === key ? ' sel' : '') + (owned ? '' : ' locked');
    d.title = s.name;
    d.innerHTML = `<div class="dot" style="${skinDot(key)}"></div>` +
      (owned ? '' : `<div class="price">${s.cost} 🪙</div>`);
    d.onclick = () => {
      if (owned) { save.skin = key; sClick(); }
      else if (save.coins >= s.cost) {
        save.coins = save.coins - s.cost;
        save.owned = [...save.owned, key]; save.skin = key;
        sBuy(); toast(`${s.name} skin unlocked! 🔥`);
      } else { toast('Not enough coins — grab a pack!'); }
      buildStore(); buildMenuSkins();
    };
    row.appendChild(d);
  }
  const mode = CONFIG.stripeMode;
  $('storeModeHint').textContent = NATIVE_SHELL ? '' :
    mode === 'live' ? 'Payments secured by Stripe.' :
      mode === 'test' ? 'Stripe TEST MODE — use card 4242 4242 4242 4242.' :
        'Demo mode — purchases are simulated free until Stripe keys are added.';
}
async function buyPack(key) {
  sClick();
  try {
    const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pack: key }) });
    const j = await r.json();
    if (j.simulated) { save.coins = save.coins + j.coins; sBuy(); toast(`+${j.coins} 🪙 added! (demo mode)`); }
    else if (j.url) location.href = j.url;
    else toast('Checkout unavailable right now');
  } catch (e) { toast('Checkout unavailable right now'); }
}

/* returning from Stripe checkout */
(async function checkPaid() {
  const q = new URLSearchParams(location.search);
  if (q.get('paid') && q.get('session_id')) {
    try {
      const r = await fetch(`/api/verify?session_id=${encodeURIComponent(q.get('session_id'))}&pack=${encodeURIComponent(q.get('paid'))}`);
      const j = await r.json();
      if (j.paid && j.coins) { save.coins = save.coins + j.coins; sBuy(); toast(`Payment complete — +${j.coins} 🪙!`); }
    } catch (e) {}
    history.replaceState({}, '', '/');
  } else if (q.get('canceled')) {
    history.replaceState({}, '', '/');
  }
})();

/* ================= prizes ================= */
async function loadPrizes() {
  try {
    const r = await fetch('/api/prizes'); const j = await r.json();
    $('poolLbl').textContent = `This month's pool: ${j.pool}`;
    const tb = $('prizeRows'); tb.innerHTML = '';
    const rows = j.top.length ? j.top : [{ rank: 1, name: '— could be you —', minutes: 0, share: j.split[0] }];
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.className = 'r' + row.rank;
      tr.innerHTML = `<td>${row.rank <= 3 ? ['🥇', '🥈', '🥉'][row.rank - 1] : row.rank}</td><td>${esc(row.name)}</td><td>${row.minutes}</td><td>${row.share}%</td>`;
      tb.appendChild(tr);
    }
  } catch (e) {}
}

/* ================= daily streak ================= */
(function dailyStreak() {
  const today = new Date().toISOString().slice(0, 10);
  const last = localStorage.getItem('vv_lastday');
  let streak = +(localStorage.getItem('vv_streak') || 0);
  if (last === today) return;
  const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  streak = (last === yest) ? streak + 1 : 1;
  localStorage.setItem('vv_streak', streak);
  localStorage.setItem('vv_lastday', today);
  const reward = 25 * Math.min(streak, 7);
  save.coins = save.coins + reward;
  setTimeout(() => { toast(`🔥 Day ${streak} streak — +${reward} 🪙!`, 4000); sStreak(); }, 1500);
})();

/* ================= rewarded ads (AppLixir adapter — ships dark) =================
   Activates only when the server exposes CONFIG.ads.key (set APPLIXIR_API_KEY on the
   host). Hidden inside the native iOS shell (rewarded web ads there would violate
   App Store policy expectations — the shell gets AdMob later instead). Tolerant of
   both AppLixir SDK generations; any failure degrades to a "no ad available" toast. */
const adState = {
  get today() { const d = new Date(); return d.toISOString().slice(0, 10); },
  get watched() {
    try { const j = JSON.parse(localStorage.getItem('vv_ads') || '{}'); return j.d === this.today ? (j.n || 0) : 0; } catch (e) { return 0; }
  },
  bump() { localStorage.setItem('vv_ads', JSON.stringify({ d: this.today, n: this.watched + 1 })); },
};
let adBusy = false, adSdkLoading = null;
function adsEnabled() { return !!(CONFIG.ads && CONFIG.ads.key) && !NATIVE_SHELL; }
function adCapLeft() { return Math.max(0, (CONFIG.ads?.dailyCap ?? 5) - adState.watched); }
function refreshAdButtons() {
  const on = adsEnabled() && adCapLeft() > 0;
  $('adRowMenu').classList.toggle('hidden', !on);
  $('adRowDeath').classList.toggle('hidden', !on);
  if (on) for (const el of document.querySelectorAll('.adRewardLbl')) el.textContent = '+' + (CONFIG.ads.reward || 30);
}
function loadAdSdk() {
  if (window.invokeApplixirVideoUnit || window.initializeAndOpenPlayer) return Promise.resolve();
  if (adSdkLoading) return adSdkLoading;
  adSdkLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CONFIG.ads.script; s.async = true;
    s.onload = resolve; s.onerror = () => { adSdkLoading = null; reject(new Error('sdk load failed')); };
    document.head.appendChild(s);
  });
  return adSdkLoading;
}
function finishAd(rewarded) {
  $('applixir-overlay').classList.add('hidden');
  adBusy = false;
  if (rewarded) {
    const reward = CONFIG.ads.reward || 30;
    save.coins = save.coins + reward;
    adState.bump(); sBuy();
    toast(`📺 +${reward} 🪙 — thanks for watching!`);
  }
  refreshAdButtons();
}
async function watchAd() {
  if (adBusy || !adsEnabled()) return;
  if (adCapLeft() <= 0) { toast('Daily ad limit reached — back tomorrow!'); return; }
  adBusy = true; sClick();
  try {
    await loadAdSdk();
    $('applixir-overlay').classList.remove('hidden');
    const GOOD = new Set(['ad-watched', 'ad-rewarded', 'complete', 'completed']);
    const DONE = new Set(['ad-rejected', 'ad-interrupted', 'ads-unavailable', 'no-zoneId', 'network-error', 'ad-blocker', 'sys-closing', 'closed', 'error', 'skipped']);
    let rewarded = false, settled = false;
    const status = st => {
      const s = String(st).toLowerCase();
      if (GOOD.has(s)) rewarded = true;
      if ((GOOD.has(s) || DONE.has(s)) && !settled) {
        if (s === 'sys-closing' || s === 'closed' || GOOD.has(s) || DONE.has(s)) { settled = true; finishAd(rewarded); }
      }
    };
    if (window.invokeApplixirVideoUnit) {
      window.invokeApplixirVideoUnit({
        zoneId: CONFIG.ads.zone, accountId: CONFIG.ads.account, gameId: CONFIG.ads.key,
        adStatusCb: status, adErrorCb: () => { if (!settled) { settled = true; finishAd(false); toast('No ad available right now'); } },
      });
    } else if (window.initializeAndOpenPlayer) {
      window.initializeAndOpenPlayer({
        apiKey: CONFIG.ads.key, injectionElementId: 'applixir-root',
        adStatusCallbackFn: status,
        adErrorCallbackFn: () => { if (!settled) { settled = true; finishAd(false); toast('No ad available right now'); } },
      });
    } else { throw new Error('no sdk entrypoint'); }
    // safety valve: never leave the overlay stuck
    setTimeout(() => { if (!settled) { settled = true; finishAd(rewarded); } }, 120000);
  } catch (e) {
    finishAd(false); toast('No ad available right now');
  }
}
$('adBtnMenu').onclick = watchAd;
$('adBtnDeath').onclick = watchAd;

/* ================= boot ================= */
(async function boot() {
  try {
    const r = await fetch('/api/config'); CONFIG = await r.json();
  } catch (e) {}
  refreshCoinLabels();
  buildMenuSkins();
  if (spinAvailable()) $('spinBadge').classList.remove('hidden');
  $('modeHint').textContent = CONFIG.stripeMode === 'live' ? '' :
    CONFIG.stripeMode === 'test' ? 'Store: Stripe test mode' : 'Store: demo mode (no Stripe keys yet)';
  refreshAdButtons();
  connect();
  loadPrizes();
})();
