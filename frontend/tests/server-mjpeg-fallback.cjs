const { chromium } = require('playwright-core');

(async () => {
  const baseUrl = process.env.VIEWER_URL || 'http://127.0.0.1:18091';
  const sessionsBefore = (await (await fetch(`${baseUrl}/api/status`)).json()).sessions.active;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: undefined });
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#serverMode').click();
  await page.waitForFunction(() => document.querySelector('#serverFrame').naturalWidth > 0, null, { timeout: 30000 });
  const before = await page.locator('#serverMetrics').textContent();
  const box = await page.locator('#serverViewport').boundingBox();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(previous => document.querySelector('#serverMetrics').textContent !== previous, before, { timeout: 30000 });
  const result = await page.evaluate(() => ({
    transport: document.querySelector('#serverViewport').classList.contains('websocket') ? 'websocket' : 'mjpeg',
    width: document.querySelector('#serverFrame').naturalWidth,
    height: document.querySelector('#serverFrame').naturalHeight,
    metrics: document.querySelector('#serverMetrics').textContent
  }));
  result.errors = errors;
  // Close the page first so the same pagehide cleanup used during normal
  // navigation can release the server session before the browser exits.
  await page.close();
  await browser.close();
  let sessionsAfter = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    sessionsAfter = (await (await fetch(`${baseUrl}/api/status`)).json()).sessions.active;
    if (sessionsAfter <= sessionsBefore) break;
  }
  result.sessionsBefore = sessionsBefore;
  result.sessionsAfter = sessionsAfter;
  console.log(JSON.stringify(result, null, 2));
  if (result.transport !== 'mjpeg' || result.width < 1 || result.height < 1 || errors.length) process.exit(1);
  if (sessionsAfter > sessionsBefore) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
