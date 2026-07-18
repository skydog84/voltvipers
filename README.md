# ⚡ VoltVipers — Neon Multiplayer Snake Arena

Eat orbs. Grow huge. Cut off other vipers. Top 10 most-active players every month split the prize pool.

**Prize & reward features:** monthly top-10 playtime prize pool · 💰 golden BOUNTY viper (kill it for +250 coins, spawns every ~minute) · ⚡ Volt Crates (rare gold orbs, +20–80 coins) · kill-streak bonuses (Double Kill → Rampage → Unstoppable) · 🎡 Daily Volt Spin wheel (free coins, once a day) · daily login streak bonus · mid-death revive.

**Electrified visuals:** lightning arcs crackle along boosting snakes, sparks fly off heads, the arena wall is a live electric fence, kills flash the screen, and the bounty viper glows gold with a halo of arcs.

**Zero dependencies.** Pure Node.js — no `npm install` needed, ever. One file runs the whole game.

## Run it locally

```bash
node server.js
```

Open http://localhost:3000. That's it. The arena always feels alive because 14 AI vipers play alongside real players (they respawn as real players join).

## Deploy it (free tier works)

Any host that runs Node works. Easiest options:

**Render.com (recommended, free tier):**
1. Push this folder to a GitHub repo.
2. In Render: New → Web Service → connect the repo.
3. Build command: *(leave empty)* — Start command: `node server.js`.
4. Deploy. You get a public `https://yourgame.onrender.com` URL with WebSockets working out of the box.

**Railway.app / Fly.io / a $5 VPS:** same thing — `node server.js` is the only command.

> Note: multiplayer needs a real server (WebSockets), so static hosts like GitHub Pages won't work.

## Turn on real money (Stripe)

The store ships in **simulated mode** (purchases are free demos) until you add keys:

1. Create a free account at stripe.com → Developers → API keys.
2. Set environment variables on your host:
   - `STRIPE_SECRET_KEY=sk_test_...` → **test mode** (card `4242 4242 4242 4242` completes checkout)
   - `PUBLIC_URL=https://yourgame.onrender.com` (your real URL)
3. When ready for real charges, swap in `sk_live_...`. That's the whole switch.

Revenue streams built in: coin packs ($1.99 / $4.99 / $9.99) → coins buy premium skins, Head Start boosts, and mid-death revives (the highest-converting purchase in the genre).

## Monthly prize pool

- Playtime per player name is tracked per calendar month (`monthly.json`).
- In-game prize board shows the top 10 and their % share (30/18/12/9/8/7/6/4/3/3).
- Set the advertised pool with an env var: `PRIZE_POOL="$500"` (default: "20% of all store revenue").
- Payouts are manual — you decide the pool, contact winners, and pay them out. 

**⚠️ Before paying real cash prizes:** contests funded by in-game purchases can trigger sweepstakes/contest regulations that vary by state/country. Common safeguards: a "no purchase necessary" route, published official rules, and age/region eligibility. Worth an hour with a template or a lawyer before the first payout. (Not legal advice.)

## Tuning knobs (top of server.js)

| Constant | What it does |
|---|---|
| `BOT_COUNT` | AI vipers keeping the arena alive (14) |
| `ORB_COUNT` | food density (900) |
| `WORLD` | arena size (4200) |
| `REVIVE_COST` | coins to revive with half your mass (60) |
| `COIN_PACKS` / `SKINS` | prices and catalog |
| `PRIZE_SPLIT` | top-10 prize percentages |

## Files

- `server.js` — game server, WebSocket netcode, Stripe, prize tracking (zero deps)
- `public/index.html` — UI shell + styles
- `public/game.js` — rendering, sounds, store, prize board
- `test.js` / `test2.js` — Playwright smoke tests (gameplay, store, death→revive)
