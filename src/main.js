'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  screen,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Keep these values in sync with the layout custom properties in style.css.
const STAGE_PADDING = 20;
const PLAYER = { width: 360, height: 128 };
const VOLUME = { width: 40, height: 128 };
const PANEL_GAP = 10;
const WINDOW_WIDTH = PLAYER.width + VOLUME.width + PANEL_GAP + STAGE_PADDING * 2;
const WINDOW_HEIGHT = Math.max(PLAYER.height, VOLUME.height) + STAGE_PADDING * 2;
const INITIAL_VISIBLE_MS = 4500;
const LEAVE_VISIBLE_MS = 2000;
const MOCK = process.argv.includes('--mock');
const MOCK_STATIC = process.argv.includes('--mock-static');

let win = null;
let tray = null;
let bridge = null;
let bridgeBuffer = '';
let bridgeRestartTimer = null;
let quitting = false;
let rendererReady = false;

let latestState = null;
let lastTrackKey = null;
let lastStatus = null;
let sawFirstState = false;
let lastArt = null;
let lastArtId = null;

let windowSide = 'right';
let windowVertical = 'bottom';
let liquidGlass = true;
let trayMenu = null;
let dragging = false;
let snapping = false;
let snapTimer = null;
let snapStartTimer = null;
let snapToken = 0;

let windowState = 'hidden'; // hidden | visible | hiding
let hovered = false;
let interacting = false;
let hideTimer = null;
let hideCompleteTimer = null;
let mockTimer = null;
let mockPosition = 34;
let mockVolume = 0.64;
let mockMuted = false;
let mockPlaying = true;
let mockTrackIndex = 0;
const MOCK_TRACKS = [
  { title: '20kg', artist: 'zombiqe' },
  { title: 'Ночной эфир', artist: 'Aeri' },
  { title: 'Liquid Dreams', artist: 'Overlay' },
];

const logFile = path.join(app.getPath('userData'), 'aeri.log');
const cornerFile = path.join(app.getPath('userData'), 'window-corner.json');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const legacyUserData = path.join(app.getPath('appData'), 'glass-player');

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  try {
    console.log(line);
  } catch {
    /* stdout may be a closed pipe when launched from a console */
  }
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    /* ignore logging failures */
  }
}

for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') {
    stream.on('error', () => {});
  }
}

function trimLog() {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > 2 * 1024 * 1024) fs.truncateSync(logFile, 0);
  } catch {
    /* ignore */
  }
}

