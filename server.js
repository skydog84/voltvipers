/* =========================================================
   VoltVipers — neon multiplayer snake arena
   Zero-dependency server: pure Node built-ins.
   - HTTP static server + JSON API
   - Hand-rolled RFC6455 WebSocket server
   - Stripe Checkout via raw REST API (no SDK needed)
   ========================================================= */
'use strict';

const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');

/* ---------- Stripe (test mode by default) ----------
   Set env vars to enable real checkout:
     STRIPE_SECRET_KEY=sk_test_...   (or sk_live_... when you go live)
     PUBLIC_URL=https://yourgame.com (used for redirect URLs)
   With no key set, the store runs in "simulated" mode so the
   whole purchase flow is still demoable end-to-end. */
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';

function stripeCall(method, apiPath, params) {
  return new Promise((resolve, reject) => {
    const body = params ? new URLSearchParams(params).toString() : '';
    const req = https.request({
      hostname: 'api.stripe.com', path: apiPath, method,
      headers: {
        'Authorization': 'Bearer ' + STRIPE_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(j.error ? j.error.message : 'stripe error'));
          else resolve(j);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/* ---------- Store catalog (prices in cents) ---------- */
const COIN_PACKS = {
  pack_small:  { name: 'Spark Pack — 500 coins',      coins: 500,  usd: 199 },
  pack_medium: { name: 'Surge Pack — 1,500 coins',    coins: 1500, usd: 499 },
  pack_large:  { name: 'Overload Pack — 4,000 coins', coins: 4000, usd: 999 },
};
const SKINS = {
  volt:    { name: 'Volt',     cost: 0,    colors: ['#39ff14', '#0aff9d'] },
  magma:   { name: 'Magma',    cost: 0,    colors: ['#ff5e13', '#ffd166'] },
  ice:     { name: 'Ice',      cost: 250,  colors: ['#4cc9f0', '#b8f3ff'] },
  plasma:  { name: 'Plasma',   cost: 500,  colors: ['#f72585', '#b5179e'] },
  aurora:  { name: 'Aurora',   cost: 900,  colors: ['#06ffa5', '#4361ee'] },
  phantom: { name: 'Phantom',  cost: 1500, colors: ['#c77dff', '#7b2cbf'] },
  gold:    { name: '24K Gold', cost: 2500, colors: ['#ffd700', '#ff9e00'] },
};
const REVIVE_COST = 60;         // coins to revive with 50% of your mass
const BOOST_PACK_COST = 120;    // coins: start next 3 lives with +600 mass

/* ---------- Monthly prize leaderboard ----------
   Tracks playtime (seconds) per player name per month.
   Top 10 each month share the prize pool. Configure with:
     PRIZE_POOL="$500"  (display string; e.g. "20% of store revenue")   */
const PRIZE_POOL = process.env.PRIZE_POOL || '20% of all store revenue';
const PRIZE_SPLIT = [30, 18, 12, 9, 8, 7, 6, 4, 3, 3]; // % of pool for ranks 1-10
const DATA_FILE = path.join(__dirname, 'monthly.json');
let monthly = { month: monthKey(), players: {} };
function monthKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
try { const m = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); if (m.month === monthKey()) monthly = m; } catch (_) {}
function addPlaytime(name, secs) {
  if (!name || secs <= 0) return;
  if (monthly.month !== monthKey()) monthly = { month: monthKey(), players: {} };
  monthly.players[name] = (monthly.players[name] || 0) + Math.round(secs);
}
setInterval(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(monthly)); } catch (_) {} }, 15000);

/* ---------- Game constants ---------- */
const WORLD = 4200;
const TICK_MS = 50;             // 20 ticks/sec
const BROADCAST_EVERY = 2;      // state to clients 10x/sec, client interpolates
const ORB_COUNT = 900;
const BOT_COUNT = 14;
const BASE_SPEED = 3.6;
const BOOST_SPEED = 6.6;
const TURN_RATE = 0.28;
const START_MASS = 120;
const SEG_SPACING = 5;
const VIEW_RADIUS = 1250;

const BOT_NAMES = ['Zapp', 'Nyx', 'Krait', 'Fang', 'Hex', 'Blitz', 'Rogue', 'Vex',
  'Circuit', 'Mamba', 'Static', 'Jolt', 'Razor', 'Pulse', 'Cobra', 'Glitch',
  'Neon', 'Surge', 'Viper_77', 'xX_Volt_Xx'];

/* ---------- State ---------- */
const snakes = new Map();
const orbs = new Map();
let nextId = 1;
let tickCount = 0;
const killFeed = [];

function rid() { return (nextId++).toString(36); }
function rand(a, b) { return a + Math.random() * (b - a); }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

const ORB_COLORS = 8;
function spawnOrb(x, y, v) {
  const id = rid();
  orbs.set(id, {
    id,
    x: x !== undefined ? x : rand(60, WORLD - 60),
    y: y !== undefined ? y : rand(60, WORLD - 60),
    v: v || (Math.random() < 0.08 ? 6 : 2),
    c: v ? Math.floor(Math.random() * ORB_COLORS)
      : (Math.random() < 0.012 ? 8 : Math.floor(Math.random() * ORB_COLORS)), // c=8 → ⚡ Volt Crate
  });
}
for (let i = 0; i < ORB_COUNT; i++) spawnOrb();

function radiusFor(mass) { return 5 + Math.sqrt(mass) * 0.55; }
function segCountFor(mass) { return Math.max(10, Math.floor(mass / 6)); }

function makeSnake(name, skin, isBot, ws) {
  const id = rid();
  const x = rand(400, WORLD - 400), y = rand(400, WORLD - 400);
  const s = {
    id, name: (name || 'viper').slice(0, 16), skin: SKINS[skin] ? skin : 'volt',
    isBot: !!isBot, ws: ws || null,
    x, y, angle: rand(0, Math.PI * 2), targetAngle: 0,
    mass: START_MASS, boost: false, dead: false,
    path: [], kills: 0, coinsEarned: 0,
    botState: isBot ? { t: 0, tx: rand(400, WORLD - 400), ty: rand(400, WORLD - 400) } : null,
    spawnProtect: tickCount + 60,
    joinedAt: Date.now(),
  };
  s.targetAngle = s.angle;
  for (let i = 0; i < 40; i++) s.path.push({ x, y });
  snakes.set(id, s);
  return s;
}

for (let i = 0; i < BOT_COUNT; i++) {
  makeSnake(BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
    Object.keys(SKINS)[Math.floor(Math.random() * Object.keys(SKINS).length)], true);
}

/* ---------- Bot AI ---------- */
function botThink(s) {
  const b = s.botState;
  b.t--;
  if (b.t <= 0) {
    b.t = 20 + Math.floor(Math.random() * 30);
    let best = null, bd = Infinity;
    for (const o of orbs.values()) {
      const d = dist2(s.x, s.y, o.x, o.y);
      if (d < bd && d < 600 * 600) { bd = d; best = o; }
    }
    if (best && Math.random() < 0.85) { b.tx = best.x; b.ty = best.y; }
    else { b.tx = rand(300, WORLD - 300); b.ty = rand(300, WORLD - 300); }
  }
  let danger = null, dd = Infinity;
  const lookX = s.x + Math.cos(s.angle) * 120, lookY = s.y + Math.sin(s.angle) * 120;
  for (const o of snakes.values()) {
    if (o.id === s.id || o.dead) continue;
    for (let i = 0; i < o.path.length; i += 6) {
      const p = o.path[i];
      const d = dist2(lookX, lookY, p.x, p.y);
      if (d < dd && d < 130 * 130) { dd = d; danger = p; }
    }
  }
  if (danger) {
    s.targetAngle = Math.atan2(lookY - danger.y, lookX - danger.x);
  } else {
    s.targetAngle = Math.atan2(b.ty - s.y, b.tx - s.x);
  }
  const m = 220;
  if (s.x < m || s.y < m || s.x > WORLD - m || s.y > WORLD - m) {
    s.targetAngle = Math.atan2(WORLD / 2 - s.y, WORLD / 2 - s.x);
  }
  s.boost = !danger && s.mass > 220 && Math.random() < 0.06;
}

/* ---------- Death ---------- */
function killSnake(s, killerName) {
  if (s.dead) return;
  s.dead = true;
  const step = Math.max(1, Math.floor(s.path.length / Math.max(1, Math.floor(s.mass / 9))));
  for (let i = 0; i < s.path.length; i += step) {
    const p = s.path[i];
    if (orbs.size < ORB_COUNT * 2.2) {
      spawnOrb(p.x + rand(-12, 12), p.y + rand(-12, 12), 4);
    }
  }
  killFeed.push({ k: killerName || 'the wall', v: s.name, t: Date.now() });
  if (killFeed.length > 6) killFeed.shift();

  if (s.isBot) {
    snakes.delete(s.id);
    setTimeout(() => {
      makeSnake(BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
        Object.keys(SKINS)[Math.floor(Math.random() * Object.keys(SKINS).length)], true);
    }, 2500);
  } else {
    addPlaytime(s.name, (Date.now() - s.joinedAt) / 1000);
  }
  if (!s.isBot && s.ws && s.ws.readyState === 1) {
    const coins = Math.max(5, Math.floor(s.mass / 12)) + s.kills * 15;
    s.coinsEarned = coins;
    send(s.ws, {
      t: 'dead',
      mass: Math.floor(s.mass),
      kills: s.kills,
      coins,
      reviveCost: REVIVE_COST,
      reviveMass: Math.floor(s.mass * 0.5),
    });
  }
}

/* ---------- Game tick ---------- */
function tick() {
  tickCount++;
  for (const s of snakes.values()) {
    if (s.dead) continue;
    if (s.isBot) botThink(s);

    let da = s.targetAngle - s.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const maxTurn = TURN_RATE * (30 / (20 + radiusFor(s.mass)));
    s.angle += Math.max(-maxTurn, Math.min(maxTurn, da));

    let speed = BASE_SPEED;
    if (s.boost && s.mass > 90) {
      speed = BOOST_SPEED;
      s.mass -= 0.55;
      if (tickCount % 4 === 0) spawnOrb(s.path[s.path.length - 1].x, s.path[s.path.length - 1].y, 1);
    }
    speed *= Math.max(0.72, 1 - s.mass / 9000);

    s.x += Math.cos(s.angle) * speed;
    s.y += Math.sin(s.angle) * speed;

    const r = radiusFor(s.mass);
    if (s.x < r || s.y < r || s.x > WORLD - r || s.y > WORLD - r) { killSnake(s, null); continue; }

    s.path.unshift({ x: s.x, y: s.y });
    const needed = segCountFor(s.mass) * SEG_SPACING;
    while (s.path.length > needed) s.path.pop();

    const eatR = r + 14;
    for (const o of orbs.values()) {
      if (dist2(s.x, s.y, o.x, o.y) < eatR * eatR) {
        s.mass += o.c === 8 ? 12 : o.v;
        if (o.c === 8 && !s.isBot && s.ws && s.ws.readyState === 1) {
          send(s.ws, { t: 'crate', coins: 20 + Math.floor(Math.random() * 61) });
        }
        orbs.delete(o.id);
      }
    }
  }

  const alive = [...snakes.values()].filter(s => !s.dead);
  for (const s of alive) {
    if (tickCount < s.spawnProtect) continue;
    const r = radiusFor(s.mass);
    for (const o of alive) {
      if (o.id === s.id || o.dead) continue;
      const or = radiusFor(o.mass);
      const hit2 = (r + or) * (r + or) * 0.55;
      for (let i = 4; i < o.path.length; i += 4) {
        const p = o.path[i];
        if (dist2(s.x, s.y, p.x, p.y) < hit2) {
          o.kills++;
          if (s.bounty && !o.isBot && o.ws && o.ws.readyState === 1) {
            send(o.ws, { t: 'bounty', coins: 250 });
          }
          killSnake(s, o.name);
          break;
        }
      }
      if (s.dead) break;
    }
  }

  while (orbs.size < ORB_COUNT) spawnOrb();

  if (tickCount % BROADCAST_EVERY === 0) broadcast();
}

/* ---------- Wire format ---------- */
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }

