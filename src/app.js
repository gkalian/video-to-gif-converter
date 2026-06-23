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
};

const $ = (id) => document.getElementById(id);

let lastClickedIndex = -1;
let extractProgressUnlisten = null;
let gifProgressUnlisten = null;

async function init() {
  setupStep1();
  setupStep2();
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

  $('fpsSlider').addEventListener('input', () => {
    $('fpsValue').textContent = $('fpsSlider').value;
  });

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
  const fps = parseInt($('fpsSlider').value);
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

    state.framePaths = frames;
    state.selectedFrames.clear();
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
  $('btnNewConversion').addEventListener('click', resetApp);
  $('btnOpenGif').addEventListener('click', openGif);

  $('gifFps').addEventListener('input', () => {
    $('gifFpsValue').textContent = $('gifFps').value;
  });

  const frameSelector = $('frameSelector');

  frameSelector.addEventListener('mousedown', (e) => {
    const target = e.target;
    if (!target || target.tagName !== 'OPTION') return;
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

async function showFramePreview(index) {
  if (index >= 0 && index < state.framePaths.length) {
    try {
      const dataUrl = await invoke('read_frame_base64', { path: state.framePaths[index] });
      $('framePreviewImg').src = dataUrl;
    } catch (err) {
      console.error('[preview] failed to load frame:', err);
    }
  }
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

  const fps = parseInt($('gifFps').value);
  const quality = $('gifQuality').value;
  const looping = $('gifLoop').checked;
  const fastMode = $('gifFastMode').checked;

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
      options: { frames: state.framePaths, fps, quality, looping, fast_mode: fastMode, output_path: outputPath }
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
