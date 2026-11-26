const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'results', 'slow-media-v3');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const LOCAL_URL = process.env.LOCAL_VIEWER_URL || 'http://127.0.0.1:8088/';
const PAGED_URL = process.env.PAGED_VIEWER_URL || 'http://127.0.0.1:8089/';
const RAD_SCENE_URL = process.env.RAD_SCENE_URL
  || 'http://127.0.0.1:8089/scenes/83781dbf575810710dec15ae626844c6/building-lod.rad';
const BUILDING_CAMERA = {
  position: [-123.97197986133273, -0.8833597651657765, 304.001000303404],
  rotation: [
    [-0.9253003202376402, -0.26132772026187595, 0.27482201511314847],
    [0.013892734620683743, 0.700829790443975, 0.7131932394176306],
    [-0.3789806186243303, 0.6637359621483421, -0.6448474728632614],
  ],
  fy: 2981.5512695312505,
  height: 3456,
};

const jobs = {
  local399: {
    mode: 'local',
    name: '01-local-building-399k-splat-slow',
    model: path.join(ROOT, 'tests', 'generated', 'citygaussian', 'building_399k.splat'),
    source: 'CityGaussian Mill-19 Building / building_c20_r4_light_40_vq point_cloud.ply',
    format: 'SPLAT',
    gaussians: 399100,
    camera: BUILDING_CAMERA,
  },
  local998: {
    mode: 'local',
    name: '02-local-building-998k-splat-slow',
    model: path.join(ROOT, 'tests', 'generated', 'citygaussian', 'building_998k.splat'),
    source: 'CityGaussian Mill-19 Building / building_c20_r4_light_40_vq point_cloud.ply',
    format: 'SPLAT',
    gaussians: 997751,
    camera: BUILDING_CAMERA,
  },
  paged: {
    mode: 'paged',
    name: '03-paged-building-7p98m-rad-radc-slow',
    source: 'CityGaussian Mill-19 Building converted from 7.98M Gaussian PLY',
    format: 'RAD + RADC',
    gaussians: 7982010,
    camera: BUILDING_CAMERA,
  },
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startMp4Recorder(page, selector, filename) {
  await page.waitForSelector(selector, { timeout: 60000 });
  await page.evaluate(({ selector, filename }) => {
    const source = document.querySelector(selector);
    if (!(source instanceof HTMLCanvasElement)) throw new Error(`Expected canvas: ${selector}`);
    const mimeCandidates = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4;codecs=avc1',
      'video/mp4',
    ];
    const mimeType = mimeCandidates.find(value => MediaRecorder.isTypeSupported(value));
    if (!mimeType) throw new Error('This Chrome build cannot record MP4/H.264');
    const stream = source.captureStream(24);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.start(1000);
    window.__slowCapture = { recorder, chunks, filename, mimeType, stream };
  }, { selector, filename });
}

async function stopMp4Recorder(page, outputPath) {
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.evaluate(async () => {
    const capture = window.__slowCapture;
    if (!capture) throw new Error('Recorder was not started');
    await new Promise(resolve => {
      capture.recorder.onstop = resolve;
      capture.recorder.stop();
    });
    capture.stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(capture.chunks, { type: capture.mimeType });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = capture.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  });
  const download = await downloadPromise;
  await download.saveAs(outputPath);
}