function snakeWire(s) {
  const pts = [];
  for (let i = 0; i < s.path.length; i += 4) pts.push(Math.round(s.path[i].x), Math.round(s.path[i].y));
  return {
    id: s.id, n: s.name, sk: s.skin, m: Math.floor(s.mass),
    x: Math.round(s.x), y: Math.round(s.y), a: +s.angle.toFixed(2),
    b: s.boost ? 1 : 0, g: s.bounty ? 1 : 0, p: pts,
  };
}

function broadcast() {
  const alive = [...snakes.values()].filter(s => !s.dead);
  const top = alive.slice().sort((a, b) => b.mass - a.mass).slice(0, 10)
    .map(s => ({ n: s.name, m: Math.floor(s.mass), bot: s.isBot ? 1 : 0 }));

  for (const s of snakes.values()) {
    if (s.isBot || !s.ws || s.ws.readyState !== 1) continue;
    const vr2 = VIEW_RADIUS * VIEW_RADIUS;
    const near = alive.filter(o => o.id === s.id || dist2(s.x, s.y, o.x, o.y) < vr2 * 2.2)
      .map(snakeWire);
    const nearOrbs = [];
    for (const o of orbs.values()) {
      if (dist2(s.x, s.y, o.x, o.y) < vr2) nearOrbs.push([o.id, Math.round(o.x), Math.round(o.y), o.v, o.c]);
    }
    const blips = alive.map(o => [Math.round(o.x / WORLD * 100), Math.round(o.y / WORLD * 100), o.id === s.id ? 1 : (o.bounty ? 2 : 0)]);
    send(s.ws, {
      t: 's', me: s.dead ? null : s.id, snakes: near, orbs: nearOrbs,
      top, feed: killFeed, blips, world: WORLD,
    });
  }
}

