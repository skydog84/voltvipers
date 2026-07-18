/* Electrified build test: boost lightning, spin wheel, crate/bounty plumbing */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'shot2_menu.png' });

  // spin wheel
  const spinBefore = await page.evaluate(() => +localStorage.getItem('vv_coins') || 0);
  await page.evaluate(() => window.openSpin());
  await page.waitForTimeout(400);
  await page.click('#spinBtn');
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'shot2_spin.png' });
  await page.waitForTimeout(2400);
  const spinAfter = await page.evaluate(() => +localStorage.getItem('vv_coins') || 0);
  const spinLocked = await page.evaluate(() => document.getElementById('spinBtn').disabled);
  await page.evaluate(() => window.closeModals());

  // join and boost near other snakes for lightning shot
  await page.fill('#nameInput', 'SKYDOG');
  await page.click('#playBtn');
  await page.waitForTimeout(2000);
  await page.mouse.move(900, 350);
  await page.mouse.down();           // boost = lightning arcs
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'shot2_boost.png' });
  await page.mouse.up();

  // survey the arena for a bit (bounty spawns within ~40-80s)
  let sawBounty = false, sawCrate = false;
  for (let i = 0; i < 24; i++) {
    await page.mouse.move(300 + Math.random() * 700, 200 + Math.random() * 450);
    await page.waitForTimeout(500);
    const st = await page.evaluate(() => {
      const dead = !document.getElementById('death').classList.contains('hidden');
      return { dead };
    });
    if (st.dead) { await page.click('#respawnBtn'); await page.waitForTimeout(1200); }
  }
  await page.screenshot({ path: 'shot2_late.png' });

  const hud = await page.evaluate(() => ({
    mass: document.getElementById('scoreVal').textContent,
    coins: localStorage.getItem('vv_coins'),
  }));
  console.log(JSON.stringify({ spinBefore, spinAfter, spinGain: spinAfter - spinBefore, spinLocked, hud, errors: errors.slice(0, 5) }, null, 2));
  await browser.close();
})().catch(e => { console.error('TEST FAIL', e); process.exit(1); });
