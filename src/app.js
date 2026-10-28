const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open: openDialog, save: saveDialog } = window.__TAURI__.dialog;

const state = {
  currentStep: 1,
  videoPath: null,
  videoInfo: null,
  framePaths: [],
  selectedFrames: new Set(),
  lastGifPath: null,
  // Crop rect in frame pixels; frameSize is the size of extracted frames
  frameSize: null,
  crop: { enabled: false, x: 0, y: 0, w: 0, h: 0 },
};

const CROP_MIN = 8;

const $ = (id) => document.getElementById(id);

let lastClickedIndex = -1;
let extractProgressUnlisten = null;
let gifProgressUnlisten = null;

async function init() {
  setupStep1();
  setupStep2();
  setupCrop();
  setupDragDrop();

  try {
    const version = await window.__TAURI__.app.getVersion();
    $('appVersion').textContent = `v${version}`;
  } catch (_) {}

  const repoUrl = 'https://github.com/gkalian/video-to-gif-converter';
  $('repoLink').href = repoUrl;
  $('repoLink').addEventListener('click', (e) => {
    e.preventDefault();
    invoke('open_path', { path: repoUrl });
  });

  const hasFfmpeg = await invoke('get_ffmpeg_status');
  if (!hasFfmpeg) {
    document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
    $('setupSection').classList.add('active');
  } else {
    document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
    $('step1').classList.add('active');
  }
}

function goToStep(step) {
  stopPlayback();
  state.currentStep = step;
  document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
  $(step === 1 ? 'step1' : 'step2').classList.add('active');
  document.querySelectorAll('.step-dot').forEach(el => {
    const dotStep = parseInt(el.getAttribute('data-step') || '0');
    el.classList.toggle('active', dotStep === step);
    el.classList.toggle('completed', dotStep < step);
  });
}

// --- Step 1 ---

function setupStep1() {
  $('btnOpenVideo').addEventListener('click', openVideo);
  $('btnChangeVideo').addEventListener('click', openVideo);
  $('btnExtract').addEventListener('click', extractFrames);
  $('btnCancelExtract').addEventListener('click', cancelExtraction);


  $('outputWidth').addEventListener('change', () => {
    if ($('keepAspect').checked && state.videoInfo) {
      const ratio = state.videoInfo.height / state.videoInfo.width;
      $('outputHeight').value = Math.round(parseInt($('outputWidth').value) * ratio);
    }
  });

  $('outputHeight').addEventListener('change', () => {
    if ($('keepAspect').checked && state.videoInfo) {
      const ratio = state.videoInfo.width / state.videoInfo.height;
      $('outputWidth').value = Math.round(parseInt($('outputHeight').value) * ratio);
    }
  });
}

async function openVideo() {
  const filePath = await openDialog({
    title: 'Open Video File',
    filters: [{
      name: 'Video Files',
      extensions: ['mp4', 'avi', 'wmv', 'mov', 'mkv', 'flv', 'webm', 'mpeg', 'mpg', '3gp', 'vob', 'rmvb', 'ts', 'm4v']
    }, {
      name: 'All Files',
      extensions: ['*']
    }],
  });

  if (!filePath) return;

  $('dropZone').classList.add('hidden');
  $('videoInfo').classList.add('hidden');
  $('loadingIndicator').classList.remove('hidden');

  try {
    const info = await invoke('get_video_info', { filePath });
    $('loadingIndicator').classList.add('hidden');
    state.videoPath = filePath;
    state.videoInfo = info;
    displayVideoInfo(filePath, info);
  } catch (err) {
    $('loadingIndicator').classList.add('hidden');
    $('dropZone').classList.remove('hidden');
    alert(`Failed to read video: ${err}`);
  }
}

function displayVideoInfo(filePath, info) {
  $('dropZone').classList.add('hidden');
  $('videoInfo').classList.remove('hidden');
  $('extractProgress').classList.add('hidden');

  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  $('videoName').textContent = fileName;
  $('videoDuration').textContent = `Duration: ${formatTime(info.duration)}`;
  $('videoResolution').textContent = `${info.width}×${info.height}`;
  $('videoCodec').textContent = info.codec.toUpperCase();

  $('endTime').max = String(info.duration);
  $('endTime').value = String(Math.min(30, info.duration));
  $('startTime').max = String(info.duration - 0.1);

  const maxWidth = 480;
  const scale = Math.min(1, maxWidth / info.width);
  $('outputWidth').value = Math.round(info.width * scale);
  $('outputHeight').value = Math.round(info.height * scale);
}