setInterval(tick, TICK_MS);

/* ---------- 💰 Bounty viper: golden target worth big coins ---------- */
setInterval(() => {
  const hasBounty = [...snakes.values()].some(s => s.bounty && !s.dead);
  if (!hasBounty && Math.random() < 0.6) {
    const b = makeSnake('⚡BOUNTY⚡', 'gold', true);
    b.bounty = true;
    b.mass = 420;
    killFeed.push({ k: '💰 A BOUNTY', v: 'entered the arena', t: Date.now() });
    if (killFeed.length > 6) killFeed.shift();
  }
}, 40000);

/* =========================================================
   HTTP server (static + API) — no frameworks
   ========================================================= */
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleApi(req, res, u) {
  if (u.pathname === '/api/config') {
    return json(res, 200, {
      skins: Object.fromEntries(Object.entries(SKINS).map(([k, v]) => [k, { name: v.name, cost: v.cost, colors: v.colors }])),
      coinPacks: Object.fromEntries(Object.entries(COIN_PACKS).map(([k, v]) => [k, { name: v.name, coins: v.coins, usd: v.usd }])),
      reviveCost: REVIVE_COST,
      boostPackCost: BOOST_PACK_COST,
      stripeMode: STRIPE_KEY ? (STRIPE_KEY.startsWith('sk_live') ? 'live' : 'test') : 'simulated',
    });
  }
  if (u.pathname === '/api/prizes') {
    const liveSecs = {};
    for (const s of snakes.values()) {
      if (!s.isBot && !s.dead) liveSecs[s.name] = (liveSecs[s.name] || 0) + (Date.now() - s.joinedAt) / 1000;
    }
    const totals = { ...monthly.players };
    for (const [n, secs] of Object.entries(liveSecs)) totals[n] = (totals[n] || 0) + secs;
    const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, secs], i) => ({ rank: i + 1, name, minutes: Math.round(secs / 60), share: PRIZE_SPLIT[i] }));
    return json(res, 200, { month: monthly.month, pool: PRIZE_POOL, split: PRIZE_SPLIT, top });
  }
  if (u.pathname === '/api/checkout' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let pack;
      try { pack = COIN_PACKS[JSON.parse(body).pack]; } catch (_) {}
      if (!pack) return json(res, 400, { error: 'unknown pack' });
      if (!STRIPE_KEY) return json(res, 200, { simulated: true, coins: pack.coins });
      try {
        const origin = PUBLIC_URL || `http${req.socket.encrypted ? 's' : ''}://${req.headers.host}`;
        const packKey = Object.keys(COIN_PACKS).find(k => COIN_PACKS[k] === pack);
        const session = await stripeCall('POST', '/v1/checkout/sessions', {
          'mode': 'payment',
          'line_items[0][price_data][currency]': 'usd',
          'line_items[0][price_data][product_data][name]': pack.name,
          'line_items[0][price_data][unit_amount]': String(pack.usd),
          'line_items[0][quantity]': '1',
          'success_url': `${origin}/?paid=${packKey}&session_id={CHECKOUT_SESSION_ID}`,
          'cancel_url': `${origin}/?canceled=1`,
        });
        json(res, 200, { url: session.url });
      } catch (e) {
        console.error('stripe error', e.message);
        json(res, 500, { error: 'checkout failed' });
      }
    });
    return;
  }
  if (u.pathname === '/api/verify') {
    if (!STRIPE_KEY) return json(res, 200, { paid: false });
    try {
      const sid = u.searchParams.get('session_id') || '';
      if (!/^cs_[a-zA-Z0-9_]+$/.test(sid)) return json(res, 200, { paid: false });
      const session = await stripeCall('GET', `/v1/checkout/sessions/${sid}`);
      const pack = COIN_PACKS[u.searchParams.get('pack') || ''];
      return json(res, 200, { paid: session.payment_status === 'paid', coins: pack ? pack.coins : 0 });
    } catch (e) { return json(res, 200, { paid: false }); }
  }
  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) return handleApi(req, res, u).catch(() => json(res, 500, { error: 'server error' }));
  // static
  let file = u.pathname === '/' ? '/index.html' : u.pathname;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* =========================================================
   Minimal WebSocket server (RFC 6455) — no deps
   ========================================================= */
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function makeWS(socket) {
  const ws = {
    readyState: 1,
    _handlers: { message: [], close: [] },
    on(ev, fn) { if (this._handlers[ev]) this._handlers[ev].push(fn); },
    send(str) { if (this.readyState === 1 && socket.writable) socket.write(wsFrame(str)); },
    close() { this.readyState = 3; try { socket.end(); } catch (_) {} },
  };
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { ws.close(); return; } // 1MB sanity cap
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len);
      if (masked) {
        const mask = buf.slice(maskOff, maskOff + 4);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
        payload = un;
      }
      buf = buf.slice(off + len);
      if (opcode === 8) { ws.close(); emit('close'); return; }
      if (opcode === 9) { // ping -> pong
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
        if (socket.writable) socket.write(pong);
        continue;
      }
      if (opcode === 1 && fin) emit('message', payload.toString('utf8'));
      // (fragmented frames and binary ignored — client only sends small text)
    }
  });
  function emit(ev, arg) { for (const fn of ws._handlers[ev]) { try { fn(arg); } catch (_) {} } }
  socket.on('close', () => { if (ws.readyState !== 3) { ws.readyState = 3; emit('close'); } });
  socket.on('error', () => { try { socket.destroy(); } catch (_) {} });
  return ws;
}