async function startSlowCameraMotion(page, viewerGlobal) {
  await page.evaluate(viewerGlobal => {
    const viewer = window[viewerGlobal];
    if (!viewer?.camera || !viewer?.controls) throw new Error(`Viewer unavailable: ${viewerGlobal}`);
    const camera = viewer.camera;
    const controls = viewer.controls;
    const baseTarget = controls.target.clone();
    const baseOffset = camera.position.clone().sub(baseTarget);
    const radius = baseOffset.length();
    const worldUp = camera.up.clone().normalize();
    const baseForward = baseTarget.clone().sub(camera.position).normalize();
    const baseRight = baseForward.clone().cross(worldUp).normalize();

    const keyframes = [
      { t: 0.0, panX: 0.00, panY: 0.00, yaw: 0.00, pitch: 0.00, zoom: 1.00 },
      { t: 2.5, panX: 0.00, panY: 0.00, yaw: 0.00, pitch: 0.00, zoom: 1.00 },
      { t: 6.5, panX: -0.055, panY: 0.00, yaw: -0.055, pitch: 0.00, zoom: 1.00 },
      { t: 10.5, panX: 0.055, panY: 0.00, yaw: 0.055, pitch: 0.00, zoom: 1.00 },
      { t: 13.5, panX: 0.00, panY: 0.00, yaw: 0.00, pitch: 0.00, zoom: 1.00 },
      { t: 17.5, panX: 0.00, panY: 0.045, yaw: 0.00, pitch: -0.04, zoom: 1.00 },
      { t: 21.5, panX: 0.00, panY: -0.045, yaw: 0.00, pitch: 0.04, zoom: 1.00 },
      { t: 24.5, panX: 0.00, panY: 0.00, yaw: 0.00, pitch: 0.00, zoom: 1.00 },
      { t: 28.5, panX: 0.00, panY: 0.00, yaw: 0.00, pitch: 0.00, zoom: 0.86 },
      { t: 32.5, panX: 0.00, panY: 0.00, yaw: 0.00, pitch: 0.00, zoom: 1.10 },
      { t: 35.0, panX: 0.00, panY: 0.00, yaw: 0.00, pitch: 0.00, zoom: 1.00 },
    ];
    const ease = value => value * value * (3 - 2 * value);
    const interpolate = (a, b, alpha, key) => a[key] + (b[key] - a[key]) * alpha;
    const findSegment = seconds => {
      for (let index = 1; index < keyframes.length; index++) {
        if (seconds <= keyframes[index].t) return [keyframes[index - 1], keyframes[index]];
      }
      return [keyframes.at(-2), keyframes.at(-1)];
    };

    const gl = viewer.renderer?.getContext?.();
    const debug = gl?.getExtension?.('WEBGL_debug_renderer_info');
    const rendererName = gl
      ? (debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      : 'unknown';
    const originalRender = viewer.renderer?.render;
    let renderedFrames = 0;
    if (originalRender) {
      viewer.renderer.render = function countedRender(...args) {
        renderedFrames++;
        return originalRender.apply(this, args);
      };
    }
    viewer.beginInteraction?.();
    const started = performance.now();
    window.__slowMotionPromise = new Promise(resolve => {
      const tick = now => {
        const seconds = (now - started) / 1000;
        const [a, b] = findSegment(seconds);
        const alpha = ease(Math.min(1, Math.max(0, (seconds - a.t) / Math.max(0.001, b.t - a.t))));
        const state = {};
        for (const key of ['panX', 'panY', 'yaw', 'pitch', 'zoom']) state[key] = interpolate(a, b, alpha, key);
        const target = baseTarget.clone()
          .addScaledVector(baseRight, state.panX * radius)
          .addScaledVector(worldUp, state.panY * radius);
        const offset = baseOffset.clone()
          .applyAxisAngle(worldUp, state.yaw)
          .applyAxisAngle(baseRight, state.pitch)
          .multiplyScalar(state.zoom);
        controls.target.copy(target);
        camera.position.copy(target).add(offset);
        camera.lookAt(target);
        controls.update();
        viewer.requestRender?.(3);
        if (seconds >= keyframes.at(-1).t) {
          viewer.endInteraction?.();
          if (originalRender) viewer.renderer.render = originalRender;
          const elapsedMs = performance.now() - started;
          resolve({ elapsedMs, renderedFrames, fps: renderedFrames * 1000 / elapsedMs, rendererName });
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  }, viewerGlobal);
}

async function applyTrainingCamera(page, viewerGlobal, cameraSpec) {
  await page.evaluate(({ viewerGlobal, cameraSpec }) => {
    const viewer = window[viewerGlobal];
    const camera = viewer.camera;
    const controls = viewer.controls;
    const [px, py, pz] = cameraSpec.position;
    const rotation = cameraSpec.rotation;
    const forward = {
      x: rotation[0][2], y: rotation[1][2], z: rotation[2][2],
    };
    const up = {
      x: -rotation[0][1], y: -rotation[1][1], z: -rotation[2][1],
    };
    const distance = 300;
    camera.position.set(px, py, pz);
    camera.up.set(up.x, up.y, up.z).normalize();
    controls.target.set(
      px + forward.x * distance,
      py + forward.y * distance,
      pz + forward.z * distance,
    );
    camera.fov = 2 * Math.atan(cameraSpec.height / (2 * cameraSpec.fy)) * 180 / Math.PI;
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    controls.update();
    viewer.requestRender?.(5);
  }, { viewerGlobal, cameraSpec });
  await page.waitForTimeout(1200);
}

async function saveCanvasPng(page, selector, outputPath) {
  const dataUrl = await page.evaluate(selector => {
    const canvas = document.querySelector(selector);
    return canvas.toDataURL('image/png');
  }, selector);
  await fsp.writeFile(outputPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

async function captureKeyframes(page, selector, imageDir, prefix) {
  const times = [2500, 6500, 10500, 17500, 28500, 34500];
  let previous = 0;
  for (let index = 0; index < times.length; index++) {
    await sleep(times[index] - previous);
    previous = times[index];
    await page.screenshot({
      path: path.join(imageDir, `${prefix}-${String(index + 1).padStart(2, '0')}.png`),
    });
  }
}

async function runJob(browser, key, job) {
  const jobDir = path.join(OUT, job.name);
  const imageDir = path.join(jobDir, 'images');
  await fsp.mkdir(imageDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
    recordVideo: { dir: path.join(jobDir, 'raw-video'), size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => {
    errors.push(error.message);
    console.error(`[${job.name}] pageerror: ${error.message}`);
  });
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(message.text());
      console.error(`[${job.name}] console: ${message.text()}`);
    }
  });
  let viewerGlobal;
  if (job.mode === 'local') {
    await fsp.access(job.model);
    await page.addInitScript(() => {
      window.LUMA_DIRECT_SPLAT_LIMIT = 99_000_000;
      window.LUMA_DISABLE_ADAPTIVE_ON_DEMAND = true;
    });
    await page.goto(LOCAL_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.locator('#qualitySelect').selectOption('high');
    await page.locator('#fileInput').setInputFiles(job.model);
    console.log(`[${job.name}] input selected; waiting for parser and GPU upload`);
    await page.waitForFunction(() => window.__lumaViewer?.splatMesh?.getSplatCount?.() > 0, null, { timeout: 600000 });
    await page.waitForFunction(() => window.__lumaViewer?.splatRenderReady === true, null, { timeout: 600000 });
    await page.waitForFunction(() => !document.querySelector('#loading')?.classList.contains('visible'), null, { timeout: 600000 });
    console.log(`[${job.name}] model is render-ready`);
    viewerGlobal = '__lumaViewer';
  } else {
    await page.goto(PAGED_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.locator('#streamMode').click();
    await page.locator('#streamUrl').fill(RAD_SCENE_URL);
    await page.locator('#loadStreamUrl').click();
    await page.waitForFunction(() => window.__lumaPagedViewer?.mesh?.isInitialized, null, { timeout: 180000 });
    // One decoded page is sufficient to start. A page may legitimately contain
    // fewer than 100k splats, so a fixed 100k gate can reject a healthy scene.
    await page.waitForFunction(() => window.__lumaPagedViewer?.spark?.activeSplats > 0, null, { timeout: 180000 });
    await page.waitForFunction(() => Boolean(window.__lumaPagedViewer?.home), null, { timeout: 60000 });
    await page.evaluate(() => window.__lumaPagedViewer.reset());
    await page.waitForTimeout(5000);
    viewerGlobal = '__lumaPagedViewer';
  }

  const selector = '#viewport canvas';
  if (job.mode === 'local') {
    await applyTrainingCamera(page, viewerGlobal, job.camera);
  } else {
    await page.evaluate(() => {
      const viewer = window.__lumaPagedViewer;
      viewer.reset();
      // The first resident page can yield an overly conservative bounding
      // sphere. Move 72% toward the scene center for a human-scale overview.
      viewer.camera.position.lerp(viewer.controls.target, 0.72);
      viewer.camera.lookAt(viewer.controls.target);
      viewer.controls.update();
      viewer.requestRender(30);
    });
    await page.waitForTimeout(5000);
  }
  await page.addStyleTag({ content: `
    body > * { visibility: hidden !important; }
    #viewport, #viewport * { visibility: visible !important; }
    #viewport { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important; background: #000 !important; }
    #viewport canvas { width: 100vw !important; height: 100vh !important; }
  ` });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(imageDir, `${job.name}-initial.png`) });
  await startSlowCameraMotion(page, viewerGlobal);
  const keyframes = captureKeyframes(page, selector, imageDir, job.name);
  const metrics = await page.evaluate(() => window.__slowMotionPromise);
  await keyframes;
  await page.waitForTimeout(500);
  const state = await page.evaluate(viewerGlobal => {
    const viewer = window[viewerGlobal];
    return {
      activeSplats: viewerGlobal === '__lumaPagedViewer'
        ? viewer.spark.activeSplats
        : viewer.splatMesh.getSplatCount(),
      maxPagedSplats: viewer.spark?.maxPagedSplats ?? null,
      pixelRatio: viewer.renderer?.getPixelRatio?.() ?? null,
      uiFps: document.querySelector('#fpsValue')?.textContent?.trim() ?? null,
      fileName: document.querySelector('#fileName')?.textContent?.trim() ?? null,
    };
  }, viewerGlobal);
  const result = {
    key,
    name: job.name,
    mode: job.mode,
    source: job.source,
    format: job.format,
    declaredGaussians: job.gaussians,
    modelBytes: job.model ? fs.statSync(job.model).size : null,
    videoBytes: null,
    durationSeconds: 35,
    captureFps: 24,
    measuredRenderFps: metrics.fps,
    renderedFrames: metrics.renderedFrames,
    rendererName: metrics.rendererName,
    ...state,
    errors,
  };
  const video = page.video();
  await page.close();
  await context.close();
  const rawVideoPath = path.join(jobDir, `${job.name}_raw.webm`);
  await fsp.copyFile(await video.path(), rawVideoPath);
  result.rawVideoBytes = fs.statSync(rawVideoPath).size;
  result.rawVideoPath = rawVideoPath;
  await fsp.writeFile(path.join(jobDir, 'metrics.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) throw new Error(`${job.name} browser errors: ${errors.join(' | ')}`);
}

(async () => {
  await fsp.mkdir(OUT, { recursive: true });
  const selected = process.argv.slice(2);
  const keys = selected.length ? selected : Object.keys(jobs);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--use-angle=d3d11',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  try {
    for (const key of keys) {
      if (!jobs[key]) throw new Error(`Unknown job: ${key}`);
      await runJob(browser, key, jobs[key]);
    }
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