function migrateLegacySettings() {
  for (const name of ['window-corner.json', 'settings.json']) {
    const target = path.join(app.getPath('userData'), name);
    const source = path.join(legacyUserData, name);
    try {
      if (fs.existsSync(target) || !fs.existsSync(source)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      log('migrated legacy setting:', name);
    } catch (error) {
      log('legacy settings migration failed:', name, error.message);
    }
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed() && rendererReady) {
    win.webContents.send(channel, payload);
  }
}

function clearHideTimers() {
  clearTimeout(hideTimer);
  hideTimer = null;
}

function armHide(delay = INITIAL_VISIBLE_MS) {
  clearHideTimers();
  if (windowState !== 'visible' || hovered || interacting || dragging || snapping) return;
  hideTimer = setTimeout(() => {
    if (!hovered && !interacting && !dragging && !snapping) hideWidget();
  }, delay);
}

function panelRects(bounds) {
  const y = bounds.y + STAGE_PADDING;
  if (windowSide === 'left') {
    return {
      player: {
        x: bounds.x + STAGE_PADDING,
        y,
        width: PLAYER.width,
        height: PLAYER.height,
      },
      volume: {
        x: bounds.x + STAGE_PADDING + PLAYER.width + PANEL_GAP,
        y,
        width: VOLUME.width,
        height: VOLUME.height,
      },
    };
  }
  return {
    player: {
      x: bounds.x + STAGE_PADDING + VOLUME.width + PANEL_GAP,
      y,
      width: PLAYER.width,
      height: PLAYER.height,
    },
    volume: {
      x: bounds.x + STAGE_PADDING,
      y,
      width: VOLUME.width,
      height: VOLUME.height,
    },
  };
}

function cursorInsidePanel() {
  if (!win || win.isDestroyed()) return false;
  const point = screen.getCursorScreenPoint();
  const rects = panelRects(win.getBounds());
  return [rects.player, rects.volume].some(
    (rect) =>
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
  );
}

function focusWidget() {
  if (!win || win.isDestroyed() || windowState !== 'visible') return;
  if (!win.isFocused()) win.focus();
}

function syncCursorHover() {
  if (!win || win.isDestroyed() || windowState !== 'visible') return;
  const inside = cursorInsidePanel();
  if (inside && !hovered) {
    hovered = true;
    clearHideTimers();
    if (process.env.GLASS_DEBUG) log('hover: true');
  } else if (!inside && hovered) {
    hovered = false;
    if (process.env.GLASS_DEBUG) log('hover: false');
    if (!interacting) armHide(LEAVE_VISIBLE_MS);
  }
}


function sendLayout() {
  send('widget:layout', {
    side: windowSide,
    vertical: windowVertical,
    glass: liquidGlass,
  });
}

function loadCorner() {
  try {
    const data = JSON.parse(fs.readFileSync(cornerFile, 'utf8'));
    if (data && (data.side === 'left' || data.side === 'right')) windowSide = data.side;
    if (data && (data.vertical === 'top' || data.vertical === 'bottom')) {
      windowVertical = data.vertical;
    }
  } catch {
    /* first launch */
  }
}

function saveCorner() {
  try {
    fs.writeFileSync(
      cornerFile,
      JSON.stringify({ side: windowSide, vertical: windowVertical })
    );
  } catch (error) {
    log('corner save failed:', error.message);
  }
}

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (data && typeof data.liquidGlass === 'boolean') liquidGlass = data.liquidGlass;
  } catch {
    /* first launch or unreadable settings */
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({ liquidGlass }));
  } catch (error) {
    log('settings save failed:', error.message);
  }
}

function setLiquidGlass(enabled) {
  const next = Boolean(enabled);
  if (next === liquidGlass) {
    if (trayMenu) {
      const item = trayMenu.getMenuItemById('liquid-glass');
      if (item) item.checked = liquidGlass;
    }
    return;
  }

  liquidGlass = next;
  saveSettings();
  if (trayMenu) {
    const item = trayMenu.getMenuItemById('liquid-glass');
    if (item) item.checked = liquidGlass;
  }
  sendLayout();
  showWidget('manual');
}

function moveWindowTo(x, y) {
  if (!win || win.isDestroyed()) return;
  win.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
  });
}

function positionWindow(display) {
  const area = display.workArea;
  const x = windowSide === 'left' ? area.x : area.x + area.width - WINDOW_WIDTH;
  const y =
    windowVertical === 'top' ? area.y : area.y + area.height - WINDOW_HEIGHT;
  if (process.env.GLASS_DEBUG) {
    log(
      'position window:',
      JSON.stringify({
        display: display.id,
        area,
        side: windowSide,
        vertical: windowVertical,
        x,
        y,
        scale: display.scaleFactor,
      })
    );
  }
  moveWindowTo(x, y);
}

async function showWidget(reason = 'manual') {
  if (!win || win.isDestroyed()) return;

  if (windowState === 'hiding') {
    clearTimeout(hideCompleteTimer);
    hideCompleteTimer = null;
    windowState = 'visible';
    sendLayout();
    send('widget:visibility', true);
    if (latestState) send('widget:state', latestState);
    win.showInactive();
    syncCursorHover();
    armHide(reason === 'manual' ? 6000 : INITIAL_VISIBLE_MS);
    return;
  }

  if (windowState === 'visible') {
    if (latestState) send('widget:state', latestState);
    syncCursorHover();
    armHide(reason === 'manual' ? 6000 : INITIAL_VISIBLE_MS);
    return;
  }

  hovered = false;
  clearHideTimers();
  log('show widget:', reason);

  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  if (process.env.GLASS_DEBUG) log('show display:', JSON.stringify({ cursor: cursorPoint, display: display.id }));
  sendLayout();
  positionWindow(display);

  if (latestState) send('widget:state', latestState);

  win.showInactive();
  win.setAlwaysOnTop(true, 'floating');
  windowState = 'visible';
  send('widget:visibility', true);
  syncCursorHover();
  if (process.env.GLASS_DEBUG) log(`widget visible (hover=${hovered})`);
  armHide(reason === 'manual' ? 6000 : INITIAL_VISIBLE_MS);
}