async function extractFrames() {
  if (!state.videoPath || !state.videoInfo) return;

  const startTime = parseFloat($('startTime').value);
  const endTime = parseFloat($('endTime').value);
  const fps = parseInt($('fpsSelect').value);
  const width = parseInt($('outputWidth').value);
  const height = parseInt($('outputHeight').value);

  if (endTime <= startTime) {
    alert('End time must be greater than start time');
    return;
  }

  $('videoInfo').classList.add('hidden');
  $('extractProgress').classList.remove('hidden');

  extractProgressUnlisten = await listen('extract-progress', (event) => {
    $('extractProgressBar').style.width = `${event.payload}%`;
    $('extractProgressText').textContent = `Extracting frames... ${event.payload}%`;
  });

  try {
    const frames = await invoke('extract_frames', {
      options: { input_path: state.videoPath, start_time: startTime, end_time: endTime, fps, width, height }
    });

    frameCache.clear();
    state.framePaths = frames;
    state.selectedFrames.clear();
    resetCropState();
    if (extractProgressUnlisten) { extractProgressUnlisten(); extractProgressUnlisten = null; }
    loadFrameList();
    goToStep(2);
  } catch (err) {
    if (extractProgressUnlisten) { extractProgressUnlisten(); extractProgressUnlisten = null; }
    $('extractProgress').classList.add('hidden');
    $('videoInfo').classList.remove('hidden');
    if (err !== 'Cancelled') alert(`Extraction failed: ${err}`);
  }
}

async function cancelExtraction() {
  await invoke('cancel_extraction');
  if (extractProgressUnlisten) { extractProgressUnlisten(); extractProgressUnlisten = null; }
  $('extractProgress').classList.add('hidden');
  $('videoInfo').classList.remove('hidden');
}

// --- Step 2 ---

function setupStep2() {
  $('btnSelectAll').addEventListener('click', selectAllFrames);
  $('btnRemoveSelected').addEventListener('click', removeSelectedFrames);
  $('btnBackToStep1').addEventListener('click', () => { goToStep(1); resetStep1UI(); });
  $('btnMakeGif').onclick = makeGif;
  $('btnPlay').addEventListener('click', togglePlayback);
  $('btnNewConversion').addEventListener('click', resetApp);
  $('btnOpenGif').addEventListener('click', openGif);

  $('gifPlayspeed').addEventListener('change', () => {
    const isCustom = $('gifPlayspeed').value === 'custom';
    $('customFpsSetting').classList.toggle('hidden', !isCustom);
  });

  const frameSelector = $('frameSelector');

  frameSelector.addEventListener('mousedown', (e) => {
    const target = e.target;
    if (!target || target.tagName !== 'OPTION') return;
    stopPlayback();
    const idx = parseInt(target.value);
    if (isNaN(idx)) return;

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleFrameSelection(idx);
      lastClickedIndex = idx;
    } else if (e.shiftKey && lastClickedIndex >= 0) {
      e.preventDefault();
      const start = Math.min(lastClickedIndex, idx);
      const end = Math.max(lastClickedIndex, idx);
      for (let i = start; i <= end; i++) state.selectedFrames.add(i);
      updateFrameListStyles();
      updateRemoveButton();
    } else {
      lastClickedIndex = idx;
    }
  });

  frameSelector.addEventListener('change', () => {
    const idx = frameSelector.selectedIndex;
    if (idx >= 0) showFramePreview(idx);
  });

  frameSelector.addEventListener('keydown', (e) => {
    stopPlayback();
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelectedFrames(); }
    if (e.key === ' ') { e.preventDefault(); const idx = frameSelector.selectedIndex; if (idx >= 0) { toggleFrameSelection(idx); lastClickedIndex = idx; } }
  });
}

function loadFrameList() {
  const selector = $('frameSelector');
  selector.innerHTML = '';
  state.framePaths.forEach((_, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `Frame ${index + 1}`;
    if (state.selectedFrames.has(index)) option.classList.add('frame-selected');
    selector.appendChild(option);
  });
  if (state.framePaths.length > 0) { selector.selectedIndex = 0; showFramePreview(0); }
  updateFrameCount();
  updateRemoveButton();
}

// Frame data URLs by path, so playback does not re-read files every loop
const frameCache = new Map();
let previewToken = 0;

async function loadFrame(path) {
  let url = frameCache.get(path);
  if (!url) {
    url = await invoke('read_frame_base64', { path });
    frameCache.set(path, url);
  }
  return url;
}

