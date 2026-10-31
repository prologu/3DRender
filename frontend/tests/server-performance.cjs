const { chromium } = require('playwright-core');

(async () => {
  const baseUrl = process.env.VIEWER_URL || 'http://127.0.0.1:18088';
  const renderApi = process.env.RENDER_API;
  const durationMs = Number(process.env.DRAG_MS || 2400);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  if (renderApi) await page.addInitScript(value => { window.LUMA_RENDER_API = value; }, renderApi);

  const receivedAt = [];
  const sentAt = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    socket.on('framesent', event => {
      if (typeof event.payload === 'string') sentAt.push(performance.now());
    });
    socket.on('framereceived', event => {
      if (typeof event.payload !== 'string') receivedAt.push(performance.now());
    });
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#serverMode').click();
  await page.waitForFunction(() => {
    const viewport = document.querySelector('#serverViewport');
    const canvas = document.querySelector('#serverCanvas');
    return viewport.classList.contains('ready') && viewport.classList.contains('websocket') &&
      canvas.width >= 640 && document.querySelector('#welcome').classList.contains('hidden');
  }, null, { timeout: 30000 });
  const box = await page.locator('#serverViewport').boundingBox();
  const startedAt = performance.now();
  const targetAtStart = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y);
    return node ? `${node.tagName.toLowerCase()}#${node.id}.${node.className}` : null;
  }, { x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 });
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.5);
  await page.mouse.down();
  const steps = Math.max(1, Math.floor(durationMs / 16));
  for (let i = 0; i < steps; i++) {
    const phase = i / steps * Math.PI * 4;
    await page.mouse.move(
      box.x + box.width * (0.62 + Math.sin(phase) * 0.12),
      box.y + box.height * (0.5 + Math.cos(phase) * 0.1)
    );
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  const endedAt = performance.now();
  await page.waitForTimeout(500);

  const activeFrames = receivedAt.filter(value => value >= startedAt && value <= endedAt).length;
  const intervals = receivedAt.slice(1).map((value, index) => value - receivedAt[index]);
  const result = {
    duration_ms: Math.round(endedAt - startedAt),
    pointer_target: targetAtStart,
    frames_during_drag: activeFrames,
    camera_updates_sent: sentAt.filter(value => value >= startedAt && value <= endedAt).length,
    delivered_fps: Number((activeFrames * 1000 / (endedAt - startedAt)).toFixed(1)),
    median_interval_ms: intervals.length ? Math.round(intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)]) : null,
    ui_fps: await page.locator('#fpsValue').textContent(),
    metrics: await page.locator('#serverMetrics').textContent(),
    camera: await page.evaluate(() => ({ ...window.__lumaServerCamera })),
    errors
  };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();

  const minimum = Number(process.env.MIN_STREAM_FPS || 0);
  if (errors.length || result.delivered_fps < minimum) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
