const { chromium } = require('playwright-core');

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

(async () => {
  const baseUrl = process.env.VIEWER_URL || 'http://127.0.0.1:18091';
  const lodPercent = Math.min(100, Math.max(10, Number(process.env.LOD_PERCENT || 100)));
  const quality = process.env.QUALITY === 'high' ? 'high' : 'performance';
  const expectedWidth = quality === 'high' ? 1280 : 800;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  let websocketFrames = 0;
  let frameStats = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('websocket', socket => socket.on('framereceived', event => {
    websocketFrames++;
    const payload = event.payload;
    if (!Buffer.isBuffer(payload) || payload.length < 5) return;
    const statsLength = payload.readUInt32BE(0);
    if (statsLength < 1 || statsLength + 4 >= payload.length) return;
    try {
      frameStats.push(JSON.parse(payload.subarray(4, 4 + statsLength).toString('utf8')));
    } catch (_) { /* malformed packets are covered by the browser error assertions */ }
  }));
  await page.addInitScript(() => {
    window.__streamDraws = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      window.__streamDraws.push({
        at: performance.now(),
        width: source.width || source.videoWidth || 0,
        height: source.height || source.videoHeight || 0
      });
      return original.call(this, source, ...args);
    };
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#serverMode').click();
  await page.waitForFunction(() => document.querySelector('#serverCanvas').width > 0, null, { timeout: 30000 });
  await page.selectOption('#qualitySelect', quality);
  await page.locator('#lodSlider').evaluate((slider, value) => {
    slider.value = String(value);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, lodPercent);
  await page.waitForFunction(width => document.querySelector('#serverCanvas').width === width, expectedWidth, { timeout: 30000 });
  const fullGaussians = Number((await page.locator('#splatCount').textContent()).replace(/,/g, ''));
  const expectedGaussians = Math.trunc(fullGaussians * lodPercent / 100);
  const expectedLabel = expectedGaussians.toLocaleString('zh-CN');
  await page.waitForFunction(label => document.querySelector('#serverMetrics').textContent.includes(label), expectedLabel, { timeout: 30000 });

  const box = await page.locator('#serverViewport').boundingBox();
  await page.evaluate(() => { window.__streamDraws = []; });
  frameStats = [];
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.55);
  await page.mouse.down();
  for (let index = 0; index < 90; index++) {
    const phase = index / 89;
    await page.mouse.move(
      box.x + box.width * (0.25 + phase * 0.5),
      box.y + box.height * (0.55 + Math.sin(phase * Math.PI * 4) * 0.12)
    );
    await page.waitForTimeout(8);
  }
  await page.waitForFunction(() => window.__streamDraws.length > 0, null, { timeout: 10000 });
  const releasedAt = await page.evaluate(() => performance.now());
  await page.mouse.up();
  await page.waitForFunction(started => window.__streamDraws.some(frame => frame.at >= started), releasedAt, { timeout: 10000 });

  const result = await page.evaluate(started => {
    const draws = window.__streamDraws;
    const final = draws.find(frame => frame.at >= started);
    return {
      transport: document.querySelector('#serverViewport').classList.contains('websocket') ? 'websocket' : 'mjpeg',
      displayedFrames: draws.length,
      interactiveFrames: draws.filter(frame => frame.at < started).length,
      finalFrameLatencyMs: final ? Number((final.at - started).toFixed(1)) : null,
      finalWidth: document.querySelector('#serverCanvas').width,
      metrics: document.querySelector('#serverMetrics').textContent,
      drawTimes: draws.map(frame => frame.at)
    };
  }, releasedAt);
  const intervals = result.drawTimes.slice(1).map((time, index) => time - result.drawTimes[index]);
  result.medianDisplayIntervalMs = Number(median(intervals)?.toFixed(1));
  result.websocketFrames = websocketFrames;
  const interactiveStats = frameStats.filter(stats => stats.interactive);
  result.interactiveStats = interactiveStats.length;
  result.interactiveWidths = [...new Set(interactiveStats.map(stats => stats.width))];
  result.interactiveGaussianRange = interactiveStats.length
    ? [Math.min(...interactiveStats.map(stats => stats.gaussians)), Math.max(...interactiveStats.map(stats => stats.gaussians))]
    : [];
  result.expectedGaussians = expectedGaussians;
  result.lodPercent = lodPercent;
  result.quality = quality;
  result.errors = errors;
  delete result.drawTimes;
  console.log(JSON.stringify(result, null, 2));
  await browser.close();

  if (result.transport !== 'websocket' || result.interactiveFrames < 1 || result.interactiveStats < 1 ||
      result.finalWidth !== expectedWidth || result.finalFrameLatencyMs == null ||
      result.finalFrameLatencyMs > 5000 || result.interactiveWidths.some(width => width !== expectedWidth) ||
      result.interactiveGaussianRange.some(count => count !== expectedGaussians) || errors.length) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