async function showFramePreview(index) {
  if (index < 0 || index >= state.framePaths.length) return;
  const token = ++previewToken;
  try {
    const dataUrl = await loadFrame(state.framePaths[index]);
    // A newer request may have finished first; don't overwrite it
    if (token === previewToken) $('framePreviewImg').src = dataUrl;
  } catch (err) {
    console.error('[preview] failed to load frame:', err);
  }
}

// --- Playback ---

let playTimer = null;

function getGifFps() {
  return parseInt($('gifPlayspeed').value === 'source' ? $('fpsSelect').value : $('gifFpsCustom').value);
}

function togglePlayback() {
  if (playTimer !== null) stopPlayback();
  else startPlayback();
}

function startPlayback() {
  if (state.framePaths.length < 2) return;
  const selector = $('frameSelector');
  let idx = selector.selectedIndex;
  // Start from the beginning if we are on the last frame
  if (idx < 0 || idx >= state.framePaths.length - 1) idx = -1;
  $('btnPlay').innerHTML = '&#10074;&#10074; Pause';

  const tick = async () => {
    const started = performance.now();
    idx = (idx + 1) % state.framePaths.length;
    selector.selectedIndex = idx;
    await showFramePreview(idx);
    if (playTimer === null) return;
    const interval = 1000 / (getGifFps() || 10);
    playTimer = setTimeout(tick, Math.max(0, interval - (performance.now() - started)));
  };
  playTimer = setTimeout(tick, 0);
}

function stopPlayback() {
  if (playTimer === null) return;
  clearTimeout(playTimer);
  playTimer = null;
  $('btnPlay').innerHTML = '&#9654; Play';
}

function toggleFrameSelection(index) {
  if (state.selectedFrames.has(index)) state.selectedFrames.delete(index);
  else state.selectedFrames.add(index);
  updateFrameListStyles();
  updateRemoveButton();
}

function updateFrameListStyles() {
  const options = $('frameSelector').options;
  for (let i = 0; i < options.length; i++) {
    if (state.selectedFrames.has(i)) {
      options[i].classList.add('frame-selected');
      options[i].textContent = `Frame ${i + 1} [x]`;
    } else {
      options[i].classList.remove('frame-selected');
      options[i].textContent = `Frame ${i + 1}`;
    }
  }
}

function selectAllFrames() {
  if (state.selectedFrames.size === state.framePaths.length) state.selectedFrames.clear();
  else state.framePaths.forEach((_, i) => state.selectedFrames.add(i));
  updateFrameListStyles();
  updateRemoveButton();
}

function removeSelectedFrames() {
  if (state.selectedFrames.size === 0) return;
  if (state.selectedFrames.size === state.framePaths.length) { alert('Cannot remove all frames'); return; }
  const currentIdx = $('frameSelector').selectedIndex;
  state.framePaths = state.framePaths.filter((_, i) => !state.selectedFrames.has(i));
  state.selectedFrames.clear();
  loadFrameList();
  const newIdx = Math.min(currentIdx, state.framePaths.length - 1);
  if (newIdx >= 0) { $('frameSelector').selectedIndex = newIdx; showFramePreview(newIdx); }
}

function updateRemoveButton() {
  const btn = $('btnRemoveSelected');
  btn.disabled = state.selectedFrames.size === 0;
  btn.textContent = state.selectedFrames.size > 0 ? `Remove Selected (${state.selectedFrames.size})` : 'Remove Selected';
}

function updateFrameCount() {
  $('frameCount').textContent = `${state.framePaths.length} frames`;
}

