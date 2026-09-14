import './styles.css';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

const $ = (selector) => document.querySelector(selector);
const els = {
  viewport: $('#viewport'), welcome: $('#welcome'), dropzone: $('#dropzone'), fileInput: $('#fileInput'),
  openFileTop: $('#openFileTop'), loadDemo: $('#loadDemo'), loading: $('#loading'), loadingTitle: $('#loadingTitle'),
  loadingDetail: $('#loadingDetail'), progressBar: $('#progressBar'), progressText: $('#progressText'),
  modelPanel: $('#modelPanel'), toolbar: $('#toolbar'), controlHint: $('#controlHint'), fileType: $('#fileType'),
  fileName: $('#fileName'), fileSize: $('#fileSize'), splatCount: $('#splatCount'), fpsValue: $('#fpsValue'),
  togglePanel: $('#togglePanel'), closePanel: $('#closePanel'), resetView: $('#resetView'), screenshot: $('#screenshot'),
  fullscreen: $('#fullscreen'), backgroundSelect: $('#backgroundSelect'), qualitySelect: $('#qualitySelect'),
  dragOverlay: $('#dragOverlay'), toast: $('#toast'), webglBadge: $('#webglBadge'),
  clientMode: $('#clientMode'), serverMode: $('#serverMode'), serverViewport: $('#serverViewport'),
  serverFrame: $('#serverFrame'), serverMetrics: $('#serverMetrics'), welcomeDescription: $('#welcomeDescription'),
  dropTitle: $('#dropTitle'), dropSubtitle: $('#dropSubtitle'), backendLabel: $('#backendLabel'),
  renderModeLabel: $('#renderModeLabel'), privacyTitle: $('#privacyTitle'), privacyText: $('#privacyText')
};

const formats = {
  ply: GaussianSplats3D.SceneFormat.Ply,
  splat: GaussianSplats3D.SceneFormat.Splat,
  ksplat: GaussianSplats3D.SceneFormat.KSplat,
  spz: GaussianSplats3D.SceneFormat.Spz
};

let viewer = null;
let objectUrl = null;
let activeFile = null;
let toastTimer = null;
let frameCount = 0;
let fpsStartedAt = performance.now();
let dragDepth = 0;
let renderLocation = 'client';
let serverFrameUrl = null;
let serverStatus = null;
let serverRequestRunning = false;
let serverRequestPending = false;
let serverDrag = null;
const serverCamera = { yaw: 0, pitch: 0, distance: 6 };
const apiPort = location.port === '18088' ? '18090' : '8090';
const API_BASE = window.LUMA_RENDER_API || `${location.protocol}//${location.hostname}:${apiPort}`;

function hasWebGL2() {
  const canvas = document.createElement('canvas');
  return Boolean(canvas.getContext('webgl2'));
}

function updateCapabilityBadge() {
  const supported = hasWebGL2();
  els.webglBadge.classList.add(supported ? 'ok' : 'error');
  els.webglBadge.lastChild.textContent = supported ? ' WebGL 2 就绪' : ' 不支持 WebGL 2';
  if (!supported) showToast('当前浏览器不支持 WebGL 2，无法启动渲染器', true);
}