function hideWidget() {
  if (windowState !== 'visible' || dragging || snapping) return;
  clearHideTimers();
  windowState = 'hiding';
  send('widget:visibility', false);
  clearTimeout(hideCompleteTimer);
  hideCompleteTimer = setTimeout(() => {
    hideCompleteTimer = null;
    if (windowState === 'hiding' && win && !win.isDestroyed()) {
      win.hide();
      windowState = 'hidden';
    }
  }, 240);
}

function cancelPendingHide() {
  if (windowState !== 'hiding') return;
  clearTimeout(hideCompleteTimer);
  hideCompleteTimer = null;
  windowState = 'visible';
  send('widget:visibility', true);
  if (latestState) send('widget:state', latestState);
}

function cancelSnapAnimation() {
  snapToken += 1;
  clearTimeout(snapTimer);
  snapTimer = null;
  snapping = false;
}

function animateWindowTo(targetX, targetY, duration, done) {
  if (!win || win.isDestroyed()) return;
  if (
    !Number.isFinite(targetX) ||
    !Number.isFinite(targetY) ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    log('snap aborted: invalid target', targetX, targetY, duration);
    dragging = false;
    send('widget:dragging', false);
    return;
  }

  cancelSnapAnimation();
  const token = snapToken;
  const start = win.getBounds();
  const startX = start.x;
  const startY = start.y;
  const startedAt = Date.now();
  snapping = true;
  dragging = false;

  const fail = (error, details) => {
    log(
      'snap move failed:',
      error && error.message ? error.message : String(error),
      JSON.stringify(details)
    );
    cancelSnapAnimation();
    dragging = false;
    send('widget:dragging', false);
    if (!hovered && !interacting) armHide(LEAVE_VISIBLE_MS);
  };

  const step = () => {
    if (!win || win.isDestroyed() || token !== snapToken) return;
    const progress = Math.min(1, (Date.now() - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const nextX = Math.round(startX + (targetX - startX) * eased);
    const nextY = Math.round(startY + (targetY - startY) * eased);
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
      fail(new Error('non-finite position'), { nextX, nextY });
      return;
    }
    try {
      win.setBounds({
        x: nextX,
        y: nextY,
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
      });
    } catch (error) {
      fail(error, { nextX, nextY, startX, startY, targetX, targetY, duration, progress });
      return;
    }
    if (progress < 1) {
      snapTimer = setTimeout(step, 12);
      return;
    }
    snapTimer = null;
    snapping = false;
    try {
      win.setBounds({
        x: Math.round(targetX),
        y: Math.round(targetY),
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
      });
    } catch (error) {
      log('snap final position failed:', error.message);
    }
    if (done) done();
  };

  step();
}

async function snapToNearestCorner() {
  clearTimeout(snapStartTimer);
  snapStartTimer = null;
  if (!win || win.isDestroyed()) {
    dragging = false;
    return;
  }
  if (snapping) return;

  const bounds = win.getBounds();
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const area = display.workArea;
  const side =
    bounds.x + bounds.width / 2 < area.x + area.width / 2 ? 'left' : 'right';
  const vertical =
    bounds.y + bounds.height / 2 < area.y + area.height / 2 ? 'top' : 'bottom';
  const targetX = side === 'left' ? area.x : area.x + area.width - WINDOW_WIDTH;
  const targetY =
    vertical === 'top' ? area.y : area.y + area.height - WINDOW_HEIGHT;
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    log('snap target invalid:', display.id, JSON.stringify(area));
    dragging = false;
    send('widget:dragging', false);
    return;
  }
  if (process.env.GLASS_DEBUG) {
    log(
      'snap:',
      JSON.stringify({
        display: display.id,
        bounds,
        cursor: cursorPoint,
        area,
        side,
        vertical,
        targetX,
        targetY,
        scale: display.scaleFactor,
      })
    );
  }

  const sideChanged = side !== windowSide || vertical !== windowVertical;
  windowSide = side;
  windowVertical = vertical;
  saveCorner();
  if (sideChanged) sendLayout();

  dragging = false;

  const distance = Math.hypot(targetX - bounds.x, targetY - bounds.y);
  if (distance < 2) {
    send('widget:dragging', false);
    if (!hovered && !interacting) armHide(LEAVE_VISIBLE_MS);
    return;
  }

  const duration = Math.min(420, Math.max(210, 170 + distance * 0.22));
  animateWindowTo(targetX, targetY, duration, () => {
    send('widget:dragging', false);
    if (!hovered && !interacting) armHide(LEAVE_VISIBLE_MS);
  });
}

