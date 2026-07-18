# ⚡ VOLTVIPERS — GOD MODE HANDOFF
**Owner:** SKYDOG (skydog8426@gmail.com) · **Date:** July 18, 2026 · **Goal: LIVE TODAY**
Launching alongside Skybox. Apple developer account pending → iOS wrapper is a fast-follow, web launches first.

---

## MISSION FOR THIS SESSION
The game is **built and browser-tested**. Your job is to take it from "works" to "live and earning":
deploy it publicly, wire real Stripe, polish anything rough, and prep the iOS wrapper so it's ready the
moment the Apple developer account clears. Do not rebuild what exists — extend it.

## WHAT THIS IS
**VoltVipers** — neon-cyber multiplayer snake arena (Slither-style, legally distinct: original name, art, code).
Eat orbs → grow → cut off other vipers. Real-money coin economy + monthly cash-prize leaderboard for the
top 10 most-active players (30/18/12/9/8/7/6/4/3/3 % split of the pool).

**Stack:** ZERO dependencies. Pure Node.js ≥18 — one command (`node server.js`), no npm install anywhere.
Hand-rolled RFC6455 WebSocket server, canvas client, WebAudio synth sounds, Stripe via raw REST.

## FILE MAP (project root: `voltvipers/`)
| File | What it is |
|---|---|
| `server.js` | Everything server: game loop (20 tps, broadcast 10/s), bot AI (14 bots), collision, orbs, bounty spawner, monthly playtime tracking (`monthly.json`), static hosting, `/api/*`, WebSocket impl, Stripe REST calls |
| `public/index.html` | UI shell + all CSS (menu, death screen, store, prize board, spin wheel modal) |
| `public/game.js` | All client logic: canvas rendering (glow, lightning, particles, shake, flash), interpolation, WebAudio sounds, store, spin wheel, streaks, localStorage wallet |
| `test.js` `test2.js` `test3.js` | Playwright smoke tests: gameplay/store · death→revive · spin/boost. Run: `NODE_PATH=$(npm root -g) node test.js` (server must be running) |
| `README.md` | Deploy + Stripe + tuning instructions |

## FEATURES ALREADY DONE ✅ (all browser-verified, zero console errors)
- Real-time multiplayer + 14 respawning AI bots so the arena is never empty
- Neon rendering: glow trails, electric arcs on boost, head sparks, electrified wall with live bolts, screen-flash on kills, screenshake, particles
- Sounds (all synthesized, no assets): rising-pitch combo eats, kill boom, death, boost crackle, purchase arpeggio, spin ticks, jackpot fanfare
- Economy: coins (earned by mass/kills/events) → skins (7, up to 2,500-coin 24K Gold), Head Start ×3 boost, 60-coin mid-death revive (server grants 50% mass back)
- Coin packs $1.99/$4.99/$9.99 → Stripe Checkout. Modes: **simulated** (no key) → **test** (`sk_test_`) → **live** (`sk_live_`). `/api/verify` confirms payment server-side before granting
- Retention: monthly top-10 playtime prize board (pulsing gold ticker in-game), 💰 bounty viper (+250 coins, ~every 40s), ⚡ Volt Crates (rare orbs, +20–80), kill streaks (+30/+60/+120/+300), Daily Volt Spin wheel (25–250, weighted, once/day), daily login streak (+25×day up to 7)

## ENV VARS (all optional)
`PORT` (3000) · `STRIPE_SECRET_KEY` · `PUBLIC_URL` (for Stripe redirects) · `PRIZE_POOL` (display string, default "20% of all store revenue")

## TODAY'S LAUNCH CHECKLIST — in order
1. **Deploy** — Render.com free tier: push `voltvipers/` to a GitHub repo → New Web Service → start command `node server.js`. WebSockets work out of the box. Verify with 2 browser tabs playing each other.
2. **Domain** (optional today): point DNS, set `PUBLIC_URL`.
3. **Stripe test → live**: add `sk_test_` key on the host, run a 4242-card purchase end-to-end, then swap to `sk_live_` when ready.
4. **Prize legal guardrail before first real payout** (not legal advice): skill/effort-based contest is safer than chance; add short Official Rules page + "no purchase necessary to compete" note; playtime (not spend) already decides winners — keep it that way. The Daily Spin only pays virtual coins — keep real money OUT of chance mechanics, especially for iOS review.
5. **Hardening (quick wins if time)**: per-IP join rate-limit; cap name length server-side (done, 16); profanity filter on names; `monthly.json` → move to a real DB later (fine as-is for launch).
6. **Share loop**: add a "Challenge your friends" copy-link button on the death screen (10-min task, biggest free growth lever).

