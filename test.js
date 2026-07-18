/* E2E smoke test: load page, join game, play, die-check, store, prizes */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'shot_menu.png' });

  // join the game
  await page.fill('#nameInput', 'SKYDOG');
  await page.click('#playBtn');
  await page.waitForTimeout(2500);
  const playing = await page.evaluate(() => !document.getElementById('menu').classList.contains('hidden') ? 'menu-still-open' : 'in-game');
  await page.mouse.move(900, 300);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'shot_game.png' });

  // HUD state
  const hud = await page.evaluate(() => ({
    mass: document.getElementById('scoreVal').textContent,
    coins: document.getElementById('coinVal').textContent,
    leaderRows: document.querySelectorAll('#leaderRows .row').length,
    snakes: window.__snakeCount === undefined ? 'n/a' : window.__snakeCount,
  }));

  // open store, simulated purchase
  await page.evaluate(() => window.openStore());
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'shot_store.png' });
  const coinsBefore = await page.evaluate(() => +localStorage.getItem('vv_coins') || 0);
  await page.evaluate(() => document.querySelector('#packRows .shoprow button').click());
  await page.waitForTimeout(600);
  const coinsAfter = await page.evaluate(() => +localStorage.getItem('vv_coins') || 0);

  // prizes board
  await page.evaluate(() => window.openPrizes());
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shot_prizes.png' });
  const prizeRows = await page.evaluate(() => document.querySelectorAll('#prizeRows tr').length);
  await page.evaluate(() => window.closeModals());

  // let it play a while (steer in circles), check still alive / death flow works
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(300 + Math.random() * 700, 200 + Math.random() * 500);
    await page.waitForTimeout(500);
  }
  const deathShown = await page.evaluate(() => !document.getElementById('death').classList.contains('hidden'));
  await page.screenshot({ path: 'shot_late.png' });

  console.log(JSON.stringify({ playing, hud, coinsBefore, coinsAfter, prizeRows, deathShown, errors }, null, 2));
  await browser.close();
})().catch(e => { console.error('TEST FAIL', e); process.exit(1); });