async function makeGif() {
  if (state.framePaths.length === 0) { alert('No frames to convert'); return; }

  const defaultName = state.videoPath
    ? state.videoPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') + '.gif'
    : 'output.gif';

  const outputPath = await saveDialog({
    title: 'Save GIF',
    defaultPath: defaultName,
    filters: [{ name: 'GIF Animation', extensions: ['gif'] }],
  });
  if (!outputPath) return;

  stopPlayback();
  const fps = getGifFps();
  const quality = $('gifQuality').value;
  const looping = true;
  const fastMode = $('gifFastMode').checked;
  const crop = getCropOption();

  $('gifProgress').classList.remove('hidden');
  $('gifSuccess').classList.add('hidden');
  $('gifError').classList.add('hidden');
  $('btnOpenGif').classList.add('hidden');
  $('btnNewConversion').classList.add('hidden');
  
  const makeBtn = $('btnMakeGif');
  makeBtn.textContent = 'Stop';
  makeBtn.disabled = false;
  
  const cancelHandler = async () => {
    await invoke('cancel_gif_creation');
    makeBtn.disabled = true;
  };
  makeBtn.onclick = cancelHandler;

  gifProgressUnlisten = await listen('gif-progress', (event) => {
    $('gifProgressBar').style.width = `${event.payload}%`;
    $('gifProgressText').textContent = `${event.payload}%`;
  });

  try {
    await invoke('make_gif', {
      options: { frames: state.framePaths, fps, quality, looping, fast_mode: fastMode, crop, output_path: outputPath }
    });
    state.lastGifPath = outputPath;
    if (gifProgressUnlisten) { gifProgressUnlisten(); gifProgressUnlisten = null; }
    $('gifProgress').classList.add('hidden');
    $('gifSuccess').classList.remove('hidden');
    $('btnOpenGif').classList.remove('hidden');
    $('btnNewConversion').classList.remove('hidden');
    
    const makeBtn = $('btnMakeGif');
    makeBtn.textContent = 'Make GIF';
    makeBtn.disabled = false;
    makeBtn.onclick = makeGif;
  } catch (err) {
    if (gifProgressUnlisten) { gifProgressUnlisten(); gifProgressUnlisten = null; }
    $('gifProgress').classList.add('hidden');
    
    // Don't show error if user cancelled
    if (!err.toString().includes('cancelled')) {
      $('gifError').textContent = `Error: ${err}`;
      $('gifError').classList.remove('hidden');
    }
    
    const makeBtn = $('btnMakeGif');
    makeBtn.textContent = 'Make GIF';
    makeBtn.disabled = false;
    makeBtn.onclick = makeGif;
  }
}

async function openGif() {
  if (state.lastGifPath) await invoke('open_path', { path: state.lastGifPath });
}

function resetStep1UI() {
  $('dropZone').classList.add('hidden');
  $('videoInfo').classList.remove('hidden');
  $('extractProgress').classList.add('hidden');
  $('extractProgressBar').style.width = '0%';
  $('extractProgressText').textContent = 'Extracting frames...';
  // Reset GIF status from step 2
  $('gifProgress').classList.add('hidden');
  $('gifSuccess').classList.add('hidden');
  $('gifError').classList.add('hidden');
  $('btnOpenGif').classList.add('hidden');
  $('btnNewConversion').classList.add('hidden');
  $('gifProgressBar').style.width = '0%';
  $('btnMakeGif').textContent = 'Make GIF';
  $('btnMakeGif').disabled = false;
  $('btnMakeGif').onclick = makeGif;
}

function resetApp() {
  state.videoPath = null;
  state.videoInfo = null;
  state.framePaths = [];
  state.selectedFrames.clear();
  state.lastGifPath = null;
  resetCropState();
  invoke('cleanup_temp');
  $('dropZone').classList.remove('hidden');
  $('videoInfo').classList.add('hidden');
  $('extractProgress').classList.add('hidden');
  $('extractProgressBar').style.width = '0%';
  $('extractProgressText').textContent = 'Extracting frames...';
  $('gifProgress').classList.add('hidden');
  $('gifSuccess').classList.add('hidden');
  $('gifError').classList.add('hidden');
  $('btnOpenGif').classList.add('hidden');
  $('btnNewConversion').classList.add('hidden');
  $('btnMakeGif').disabled = false;
  $('gifProgressBar').style.width = '0%';
  $('frameSelector').innerHTML = '';
  goToStep(1);
}

// --- Crop ---

let cropDrag = null;

