const { chromium } = require('playwright-core');
const path = require('node:path');

(async () => {
  const baseUrl = process.env.VIEWER_URL || 'http://127.0.0.1:18088';
  const renderApi = process.env.RENDER_API;
  const expectedModel = process.env.EXPECTED_MODEL;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  if (renderApi) {
    await page.addInitScript((value) => { window.LUMA_RENDER_API = value; }, renderApi);
  }
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#serverMode').click();
  await page.waitForFunction(() => document.querySelector('#serverFrame').naturalWidth > 0, null, { timeout: 30000 });

  const before = await page.locator('#serverMetrics').textContent();
  const box = await page.locator('#serverViewport').boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.54, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(previous => document.querySelector('#serverMetrics').textContent !== previous, before, { timeout: 30000 });

  // Cross the old +/-87 degree pitch boundary. The camera must continue
  // smoothly through the pole instead of clamping or producing a degenerate
  // screen basis.
  // Start below the top toolbar overlay so pointerdown reaches the viewport.
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.95, { steps: 16 });
  await page.mouse.up();
  const poleState = await page.evaluate(() => {
    const camera = window.__lumaServerCamera;
    const basis = window.__lumaCameraBasis(camera.yaw, camera.pitch);
    const length = vector => Math.hypot(...vector);
    const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
    return {
      pitch: camera.pitch,
      finite: [...basis.forward, ...basis.right, ...basis.up].every(Number.isFinite),
      lengths: [length(basis.forward), length(basis.right), length(basis.up)],
      dots: [dot(basis.forward, basis.right), dot(basis.forward, basis.up), dot(basis.right, basis.up)]
    };
  });
  if (Math.abs(poleState.pitch) <= Math.PI / 2 || !poleState.finite ||
      poleState.lengths.some(value => Math.abs(value - 1) > 1e-6) ||
      poleState.dots.some(value => Math.abs(value) > 1e-6)) {
    throw new Error(`continuous 360 camera basis failed: ${JSON.stringify(poleState)}`);
  }

  await page.selectOption('#qualitySelect', 'performance');
  await page.waitForFunction(() => {
    const frame = document.querySelector('#serverFrame');
    return document.querySelector('#serverMetrics').textContent.includes('800×450') && frame.naturalWidth === 800;
  }, null, { timeout: 30000 });
  await page.screenshot({ path: path.resolve('tests/server-viewer.png'), fullPage: true });

  const result = await page.evaluate(() => ({
    file: document.querySelector('#fileName').textContent,
    splats: document.querySelector('#splatCount').textContent,
    backend: document.querySelector('#backendLabel').textContent,
    badge: document.querySelector('#webglBadge').textContent.trim(),
    metrics: document.querySelector('#serverMetrics').textContent,
    streaming: document.querySelector('#serverFrame').src.includes('/api/session/'),
    pitchAfterPole: window.__lumaServerCamera.pitch,
    width: document.querySelector('#serverFrame').naturalWidth,
    height: document.querySelector('#serverFrame').naturalHeight
  }));
  result.errors = errors;
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if ((expectedModel && result.file !== expectedModel) || result.splats === '—' || result.width !== 800 || result.height !== 450 || errors.length) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