function trackKey(state) {
  return [state.source || '', state.title || '', state.artist || '', state.album || ''].join('\u001f');
}

function publishState(state) {
  latestState = state;
  if (typeof state.art === 'string' && state.art.length > 0) {
    lastArt = state.art;
    lastArtId = state.artId;
  } else if (state.art === null || (state.artId && state.artId !== lastArtId)) {
    lastArt = null;
    lastArtId = state.artId ?? null;
  }
  send('widget:state', state);

  if (!state.session) {
    lastTrackKey = null;
    lastStatus = null;
    return;
  }

  if (!rendererReady) return;

  const key = trackKey(state);
  const status = state.status;

  if (!sawFirstState) {
    sawFirstState = true;
    lastTrackKey = key;
    lastStatus = status;
    showWidget('startup');
    return;
  }

  const changedTrack = lastTrackKey !== null && key !== lastTrackKey;
  const paused = lastStatus === 'playing' && status === 'paused';

  lastTrackKey = key;
  lastStatus = status;

  if (changedTrack || paused) {
    showWidget(changedTrack ? 'track' : 'pause');
  }
}

function publishVolume(payload) {
  send('widget:volume', payload);
}

function publishSeek(payload) {
  send('widget:seek', payload);
}

function handleBridgeLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    log('bridge: invalid json', line.slice(0, 200));
    return;
  }
  if (message.type === 'state') publishState(message);
  else if (message.type === 'volume') publishVolume(message);
  else if (message.type === 'seek') publishSeek(message);
}

function bridgeCommand(command) {
  if (!bridge || !bridge.stdin || bridge.stdin.destroyed) return;
  try {
    bridge.stdin.write(JSON.stringify(command) + '\n');
  } catch (error) {
    log('bridge command failed:', error.message);
  }
}

function startBridge() {
  if (MOCK || quitting) return;
  const exe = path.join(ROOT, 'native', 'media-bridge.exe');
  const script = path.join(ROOT, 'native', 'bridge.py');
  const venvPython = path.join(ROOT, '.venv', 'Scripts', 'python.exe');

  let command;
  let args;
  if (!app.isPackaged && fs.existsSync(venvPython) && fs.existsSync(script)) {
    command = venvPython;
    args = [script];
  } else if (fs.existsSync(exe)) {
    command = exe;
    args = [];
  } else {
    log('media bridge executable not found:', exe);
    return;
  }

  log('starting media bridge:', command);
  bridge = spawn(command, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  });

  bridge.stdout.setEncoding('utf8');
  bridge.stderr.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    bridgeBuffer += chunk;
    let index;
    while ((index = bridgeBuffer.indexOf('\n')) >= 0) {
      const line = bridgeBuffer.slice(0, index);
      bridgeBuffer = bridgeBuffer.slice(index + 1);
      handleBridgeLine(line);
    }
    if (bridgeBuffer.length > 4 * 1024 * 1024) bridgeBuffer = '';
  });
  bridge.stderr.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) log('bridge:', line.trim());
    }
  });
  bridge.on('error', (error) => log('bridge process error:', error.message));
  bridge.on('exit', (code, signal) => {
    log(`media bridge exited (${code ?? 'null'}, ${signal ?? 'no signal'})`);
    bridge = null;
    if (!quitting) {
      clearTimeout(bridgeRestartTimer);
      bridgeRestartTimer = setTimeout(startBridge, 1800);
    }
  });
}

let mockArt = null;
let mockLastTick = 0;
let mockFirstArt = true;
const MOCK_DURATION = 137.207;