function getExtension(name) {
  return name.split('.').pop().toLowerCase();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(unit > 1 ? 2 : 0)} ${units[unit]}`;
}

function formatCount(value) {
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}

function backgroundRgb() {
  const hex = els.backgroundSelect.value.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function serverResolution() {
  return els.qualitySelect.value === 'performance'
    ? { width: 800, height: 450 }
    : { width: 1280, height: 720 };
}

function updateModeUi() {
  const server = renderLocation === 'server';
  els.clientMode.classList.toggle('active', !server);
  els.serverMode.classList.toggle('active', server);
  els.serverViewport.classList.toggle('active', server);
  els.viewport.classList.toggle('server-hidden', server);
  els.fileInput.accept = server ? '.ply' : '.ply,.splat,.ksplat,.spz';
  els.welcomeDescription.textContent = server
    ? '模型上传到隔离渲染服务，由 V100 完成光栅化，客户端只接收图像。'
    : '所有模型均在当前设备本地解析与渲染，不上传服务器。';
  els.dropTitle.textContent = server ? '上传标准 3DGS PLY 到服务端' : '拖放 3DGS 模型到这里';
  els.dropSubtitle.textContent = server ? '当前支持 binary little-endian PLY' : '或点击从本地选择文件';
  els.backendLabel.textContent = server ? 'V100 · gsplat' : 'WebGL 2';
  els.renderModeLabel.textContent = server ? 'Server Frame' : '3D Gaussian';
  els.privacyTitle.textContent = server ? '服务端模式' : '本地模式';
  els.privacyText.textContent = server ? '模型会上传到当前隔离容器' : '文件不会离开你的浏览器';
  els.controlHint.innerHTML = server
    ? '<b>拖动</b> 旋转 <i></i><b>滚轮</b> 缩放 <i></i><b>V100</b> 渲染'
    : '<b>左键</b> 旋转 <i></i><b>右键</b> 平移 <i></i><b>滚轮</b> 缩放';
}

async function switchMode(mode) {
  if (mode === renderLocation) return;
  renderLocation = mode;
  updateModeUi();
  if (mode === 'server') {
    await disposeViewer();
    els.viewport.classList.remove('ready');
    await connectServer();
  } else {
    els.serverViewport.classList.remove('ready');
    els.serverFrame.removeAttribute('src');
    if (serverFrameUrl) URL.revokeObjectURL(serverFrameUrl);
    serverFrameUrl = null;
    activeFile = null;
    els.modelPanel.classList.remove('visible');
    els.toolbar.classList.remove('visible');
    els.controlHint.classList.remove('visible');
    els.welcome.classList.remove('hidden');
    updateCapabilityBadge();
  }
}

function applyServerModel(model) {
  serverStatus = model;
  serverCamera.yaw = model.camera?.yaw || 0;
  serverCamera.pitch = model.camera?.pitch || 0;
  serverCamera.distance = model.camera?.distance || Math.max(model.radius * 2.6, 1);
  activeFile = { name: model.name, size: model.bytes, extension: 'ply', server: true };
  els.fileName.textContent = model.name;
  els.fileType.textContent = 'PLY';
  els.fileSize.textContent = `${formatBytes(model.bytes)} · 服务端`;
  els.splatCount.textContent = formatCount(model.gaussians);
  els.welcome.classList.add('hidden');
  els.modelPanel.classList.add('visible');
  els.toolbar.classList.add('visible');
  els.controlHint.classList.add('visible');
  els.serverViewport.classList.add('ready');
}

async function connectServer() {
  els.webglBadge.classList.remove('ok', 'error');
  els.webglBadge.lastChild.textContent = ' 连接 V100';
  try {
    const response = await fetch(`${API_BASE}/api/status`, { signal: AbortSignal.timeout(8000) });
    const status = await response.json();
    if (!response.ok || !status.ok) throw new Error(status.error || '服务不可用');
    els.webglBadge.classList.add('ok');
    els.webglBadge.lastChild.textContent = ` V100 就绪 · ${status.gpu.free_mib} MiB`;
    if (status.model) {
      applyServerModel(status.model);
      await requestServerRender();
    } else {
      els.welcome.classList.remove('hidden');
      showToast('服务端已连接，请上传 PLY 模型');
    }
  } catch (error) {
    els.webglBadge.classList.add('error');
    els.webglBadge.lastChild.textContent = ' 服务端离线';
    showToast(`服务端连接失败：${readableError(error)}`, true);
  }
}

function uploadServerFile(file) {
  if (getExtension(file.name) !== 'ply') return showToast('服务端模式当前仅支持标准 3DGS PLY', true);
  showLoading('正在上传到 V100', '准备传输模型…');
  els.openFileTop.disabled = true;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API_BASE}/api/model`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) setProgress(event.loaded * 90 / event.total);
  };
  xhr.onerror = () => finishServerUpload(new Error('网络连接中断'));
  xhr.onload = () => {
    let payload = {};
    try { payload = JSON.parse(xhr.responseText || '{}'); } catch (_) { /* handled below */ }
    if (xhr.status < 200 || xhr.status >= 300) {
      finishServerUpload(new Error(payload.error || `HTTP ${xhr.status}`));
      return;
    }
    finishServerUpload(null, payload.model);
  };
  xhr.send(file);
}