## APPLE / iOS PLAN (when developer account clears)
- Wrap with **Capacitor** (WKWebView shell pointing at the deployed URL, or bundle the client and point WS at prod).
- ⚠️ **App Store rules that WILL bite:**
  - Digital goods (coins/skins) **must use Apple In-App Purchase** inside the iOS app — Stripe checkout in-app = rejection (guideline 3.1.1). Plan: detect the Capacitor shell → hide Stripe store → show IAP products (mirror the 3 packs) via a StoreKit bridge, grant coins through the same wallet.
  - Real-money prize contests are allowed **if skill-based** (3.2.2 permits contests with official rules; the app must state Apple is not a sponsor).
  - Web stays on Stripe (full margin); iOS pays Apple's cut — price accordingly.
- Touch controls already work (touchmove steering); add an on-screen boost button for mobile polish.

## KEY IMPLEMENTATION NOTES (read before editing)
- **Wire protocol** (JSON over WS): client→server `{t:'join'|'input'|'revive'}`; server→client `{t:'joined'|'s'|'dead'|'crate'|'bounty'}`. State frames send decimated paths (every 4th point) for snakes within ~1250px; client lerps between frames (110ms window).
- **Coins live client-side** in localStorage (`vv_coins`, `vv_owned`, `vv_boost`). Fine for launch; server-side accounts (email or device id keyed) are the top post-launch refactor since a savvy user can edit their own wallet. Real-money *payments* are already server-verified.
- **Orb `c` field**: 0–7 = palette color, **8 = Volt Crate** (client draws gold ⚡, server pays coins on eat).
- **Snake wire flags**: `b`=boosting, `g`=bounty (gold rendering + arcs).
- **Bounty spawner**: `setInterval` 40s in server.js, 60% chance if none alive, mass 420, name `⚡BOUNTY⚡`.
- **Prize split**: `PRIZE_SPLIT` array in server.js. Playtime accrues on death/disconnect + live-session time in `/api/prizes`.
- **Don't add npm deps** — the container that built this had registry blocked, and zero-dep is now a feature. Node built-ins only.
- Bash quirk in the original build env: shell cwd resets between commands — always `cd /home/claude/voltvipers` (or your path) explicitly.

## TUNING KNOBS (top of server.js)
`WORLD` 4200 · `BOT_COUNT` 14 · `ORB_COUNT` 900 · `BASE_SPEED` 3.6 / `BOOST_SPEED` 6.6 · `START_MASS` 120 · `REVIVE_COST` 60 · `COIN_PACKS` / `SKINS` / `PRIZE_SPLIT` inline.

## IDEAS BACKLOG (post-launch, in rough ROI order)
Friend-invite link on death screen → server-side wallets → battle pass ("Volt Pass", season = calendar month, pairs with prize month) → weekend 2× coin events → team mode → global chat → replay/share clips (TikTok fuel) → seasonal skins drops.

---

## GOD MODE CONTINUATION PROMPT (paste this to start the next session)
> You are in God mode finishing **VoltVipers**, a complete neon multiplayer snake arena in the attached/extracted `voltvipers/` folder — read `VOLTVIPERS_HANDOFF.md` first; it is the source of truth. The game is DONE and tested locally: do not rebuild it, do not add npm dependencies (pure Node built-ins is a hard rule). Today's mission in priority order: (1) deploy it publicly (Render or equivalent, start command `node server.js`) and verify two live browsers can play each other; (2) wire my Stripe test key end-to-end, then flip live when I say go; (3) add a share/challenge link to the death screen; (4) prep the Capacitor iOS wrapper with the Stripe-store hidden behind an Apple-IAP switch per the handoff's App Store notes — my Apple developer account is pending, so make it build-ready. Launch is coordinated with my other title, Skybox. Move fast, test everything in a real browser like the previous session did, and show me screenshots as you go.

**Current zip:** `voltvipers.zip` (v2, electrified build — attach it or the folder to the new session).