function emitMockState() {
  const now = Date.now();
  if (mockPlaying && mockLastTick && !MOCK_STATIC) {
    mockPosition += (now - mockLastTick) / 1000;
    if (mockPosition > MOCK_DURATION) mockPosition = 0;
  }
  mockLastTick = now;
  const track = MOCK_TRACKS[mockTrackIndex % MOCK_TRACKS.length];
  publishState({
    type: 'state',
    session: true,
    source: 'mock.player',
    title: track.title,
    artist: track.artist,
    album: 'Aeri preview',
    status: mockPlaying ? 'playing' : 'paused',
    position: mockPosition,
    duration: MOCK_DURATION,
    canSeek: true,
    canNext: true,
    canPrevious: true,
    canToggle: true,
    volume: mockVolume,
    muted: mockMuted,
    artId: `mock-cover-${mockTrackIndex}`,
    ...(mockFirstArt && mockArt ? { art: mockArt } : {}),
    timestamp: Date.now() / 1000,
  });
  mockFirstArt = false;
}

function startMock() {
  const artPath = path.join(ROOT, 'assets', 'yandex-art.png');
  try {
    mockArt = 'data:image/png;base64,' + fs.readFileSync(artPath).toString('base64');
  } catch {
    mockArt = null;
  }
  mockPosition = 34;
  mockVolume = 0.64;
  mockMuted = false;
  mockPlaying = true;
  mockTrackIndex = 0;
  mockFirstArt = true;
  mockLastTick = Date.now();
  emitMockState();
  publishVolume({ volume: mockVolume, muted: mockMuted });
  mockTimer = setInterval(emitMockState, 500);
  setTimeout(() => {
    mockPlaying = false;
    emitMockState();
  }, 9000);
}

function createWindow() {
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setMenu(null);
  win.setAlwaysOnTop(true, 'floating');
  win.setSkipTaskbar(true);
  win.on('will-move', () => {
    cancelPendingHide();
    clearTimeout(snapStartTimer);
    snapStartTimer = null;
    if (snapping) cancelSnapAnimation();
    if (!dragging) {
      dragging = true;
      clearHideTimers();
      if (process.env.GLASS_DEBUG) log('drag start:', JSON.stringify(win.getBounds()));
      send('widget:dragging', true);
    }
  });
  win.on('moved', () => {
    cancelPendingHide();
    if (process.env.GLASS_DEBUG) log('drag end:', JSON.stringify(win.getBounds()));
    if (!dragging) {
      dragging = true;
      clearHideTimers();
      send('widget:dragging', true);
    }
    clearTimeout(snapStartTimer);
    snapStartTimer = setTimeout(() => {
      snapStartTimer = null;
      if (dragging) snapToNearestCorner();
    }, 24);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: {
      side: windowSide,
      vertical: windowVertical,
      glass: liquidGlass ? 'on' : 'off',
    },
  });

  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    log('renderer ready');
    const initialDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    sendLayout();
    positionWindow(initialDisplay);
    if (latestState) send('widget:state', latestState);
    if (lastArt) send('widget:art', { artId: lastArtId, art: lastArt });
    if (latestState && latestState.session && windowState === 'hidden') {
      sawFirstState = true;
      lastTrackKey = trackKey(latestState);
      lastStatus = latestState.status;
      showWidget('startup');
    }
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    log('renderer gone:', details.reason);
    rendererReady = false;
  });


}

function buildTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png'));
    tray = new Tray(icon);
    tray.setToolTip('Aeri');
    trayMenu = Menu.buildFromTemplate([
      {
        label: 'Показать виджет',
        click: () => showWidget('manual'),
      },
      {
        id: 'liquid-glass',
        label: 'Liquid glass',
        type: 'checkbox',
        checked: liquidGlass,
        click: (item) => setLiquidGlass(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => app.quit(),
      },
    ]);
    tray.setContextMenu(trayMenu);
    tray.on('click', () => showWidget('manual'));
  } catch (error) {
    log('tray failed:', error.message);
  }
}