async function finishServerUpload(error, model) {
  els.openFileTop.disabled = false;
  if (error) {
    hideLoading();
    showToast(`上传或加载失败：${readableError(error)}`, true);
    return;
  }
  setProgress(100);
  applyServerModel(model);
  await requestServerRender();
  hideLoading();
  showToast(`${model.name} 已由 V100 加载`);
}

async function requestServerRender() {
  if (renderLocation !== 'server' || !serverStatus) return;
  if (serverRequestRunning) {
    serverRequestPending = true;
    return;
  }
  serverRequestRunning = true;
  const resolution = serverResolution();
  try {
    const response = await fetch(`${API_BASE}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...serverCamera, ...resolution, background: backgroundRgb(), fov: 55 })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const nextUrl = URL.createObjectURL(blob);
    els.serverFrame.onload = () => {
      if (serverFrameUrl) URL.revokeObjectURL(serverFrameUrl);
      serverFrameUrl = nextUrl;
    };
    els.serverFrame.src = nextUrl;
    const stats = JSON.parse(response.headers.get('X-Render-Stats') || '{}');
    const fps = stats.render_ms ? Math.round(1000 / stats.render_ms) : '—';
    els.fpsValue.textContent = fps;
    els.serverMetrics.textContent = `${stats.width}×${stats.height} · ${stats.render_ms || '—'} ms · ${stats.peak_allocated_mib || '—'} MiB`;
  } catch (error) {
    showToast(`服务端渲染失败：${readableError(error)}`, true);
  } finally {
    serverRequestRunning = false;
    if (serverRequestPending) {
      serverRequestPending = false;
      requestServerRender();
    }
  }
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('visible');
  toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 3600);
}

function showLoading(title = '正在读取模型', detail = '准备数据…') {
  els.loadingTitle.textContent = title;
  els.loadingDetail.textContent = detail;
  setProgress(0);
  els.loading.classList.add('visible');
}

function hideLoading() {
  els.loading.classList.remove('visible');
}

function setProgress(percent) {
  const value = Math.min(100, Math.max(0, Number(percent) || 0));
  els.progressBar.style.width = `${value}%`;
  els.progressText.textContent = `${Math.round(value)}%`;
  els.loadingDetail.textContent = value < 100 ? '正在载入并解析高斯数据…' : '正在构建渲染缓冲区…';
}

function createViewer() {
  return new GaussianSplats3D.Viewer({
    rootElement: els.viewport,
    cameraUp: [0, 1, 0],
    initialCameraPosition: [0, 0, 6],
    initialCameraLookAt: [0, 0, 0],
    selfDrivenMode: true,
    useBuiltInControls: true,
    sharedMemoryForWorkers: false,
    gpuAcceleratedSort: false,
    enableSIMDInSort: true,
    halfPrecisionCovariancesOnGPU: false,
    sphericalHarmonicsDegree: 2,
    sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
    renderMode: GaussianSplats3D.RenderMode.Always,
    antialiased: false
  });
}

async function disposeViewer() {
  if (viewer) {
    try { viewer.stop(); } catch (_) { /* already stopped */ }
    try { await viewer.dispose(); } catch (_) { /* best-effort cleanup */ }
    viewer = null;
    window.__lumaViewer = null;
  }
  els.viewport.replaceChildren();
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

async function loadScene(source, metadata, format, skipDispose = false) {
  if (!hasWebGL2()) return showToast('当前浏览器不支持 WebGL 2', true);
  showLoading(metadata.demo ? '正在打开示例场景' : '正在读取模型');
  els.openFileTop.disabled = true;

  try {
    if (!skipDispose) await disposeViewer();
    viewer = createViewer();
    activeFile = metadata;
    await viewer.addSplatScene(source, {
      format,
      progressiveLoad: false,
      showLoadingUI: false,
      splatAlphaRemovalThreshold: 5,
      onProgress: (percent) => setProgress(percent)
    });
    viewer.start();
    window.__lumaViewer = viewer;
    viewer.renderer.setClearColor(els.backgroundSelect.value, 1);
    els.viewport.classList.add('ready');
    els.welcome.classList.add('hidden');
    els.modelPanel.classList.add('visible');
    els.toolbar.classList.add('visible');
    els.controlHint.classList.add('visible');
    els.fileName.textContent = metadata.name;
    els.fileType.textContent = metadata.extension.toUpperCase();
    els.fileSize.textContent = metadata.demo ? `${formatBytes(metadata.size)} · 内置示例` : formatBytes(metadata.size);
    els.splatCount.textContent = formatCount(viewer.splatMesh.getSplatCount());
    hideLoading();
    showToast(`${metadata.name} 已就绪`);
  } catch (error) {
    console.error(error);
    await disposeViewer();
    hideLoading();
    els.viewport.classList.remove('ready');
    if (!activeFile) els.welcome.classList.remove('hidden');
    showToast(`加载失败：${readableError(error)}`, true);
  } finally {
    els.openFileTop.disabled = false;
  }
}

function readableError(error) {
  const message = error?.message || String(error);
  if (/ply/i.test(message)) return 'PLY 文件不是有效的 3DGS 数据或属性不完整';
  if (/fetch|network/i.test(message)) return '无法读取模型数据';
  if (/memory|buffer|allocation/i.test(message)) return '设备内存不足，请尝试压缩模型';
  return message.length > 90 ? `${message.slice(0, 87)}…` : message;
}

async function handleFile(file) {
  if (!file) return;
  if (renderLocation === 'server') {
    if (file.size === 0) return showToast('文件为空，无法上传', true);
    uploadServerFile(file);
    return;
  }
  const extension = getExtension(file.name);
  if (!formats[extension]) return showToast('仅支持 .ply、.splat、.ksplat 和 .spz 文件', true);
  if (file.size === 0) return showToast('文件为空，无法加载', true);
  await disposeViewer();
  objectUrl = URL.createObjectURL(file);
  await loadScene(objectUrl, { name: file.name, size: file.size, extension }, formats[extension], true);
}

async function loadDemo() {
  if (renderLocation === 'server') {
    if (serverStatus) await requestServerRender();
    else await connectServer();
    return;
  }
  const response = await fetch('./demo.splat', { method: 'HEAD' });
  const size = Number(response.headers.get('content-length')) || 0;
  await loadScene('./demo.splat', { name: 'Luma_Orbit.splat', size, extension: 'splat', demo: true }, formats.splat);
}

function resetView() {
  if (renderLocation === 'server') {
    if (!serverStatus) return;
    serverCamera.yaw = serverStatus.camera?.yaw || 0;
    serverCamera.pitch = serverStatus.camera?.pitch || 0;
    serverCamera.distance = serverStatus.camera?.distance || serverStatus.radius * 2.6;
    requestServerRender();
    showToast('服务端视角已重置');
    return;
  }
  if (!viewer) return;
  viewer.camera.position.set(0, 0, 6);
  viewer.controls.target.set(0, 0, 0);
  viewer.camera.lookAt(viewer.controls.target);
  viewer.controls.update();
  showToast('视角已重置');
}

function saveScreenshot() {
  if (renderLocation === 'server') {
    if (!serverFrameUrl) return;
    const link = document.createElement('a');
    link.download = `${(activeFile?.name || '3dgs').replace(/\.[^.]+$/, '')}-server-view.jpg`;
    link.href = serverFrameUrl;
    link.click();
    showToast('服务端渲染截图已保存');
    return;
  }
  if (!viewer) return;
  viewer.render();
  const link = document.createElement('a');
  link.download = `${(activeFile?.name || '3dgs').replace(/\.[^.]+$/, '')}-view.png`;
  link.href = viewer.renderer.domElement.toDataURL('image/png');
  link.click();
  showToast('截图已保存');
}

function setPanel(open) {
  els.modelPanel.classList.toggle('visible', open);
  els.togglePanel.classList.toggle('active', open);
}

function tickFps(now) {
  frameCount++;
  if (now - fpsStartedAt >= 700) {
    if (renderLocation === 'client') els.fpsValue.textContent = viewer ? Math.round(frameCount * 1000 / (now - fpsStartedAt)) : '—';
    if (viewer?.splatMesh) els.splatCount.textContent = formatCount(viewer.splatMesh.getSplatCount());
    frameCount = 0;
    fpsStartedAt = now;
  }
  requestAnimationFrame(tickFps);
}

els.openFileTop.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') els.fileInput.click(); });
els.fileInput.addEventListener('change', () => { handleFile(els.fileInput.files[0]); els.fileInput.value = ''; });
els.loadDemo.addEventListener('click', () => loadDemo().catch((error) => showToast(readableError(error), true)));
els.clientMode.addEventListener('click', () => switchMode('client'));
els.serverMode.addEventListener('click', () => switchMode('server'));
els.togglePanel.addEventListener('click', () => setPanel(!els.modelPanel.classList.contains('visible')));
els.closePanel.addEventListener('click', () => setPanel(false));
els.resetView.addEventListener('click', resetView);
els.screenshot.addEventListener('click', saveScreenshot);
els.fullscreen.addEventListener('click', () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
els.backgroundSelect.addEventListener('change', () => {
  if (renderLocation === 'server') requestServerRender();
  else if (viewer) viewer.renderer.setClearColor(els.backgroundSelect.value, 1);
});
els.qualitySelect.addEventListener('change', () => {
  if (renderLocation === 'server') {
    requestServerRender();
    showToast(els.qualitySelect.value === 'performance' ? '服务端性能模式' : '服务端高清模式');
    return;
  }
  if (!viewer) return;
  const performanceMode = els.qualitySelect.value === 'performance';
  viewer.renderer.setPixelRatio(performanceMode ? 1 : window.devicePixelRatio);
  viewer.updateForRendererSizeChanges();
  showToast(performanceMode ? '已切换至性能模式' : '已切换至高清模式');
});

window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'r' && viewer) resetView();
  if (event.key.toLowerCase() === 'f' && viewer) els.fullscreen.click();
});
window.addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth++; els.dragOverlay.classList.add('visible'); });
window.addEventListener('dragover', (event) => { event.preventDefault(); });
window.addEventListener('dragleave', (event) => { event.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; els.dragOverlay.classList.remove('visible'); } });
window.addEventListener('drop', (event) => { event.preventDefault(); dragDepth = 0; els.dragOverlay.classList.remove('visible'); handleFile(event.dataTransfer.files[0]); });

els.serverViewport.addEventListener('pointerdown', (event) => {
  if (renderLocation !== 'server' || !serverStatus) return;
  serverDrag = { x: event.clientX, y: event.clientY };
  els.serverViewport.setPointerCapture(event.pointerId);
});
els.serverViewport.addEventListener('pointermove', (event) => {
  if (!serverDrag || renderLocation !== 'server') return;
  const dx = event.clientX - serverDrag.x;
  const dy = event.clientY - serverDrag.y;
  serverDrag = { x: event.clientX, y: event.clientY };
  serverCamera.yaw -= dx * 0.008;
  serverCamera.pitch = Math.max(-1.48, Math.min(1.48, serverCamera.pitch + dy * 0.008));
  requestServerRender();
});
els.serverViewport.addEventListener('pointerup', () => { serverDrag = null; });
els.serverViewport.addEventListener('pointercancel', () => { serverDrag = null; });
els.serverViewport.addEventListener('wheel', (event) => {
  if (renderLocation !== 'server' || !serverStatus) return;
  event.preventDefault();
  const min = serverStatus.radius * 0.08;
  const max = serverStatus.radius * 20;
  serverCamera.distance = Math.max(min, Math.min(max, serverCamera.distance * Math.exp(event.deltaY * 0.001)));
  requestServerRender();
}, { passive: false });

updateCapabilityBadge();
updateModeUi();
requestAnimationFrame(tickFps);