function setupCrop() {
  const img = $('framePreviewImg');
  const overlay = $('cropOverlay');

  img.addEventListener('load', () => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!state.frameSize || state.frameSize.w !== w || state.frameSize.h !== h) {
      state.frameSize = { w, h };
      setCropRect(0, 0, w, h);
    }
    layoutCropOverlay();
  });
  new ResizeObserver(layoutCropOverlay).observe($('framePreview'));

  $('cropEnabled').addEventListener('change', () => {
    state.crop.enabled = $('cropEnabled').checked;
    updateCropUI();
  });

  for (const id of ['cropX', 'cropY', 'cropW', 'cropH']) {
    $(id).addEventListener('change', () => {
      setCropRect(
        parseInt($('cropX').value) || 0,
        parseInt($('cropY').value) || 0,
        parseInt($('cropW').value) || 0,
        parseInt($('cropH').value) || 0,
      );
    });
  }

  $('btnCropReset').addEventListener('click', () => {
    if (state.frameSize) setCropRect(0, 0, state.frameSize.w, state.frameSize.h);
  });
  $('btnCropAuto').addEventListener('click', autoDetectBlackBars);

  overlay.addEventListener('pointerdown', (e) => {
    if (!state.frameSize || e.button !== 0) return;
    e.preventDefault();
    const p = pointerToFrame(e);
    const handle = e.target.dataset.handle || 'new';
    const { x, y, w, h } = state.crop;
    cropDrag = { handle, startX: p.x, startY: p.y, rect: { x, y, w, h } };
    overlay.setPointerCapture(e.pointerId);
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!cropDrag) return;
    const p = pointerToFrame(e);
    const { w: W, h: H } = state.frameSize;
    const { handle, startX, startY, rect: r } = cropDrag;
    const dx = p.x - startX;
    const dy = p.y - startY;

    if (handle === 'move') {
      setCropRect(clamp(r.x + dx, 0, W - r.w), clamp(r.y + dy, 0, H - r.h), r.w, r.h);
    } else if (handle === 'new') {
      const x1 = clamp(Math.min(startX, p.x), 0, W);
      const y1 = clamp(Math.min(startY, p.y), 0, H);
      const x2 = clamp(Math.max(startX, p.x), 0, W);
      const y2 = clamp(Math.max(startY, p.y), 0, H);
      setCropRect(x1, y1, x2 - x1, y2 - y1);
    } else {
      let left = r.x, top = r.y, right = r.x + r.w, bottom = r.y + r.h;
      if (handle.includes('w')) left = clamp(left + dx, 0, right - CROP_MIN);
      if (handle.includes('e')) right = clamp(right + dx, left + CROP_MIN, W);
      if (handle.includes('n')) top = clamp(top + dy, 0, bottom - CROP_MIN);
      if (handle.includes('s')) bottom = clamp(bottom + dy, top + CROP_MIN, H);
      setCropRect(left, top, right - left, bottom - top);
    }
  });

  const endDrag = () => { cropDrag = null; };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  updateCropUI();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function pointerToFrame(e) {
  const rect = $('framePreviewImg').getBoundingClientRect();
  return {
    x: Math.round((e.clientX - rect.left) * state.frameSize.w / rect.width),
    y: Math.round((e.clientY - rect.top) * state.frameSize.h / rect.height),
  };
}

function setCropRect(x, y, w, h) {
  if (!state.frameSize) return;
  const { w: W, h: H } = state.frameSize;
  x = clamp(Math.round(x), 0, W - 1);
  y = clamp(Math.round(y), 0, H - 1);
  w = clamp(Math.round(w), 1, W - x);
  h = clamp(Math.round(h), 1, H - y);
  Object.assign(state.crop, { x, y, w, h });
  updateCropUI();
}

function isCropFull() {
  const { x, y, w, h } = state.crop;
  return !state.frameSize || (x === 0 && y === 0 && w === state.frameSize.w && h === state.frameSize.h);
}

function getCropOption() {
  if (!state.crop.enabled || isCropFull()) return null;
  const { x, y, w, h } = state.crop;
  return { x, y, width: w, height: h };
}

function resetCropState() {
  state.frameSize = null;
  state.crop = { enabled: false, x: 0, y: 0, w: 0, h: 0 };
  $('cropEnabled').checked = false;
  updateCropUI();
}

function updateCropUI() {
  const { enabled, x, y, w, h } = state.crop;
  const hasFrame = !!state.frameSize;

  for (const [id, v] of [['cropX', x], ['cropY', y], ['cropW', w], ['cropH', h]]) {
    $(id).disabled = !enabled || !hasFrame;
    if (hasFrame) $(id).value = String(v);
  }
  if (hasFrame) {
    $('cropX').max = String(state.frameSize.w - 1);
    $('cropY').max = String(state.frameSize.h - 1);
    $('cropW').max = String(state.frameSize.w);
    $('cropH').max = String(state.frameSize.h);
  }
  $('btnCropReset').disabled = !enabled || isCropFull();
  $('cropOverlay').classList.toggle('hidden', !enabled || !hasFrame);

  if (!hasFrame) $('cropInfo').textContent = '';
  else if (enabled && !isCropFull()) $('cropInfo').textContent = `${state.frameSize.w}×${state.frameSize.h} → ${w}×${h}`;
  else $('cropInfo').textContent = `${state.frameSize.w}×${state.frameSize.h}`;

  layoutCropOverlay();
}

