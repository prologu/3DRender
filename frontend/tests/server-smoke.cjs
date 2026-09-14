const { chromium } = require('playwright');
const path = require('node:path');

(async () => {
  const baseUrl = process.env.VIEWER_URL || 'http://127.0.0.1:18088';
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#serverMode').click();
  await page.waitForFunction(() => document.querySelector('#serverFrame').naturalWidth > 0, null, { timeout: 30000 });

  const before = await page.locator('#serverFrame').getAttribute('src');
  const box = await page.locator('#serverViewport').boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.54, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(previous => document.querySelector('#serverFrame').src !== previous, before, { timeout: 30000 });
  await page.selectOption('#qualitySelect', 'performance');
  await page.waitForFunction(() => document.querySelector('#serverMetrics').textContent.includes('800×450'), null, { timeout: 30000 });
  await page.screenshot({ path: path.resolve('tests/server-viewer.png'), fullPage: true });

  const result = await page.evaluate(() => ({
    file: document.querySelector('#fileName').textContent,
    splats: document.querySelector('#splatCount').textContent,
    backend: document.querySelector('#backendLabel').textContent,
    badge: document.querySelector('#webglBadge').textContent.trim(),
    metrics: document.querySelector('#serverMetrics').textContent,
    width: document.querySelector('#serverFrame').naturalWidth,
    height: document.querySelector('#serverFrame').naturalHeight
  }));
  result.errors = errors;
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (result.file !== 'rgb_rawlight_gaussian_gt_fixed.ply' || result.splats !== '1,160,393' || result.width !== 800 || errors.length) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
