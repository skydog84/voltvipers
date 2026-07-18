/* Death + revive flow test: steer into the wall, verify death screen, revive */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.setItem('vv_coins', '500'));
  await page.fill('#nameInput', 'CRASHTEST');
  await page.click('#playBtn');
  await page.waitForTimeout(1500);

  // steer hard right into the wall until death screen appears
  await page.mouse.move(1270, 400);
  let died = false;
  for (let i = 0; i < 140; i++) {
    await page.waitForTimeout(500);
    died = await page.evaluate(() => !document.getElementById('death').classList.contains('hidden'));
    if (died) break;
  }
  await page.screenshot({ path: 'shot_death.png' });
  const deathStats = await page.evaluate(() => ({
    mass: document.getElementById('dMass').textContent,
    coins: document.getElementById('dCoins').textContent,
    reviveVisible: document.getElementById('reviveBtn').style.display !== 'none',
    walletCoins: localStorage.getItem('vv_coins'),
  }));

  // revive
  let revived = null;
  if (died) {
    await page.click('#reviveBtn');
    await page.waitForTimeout(1500);
    revived = await page.evaluate(() => ({
      backInGame: document.getElementById('death').classList.contains('hidden'),
      mass: document.getElementById('scoreVal').textContent,
      walletAfterRevive: localStorage.getItem('vv_coins'),
    }));
    await page.screenshot({ path: 'shot_revived.png' });
  }
  console.log(JSON.stringify({ died, deathStats, revived, errors }, null, 2));
  await browser.close();
})().catch(e => { console.error('TEST FAIL', e); process.exit(1); });