server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws' || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy(); return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  const ws = makeWS(socket);
  let snake = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.t === 'join') {
      if (snake && !snake.dead) return;
      if (snake) snakes.delete(snake.id);
      snake = makeSnake(String(msg.name || ''), msg.skin, false, ws);
      if (msg.startBoost) snake.mass += 600;
      send(ws, { t: 'joined', id: snake.id, world: WORLD });
    } else if (msg.t === 'input' && snake && !snake.dead) {
      if (typeof msg.a === 'number' && isFinite(msg.a)) snake.targetAngle = msg.a;
      snake.boost = !!msg.b;
    } else if (msg.t === 'revive' && snake && snake.dead) {
      const keep = Math.max(START_MASS, Math.floor(snake.mass * 0.5));
      const old = snake;
      snakes.delete(old.id);
      snake = makeSnake(old.name, old.skin, false, ws);
      snake.mass = keep;
      snake.kills = old.kills;
      send(ws, { t: 'joined', id: snake.id, world: WORLD, revived: 1 });
    }
  });

  ws.on('close', () => {
    if (snake) { killSnake(snake, null); snake.ws = null; snakes.delete(snake.id); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(
  `⚡ VoltVipers running on http://localhost:${PORT} — store mode: ${STRIPE_KEY ? (STRIPE_KEY.startsWith('sk_live') ? 'LIVE' : 'test') : 'simulated'}`));