function registerIpc() {
  ipcMain.on('glass:hover', (_event, value) => {
    hovered = Boolean(value);
    if (hovered) {
      clearHideTimers();
      if (windowState === 'hiding') showWidget('hover');
    } else if (!interacting) {
      armHide(LEAVE_VISIBLE_MS);
    }
  });
  ipcMain.on('glass:focus', () => {
    focusWidget();
  });
  ipcMain.on('glass:interaction', (_event, value) => {
    interacting = Boolean(value);
    if (interacting) {
      clearHideTimers();
      cancelPendingHide();
    } else if (!hovered) {
      armHide(LEAVE_VISIBLE_MS);
    }
  });
  ipcMain.on('glass:volume', (_event, value) => {
    if (!(typeof value === 'number' && Number.isFinite(value))) return;
    if (process.env.GLASS_DEBUG) log('control: volume', value.toFixed(3));
    const level = Math.max(0, Math.min(1, value));
    if (MOCK) {
      mockVolume = level;
      publishVolume({ volume: mockVolume, muted: mockMuted });
    } else {
      bridgeCommand({ cmd: 'setVolume', value: level });
    }
  });
  ipcMain.on('glass:muted', (_event, value) => {
    if (process.env.GLASS_DEBUG) log('control: muted', Boolean(value));
    if (MOCK) {
      mockMuted = Boolean(value);
      publishVolume({ volume: mockVolume, muted: mockMuted });
    } else {
      bridgeCommand({ cmd: 'setMuted', value: Boolean(value) });
    }
  });
  ipcMain.on('glass:seek', (_event, value) => {
    if (!(typeof value === 'number' && Number.isFinite(value))) return;
    if (process.env.GLASS_DEBUG) log('control: seek', value.toFixed(3));
    const position = Math.max(0, Math.min(MOCK_DURATION, value));
    if (MOCK) {
      mockPosition = position;
      mockLastTick = Date.now();
      publishSeek({ ok: true, position });
      emitMockState();
    } else {
      bridgeCommand({ cmd: 'seek', value: Math.max(0, value) });
    }
  });
  ipcMain.on('glass:toggle', () => {
    if (process.env.GLASS_DEBUG) log('control: toggle');
    if (MOCK) {
      mockPlaying = !mockPlaying;
      mockLastTick = Date.now();
      emitMockState();
    } else {
      bridgeCommand({ cmd: 'toggle' });
    }
  });
  ipcMain.on('glass:next', () => {
    if (process.env.GLASS_DEBUG) log('control: next');
    if (MOCK) {
      mockTrackIndex = (mockTrackIndex + 1) % MOCK_TRACKS.length;
      mockPosition = 0;
      mockLastTick = Date.now();
      emitMockState();
    } else {
      bridgeCommand({ cmd: 'next' });
    }
  });
  ipcMain.on('glass:previous', () => {
    if (process.env.GLASS_DEBUG) log('control: previous');
    if (MOCK) {
      mockTrackIndex = (mockTrackIndex + MOCK_TRACKS.length - 1) % MOCK_TRACKS.length;
      mockPosition = 0;
      mockLastTick = Date.now();
      emitMockState();
    } else {
      bridgeCommand({ cmd: 'previous' });
    }
  });
  ipcMain.on('glass:requestState', () => {
    if (latestState) send('widget:state', latestState);
    if (lastArt) send('widget:art', { artId: lastArtId, art: lastArt });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.brouseee.aeri');

  app.on('second-instance', () => {
    showWidget('manual');
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    trimLog();
    log(`Aeri starting${MOCK ? ' (mock)' : ''}`);
    migrateLegacySettings();
    loadCorner();
    loadSettings();
    if (process.env.GLASS_DEBUG) {
      log(
        'displays:',
        JSON.stringify(
          screen.getAllDisplays().map((display) => ({
            id: display.id,
            bounds: display.bounds,
            workArea: display.workArea,
            scale: display.scaleFactor,
          }))
        )
      );
    }
    registerIpc();
    createWindow();
    buildTray();
    setInterval(syncCursorHover, 140);
    if (MOCK) startMock();
    else startBridge();
  });

  app.on('window-all-closed', () => {
    // Keep the tray application alive.
  });

  app.on('before-quit', () => {
    quitting = true;
    clearHideTimers();
    clearTimeout(hideCompleteTimer);
    clearTimeout(bridgeRestartTimer);
    clearTimeout(snapStartTimer);
    clearTimeout(snapTimer);
    clearInterval(mockTimer);
    if (bridge) {
      try {
        bridgeCommand({ cmd: 'shutdown' });
        bridge.kill();
      } catch {
        /* ignore */
      }
      bridge = null;
    }
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });
}