function layoutCropOverlay() {
  const img = $('framePreviewImg');
  if (!state.frameSize || !img.naturalWidth) return;
  const container = $('framePreview').getBoundingClientRect();
  const r = img.getBoundingClientRect();
  const overlay = $('cropOverlay');
  overlay.style.left = `${r.left - container.left - $('framePreview').clientLeft}px`;
  overlay.style.top = `${r.top - container.top - $('framePreview').clientTop}px`;
  overlay.style.width = `${r.width}px`;
  overlay.style.height = `${r.height}px`;

  const sx = r.width / state.frameSize.w;
  const sy = r.height / state.frameSize.h;
  const { x, y, w, h } = state.crop;
  for (const el of [$('cropBox'), $('cropHole')]) {
    el.style.left = `${x * sx}px`;
    el.style.top = `${y * sy}px`;
    el.style.width = `${w * sx}px`;
    el.style.height = `${h * sy}px`;
  }
}

// Scans several frames spread across the clip and keeps the thinnest bar on each
// side, so a single dark scene doesn't eat into the picture.
async function autoDetectBlackBars() {
  if (state.framePaths.length === 0) return;
  const btn = $('btnCropAuto');
  btn.disabled = true;
  btn.textContent = 'Detecting...';

  try {
    const samples = Math.min(8, state.framePaths.length);
    const indices = [...new Set(Array.from({ length: samples }, (_, i) =>
      Math.floor((i + 0.5) * state.framePaths.length / samples)))];

    let result = null;
    for (const idx of indices) {
      const dataUrl = await invoke('read_frame_base64', { path: state.framePaths[idx] });
      const bars = detectBars(await loadImage(dataUrl));
      if (!bars) continue; // frame is entirely dark
      result = result
        ? { top: Math.min(result.top, bars.top), bottom: Math.min(result.bottom, bars.bottom),
            left: Math.min(result.left, bars.left), right: Math.min(result.right, bars.right),
            w: bars.w, h: bars.h }
        : bars;
    }

    if (!result) {
      $('cropInfo').textContent = 'No black bars found';
      return;
    }

    if (!state.frameSize) state.frameSize = { w: result.w, h: result.h };
    state.crop.enabled = true;
    $('cropEnabled').checked = true;
    setCropRect(result.left, result.top,
      result.w - result.left - result.right, result.h - result.top - result.bottom);
    if (isCropFull()) $('cropInfo').textContent = 'No black bars found';
  } catch (err) {
    console.error('[crop] auto-detect failed:', err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Auto-detect black bars';
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function detectBars(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;

  // A line counts as "bar" if fewer than 2% of its pixels are brighter than the threshold
  const LUMA = 40;
  const isBright = (i) => (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) > LUMA;
  const rowDark = (y) => {
    let n = 0;
    for (let x = 0; x < w; x++) if (isBright((y * w + x) * 4)) n++;
    return n < w * 0.02;
  };
  const colDark = (x) => {
    let n = 0;
    for (let y = 0; y < h; y++) if (isBright((y * w + x) * 4)) n++;
    return n < h * 0.02;
  };

  let top = 0;
  while (top < h && rowDark(top)) top++;
  if (top === h) return null;
  let bottom = 0;
  while (bottom < h - top && rowDark(h - 1 - bottom)) bottom++;
  let left = 0;
  while (left < w && colDark(left)) left++;
  let right = 0;
  while (right < w - left && colDark(w - 1 - right)) right++;

  return { top, bottom, left, right, w, h };
}

// --- Drag & Drop ---

function setupDragDrop() {
  const dropZone = $('dropZone');
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('drag-over'); });
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); });

  // Tauri v2: listen for native drag-drop events which provide file paths
  listen('tauri://drag-drop', async (event) => {
    const paths = event.payload?.paths;
    if (!paths || paths.length === 0) return;
    const filePath = paths[0];
    try {
      const info = await invoke('get_video_info', { filePath });
      state.videoPath = filePath;
      state.videoInfo = info;
      displayVideoInfo(filePath, info);
    } catch (err) {
      alert(`Failed to read video: ${err}`);
    }
  });

  listen('tauri://drag-over', () => { dropZone.classList.add('drag-over'); });
  listen('tauri://drag-leave', () => { dropZone.classList.remove('drag-over'); });
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

document.addEventListener('DOMContentLoaded', init);
