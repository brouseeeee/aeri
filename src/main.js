'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  screen,
} = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Keep these values in sync with the layout custom properties in style.css.
const STAGE_PADDING = 20;
const PLAYER = { width: 360, height: 128 };
const VOLUME = { width: 40, height: 128 };
const PANEL_GAP = 10;
const WINDOW_WIDTH = PLAYER.width + VOLUME.width + PANEL_GAP + STAGE_PADDING * 2;
const WINDOW_HEIGHT = Math.max(PLAYER.height, VOLUME.height) + STAGE_PADDING * 2;
const WINDOWS10_WINDOW = { width: 568, height: 176 };
const WINDOWS10_EDGE_GAP = { horizontal: 48, vertical: 56 };
const INITIAL_VISIBLE_MS = 4500;
const LEAVE_VISIBLE_MS = 2000;
const MOCK = process.argv.includes('--mock');
const MOCK_STATIC = process.argv.includes('--mock-static');
const WINDOWS_BUILD = Number(os.release().split('.')[2]) || 0;
const IS_WINDOWS_10 = process.platform === 'win32' && WINDOWS_BUILD >= 10240 && WINDOWS_BUILD < 22000;
const WINDOWS_10_MTCUVC_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\MTCUVC';

let win = null;
let tray = null;
let bridge = null;
let bridgeBuffer = '';
let bridgeRestartTimer = null;
let rendererWatcher = null;
let rendererReloadTimer = null;
let quitting = false;
let rendererReady = false;

let latestState = null;
let lastTrackKey = null;
let lastStatus = null;
let sawFirstState = false;
let lastArt = null;
let lastArtId = null;
let lastAppIcon = null;
let lastAppIconId = null;
let appIconRequest = 0;

let windowSide = 'right';
let windowVertical = 'bottom';
let liquidGlass = true;
let windows10Style = false;
let showOnTrackChange = true;
let showOnVolumeChange = true;
let windows10MediaFlyoutDisabled = false;
let hideWindows10VolumeOsd = false;
let trayMenu = null;
let lastVolumeSnapshot = null;
let dragging = false;
let customWindowDrag = null;
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
  if (windows10Style) {
    return {
      player: {
        x: bounds.x,
        y: bounds.y,
        width: WINDOWS10_WINDOW.width,
        height: WINDOWS10_WINDOW.height,
      },
      volume: null,
    };
  }

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
  return [rects.player, rects.volume].filter(Boolean).some(
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
    windows10Style,
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
    windows10Style = Boolean(data && data.windows10Style === true);
    showOnTrackChange = !data || data.showOnTrackChange !== false;
    showOnVolumeChange = !data || data.showOnVolumeChange !== false;
    hideWindows10VolumeOsd = Boolean(data && data.hideWindows10VolumeOsd === true);
    liquidGlass = !windows10Style;
  } catch {
    /* first launch or unreadable settings */
  }
  if (IS_WINDOWS_10) {
    windows10MediaFlyoutDisabled = readWindows10MediaFlyoutDisabled();
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        liquidGlass,
        windows10Style,
        showOnTrackChange,
        showOnVolumeChange,
        hideWindows10VolumeOsd,
      })
    );
    return true;
  } catch (error) {
    log('settings save failed:', error.message);
    return false;
  }
}

function readWindows10MediaFlyoutDisabled() {
  try {
    const output = execFileSync(
      'reg.exe',
      ['query', WINDOWS_10_MTCUVC_KEY, '/v', 'EnableMtcUvc'],
      { encoding: 'utf8', windowsHide: true }
    );
    const match = output.match(/EnableMtcUvc\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    return match ? Number.parseInt(match[1], 16) === 0 : false;
  } catch (error) {
    if (error.status !== 1) {
      log('Windows 10 media flyout setting read failed:', error.message);
    }
    return false;
  }
}

function writeWindows10MediaFlyoutDisabled(disabled) {
  const registryArguments = `add "${WINDOWS_10_MTCUVC_KEY}" /v EnableMtcUvc /t REG_DWORD /d ${disabled ? '0' : '1'} /f`;
  const script = `$process = Start-Process -FilePath "$env:SystemRoot\\System32\\reg.exe" -ArgumentList '${registryArguments}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $process.ExitCode`;
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const process = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedScript],
      { windowsHide: true, stdio: 'ignore' }
    );
    process.once('error', reject);
    process.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Windows registry command exited with code ${code}`));
    });
  });
}

function setBooleanSetting(name, value) {
  const previous = name === 'track' ? showOnTrackChange : showOnVolumeChange;
  if (name === 'track') showOnTrackChange = value;
  else showOnVolumeChange = value;

  if (!saveSettings()) {
    if (name === 'track') showOnTrackChange = previous;
    else showOnVolumeChange = previous;
    dialog.showErrorBox('Aeri', 'Не удалось сохранить настройку. Проверьте доступ к файлу настроек.');
  }
  refreshTrayMenu();
}

function setWindows10VolumeOsdHidden(hidden) {
  const previous = hideWindows10VolumeOsd;
  hideWindows10VolumeOsd = hidden;
  if (!saveSettings()) {
    hideWindows10VolumeOsd = previous;
    dialog.showErrorBox('Aeri', 'Не удалось сохранить настройку. Проверьте доступ к файлу настроек.');
    refreshTrayMenu();
    return;
  }
  bridgeCommand({ cmd: 'setVolumeOsdHidden', value: hidden });
  refreshTrayMenu();
}

async function setWindows10MediaFlyoutSetting(disabled) {
  try {
    await writeWindows10MediaFlyoutDisabled(disabled);
    windows10MediaFlyoutDisabled = disabled;
    refreshTrayMenu();
    dialog.showMessageBox({
      type: 'info',
      title: 'Aeri',
      message: 'Настройка Windows сохранена. Aeri не перезапускал Проводник.',
      detail: 'Windows может применить изменение после выхода из учётной записи или перезапуска Проводника вручную.',
    }).catch((error) => log('media flyout notice failed:', error.message));
  } catch (error) {
    log('Windows 10 media flyout setting update failed:', error.message);
    refreshTrayMenu();
    dialog.showErrorBox(
      'Aeri',
      `Не удалось изменить настройку медиаблока Windows 10. Подтвердите запрос UAC и повторите попытку.\n\n${error.message}`
    );
  }
}

function setWidgetStyle(style) {
  liquidGlass = style === 'liquid-glass';
  windows10Style = style === 'windows-10';
  saveSettings();
  refreshTrayMenu();
  if (win && !win.isDestroyed()) {
    positionWindow(screen.getDisplayMatching(win.getBounds()));
  }
  loadRenderer();
  showWidget('manual');
}

function windowSize() {
  return windows10Style
    ? WINDOWS10_WINDOW
    : { width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
}

function moveWindowTo(x, y) {
  if (!win || win.isDestroyed()) return;
  const { width, height } = windowSize();
  win.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width,
    height,
  });
}

function beginWindowDrag(x, y) {
  if (
    !windows10Style ||
    !win ||
    win.isDestroyed() ||
    windowState !== 'visible' ||
    customWindowDrag ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return;
  }

  cancelPendingHide();
  clearHideTimers();
  if (snapping) cancelSnapAnimation();
  customWindowDrag = {
    cursor: { x, y },
    bounds: win.getBounds(),
  };
  dragging = true;
  send('widget:dragging', true);
  if (process.env.GLASS_DEBUG) {
    log('pointer drag start:', JSON.stringify(customWindowDrag.bounds));
  }
}

function moveWindowDrag(x, y) {
  if (
    !customWindowDrag ||
    !win ||
    win.isDestroyed() ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return;
  }
  moveWindowTo(
    customWindowDrag.bounds.x + x - customWindowDrag.cursor.x,
    customWindowDrag.bounds.y + y - customWindowDrag.cursor.y
  );
}

function endWindowDrag() {
  if (!customWindowDrag) return;
  customWindowDrag = null;
  if (process.env.GLASS_DEBUG && win && !win.isDestroyed()) {
    log('pointer drag end:', JSON.stringify(win.getBounds()));
  }
  snapToNearestCorner();
}

function positionWindow(display) {
  const area = display.workArea;
  const { width, height } = windowSize();
  const horizontalGap = windows10Style ? WINDOWS10_EDGE_GAP.horizontal : 0;
  const verticalGap = windows10Style ? WINDOWS10_EDGE_GAP.vertical : 0;
  const x = windowSide === 'left'
    ? area.x + horizontalGap
    : area.x + area.width - width - horizontalGap;
  const y = windowVertical === 'top'
    ? area.y + verticalGap
    : area.y + area.height - height - verticalGap;
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
  const { width, height } = windowSize();
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
        width,
        height,
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
        width,
        height,
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
  const { width, height } = windowSize();
  const horizontalGap = windows10Style ? WINDOWS10_EDGE_GAP.horizontal : 0;
  const verticalGap = windows10Style ? WINDOWS10_EDGE_GAP.vertical : 0;
  const targetX = side === 'left'
    ? area.x + horizontalGap
    : area.x + area.width - width - horizontalGap;
  const targetY = vertical === 'top'
    ? area.y + verticalGap
    : area.y + area.height - height - verticalGap;
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

function observeVolumeChange(state) {
  if (typeof state.volume !== 'number' || !Number.isFinite(state.volume)) return;

  const next = {
    volume: state.volume,
    muted: Boolean(state.muted),
  };
  const previous = lastVolumeSnapshot;
  lastVolumeSnapshot = next;
  if (
    previous &&
    (Math.abs(next.volume - previous.volume) >= 0.005 || next.muted !== previous.muted) &&
    showOnVolumeChange
  ) {
    showWidget('volume');
  }
}

function publishState(state) {
  latestState = state;
  observeVolumeChange(state);
  let artworkChanged = false;
  if (typeof state.art === 'string' && state.art.length > 0) {
    lastArt = state.art;
    lastArtId = state.artId;
    artworkChanged = true;
  } else if (state.art === null || (state.artId && state.artId !== lastArtId)) {
    lastArt = null;
    lastArtId = state.artId ?? null;
    artworkChanged = true;
  }
  if (artworkChanged) {
    send('widget:art', { artId: lastArtId, art: lastArt });
  }
  if (Object.prototype.hasOwnProperty.call(state, 'appIcon')) publishAppIcon(state);
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

  if ((changedTrack && showOnTrackChange) || paused) {
    showWidget(changedTrack && showOnTrackChange ? 'track' : 'pause');
  }
}

function publishVolume(payload) {
  observeVolumeChange(payload);
  send('widget:volume', payload);
}

function publishArt(payload) {
  if (!latestState || payload.artId !== latestState.artId) return;
  lastArtId = payload.artId;
  lastArt = typeof payload.art === 'string' && payload.art.length > 0 ? payload.art : null;
  latestState.art = lastArt;
  send('widget:art', { artId: lastArtId, art: lastArt });
}

function publishAppIcon(payload) {
  if (!latestState || (payload.appIconId && payload.appIconId !== latestState.source)) return;
  const request = ++appIconRequest;
  lastAppIconId = payload.appIconId || payload.source || latestState.source || null;
  lastAppIcon = typeof payload.appIcon === 'string' && payload.appIcon.length > 0
    ? normalizeAppIcon(payload.appIcon, lastAppIconId)
    : null;
  latestState.appIcon = lastAppIcon;
  latestState.appIconId = lastAppIconId;
  latestState.appIconPath = payload.appIconPath || null;
  send('widget:app-icon', { appIconId: lastAppIconId, appIcon: lastAppIcon });
  if (!lastAppIcon && typeof payload.appIconPath === 'string' && payload.appIconPath.length > 0) {
    loadAppIconFromPath(payload.appIconPath, lastAppIconId, request);
  }
}

function publishSeek(payload) {
  send('widget:seek', payload);
}

function normalizeAppIcon(dataUri, source) {
  try {
    const image = nativeImage.createFromDataURL(dataUri);
    if (image.isEmpty()) throw new Error('unsupported or empty image data');
    return resizeAppIcon(image, source);
  } catch (error) {
    log('application icon decode failed:', source, error.message);
    return null;
  }
}

function resizeAppIcon(image, source) {
  try {
    if (image.isEmpty()) throw new Error('empty image');
    const size = image.getSize();
    const bitmap = image.getBitmap();
    if (size.width > 0 && size.height > 0 && bitmap.length >= size.width * size.height * 4) {
      let left = size.width;
      let top = size.height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < size.height; y += 1) {
        for (let x = 0; x < size.width; x += 1) {
          if (bitmap[(y * size.width + x) * 4 + 3] === 0) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      if (right >= left && bottom >= top) {
        image = image.crop({
          x: left,
          y: top,
          width: right - left + 1,
          height: bottom - top + 1,
        });
      }
    }
    return image.resize({ width: 32, height: 32 }).toDataURL();
  } catch (error) {
    log('application icon resize failed:', source, error.message);
    return null;
  }
}

function loadAppIconFromPath(iconPath, source, request) {
  Promise.resolve().then(() => app.getFileIcon(iconPath, { size: 'normal' })).then((image) => {
    if (request !== appIconRequest) return;
    lastAppIcon = resizeAppIcon(image, source);
    send('widget:app-icon', { appIconId: source, appIcon: lastAppIcon });
  }).catch((error) => {
    if (request !== appIconRequest) return;
    lastAppIcon = null;
    log('application icon lookup failed:', source, error.message);
    send('widget:app-icon', { appIconId: source, appIcon: null });
  });
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
  else if (message.type === 'art') publishArt(message);
  else if (message.type === 'appIcon') publishAppIcon(message);
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
  if (IS_WINDOWS_10) {
    bridgeCommand({ cmd: 'setVolumeOsdHidden', value: hideWindows10VolumeOsd });
  }

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
  const { width, height } = windowSize();
  win = new BrowserWindow({
    width,
    height,
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
    if (customWindowDrag) return;
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
    if (customWindowDrag) return;
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
  loadRenderer();

  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    log('renderer ready');
    const initialDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    sendLayout();
    send('widget:visibility', windowState !== 'hidden');
    positionWindow(initialDisplay);
    if (latestState) send('widget:state', latestState);
    if (lastArt) send('widget:art', { artId: lastArtId, art: lastArt });
    if (lastAppIconId) {
      send('widget:app-icon', { appIconId: lastAppIconId, appIcon: lastAppIcon });
    }
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

function loadRenderer() {
  if (!win || win.isDestroyed()) return;
  rendererReady = false;
  const rendererDir = path.join(__dirname, 'renderer');
  const page = windows10Style
    ? path.join(rendererDir, 'themes', 'windows-10', 'windows-10.html')
    : path.join(rendererDir, 'themes', 'liquid-glass', 'liquid-glass.html');

  win.loadFile(page, {
    query: {
      side: windowSide,
      vertical: windowVertical,
      glass: liquidGlass ? 'on' : 'off',
      windows10Style: windows10Style ? 'on' : 'off',
    },
  }).catch((error) => log('renderer load failed:', error.message));
}

function watchRendererFiles() {
  if (app.isPackaged) return;

  const rendererDir = path.join(__dirname, 'renderer');
  try {
    rendererWatcher = fs.watch(rendererDir, { recursive: true }, (_event, filename) => {
      if (filename && !/\.(html|css|js)$/i.test(filename.toString())) return;
      clearTimeout(rendererReloadTimer);
      rendererReloadTimer = setTimeout(() => {
        rendererReloadTimer = null;
        if (quitting || !win || win.isDestroyed()) return;
        log('renderer files changed; reloading');
        loadRenderer();
      }, 200);
    });
    rendererWatcher.on('error', (error) => {
      log('renderer file watcher error:', error.message);
    });
    log('watching renderer files for changes');
  } catch (error) {
    log('renderer file watcher failed:', error.message);
  }
}


function buildTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png'));
    tray = new Tray(icon);
    tray.setToolTip('Aeri');
    refreshTrayMenu();
    tray.on('click', () => showWidget('manual'));
  } catch (error) {
    log('tray failed:', error.message);
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const settingsMenu = [
    {
      label: 'Показывать виджет при смене трека',
      type: 'checkbox',
      checked: showOnTrackChange,
      click: (item) => setBooleanSetting('track', item.checked),
    },
    {
      label: 'Показывать виджет при изменении громкости',
      type: 'checkbox',
      checked: showOnVolumeChange,
      click: (item) => setBooleanSetting('volume', item.checked),
    },
  ];
  if (IS_WINDOWS_10) {
    settingsMenu.push(
      { type: 'separator' },
      {
        label: 'Отключить штатный медиаблок Windows 10',
        type: 'checkbox',
        checked: windows10MediaFlyoutDisabled,
        click: (item) => {
          setWindows10MediaFlyoutSetting(item.checked);
        },
      },
      {
        label: 'Скрывать панель громкости Windows 10',
        type: 'checkbox',
        checked: hideWindows10VolumeOsd,
        click: (item) => setWindows10VolumeOsdHidden(item.checked),
      }
    );
  }

  trayMenu = Menu.buildFromTemplate([
    {
      label: 'Показать виджет',
      click: () => showWidget('manual'),
    },
    {
      id: 'liquid-glass',
      label: 'Liquid glass',
      type: 'radio',
      checked: liquidGlass,
      click: () => setWidgetStyle('liquid-glass'),
    },
    {
      id: 'windows-10-style',
      label: 'Windows 10 style',
      type: 'radio',
      checked: windows10Style,
      click: () => setWidgetStyle('windows-10'),
    },
    {
      label: 'Настройки',
      submenu: settingsMenu,
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(trayMenu);
}

function registerIpc() {
  ipcMain.on('glass:windowDrag:start', (_event, x, y) => beginWindowDrag(x, y));
  ipcMain.on('glass:windowDrag:move', (_event, x, y) => moveWindowDrag(x, y));
  ipcMain.on('glass:windowDrag:end', () => endWindowDrag());
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
    if (lastAppIconId) {
      send('widget:app-icon', { appIconId: lastAppIconId, appIcon: lastAppIcon });
    }
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
    watchRendererFiles();
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
    clearTimeout(rendererReloadTimer);
    clearTimeout(snapStartTimer);
    clearTimeout(snapTimer);
    clearInterval(mockTimer);
    if (rendererWatcher) {
      rendererWatcher.close();
      rendererWatcher = null;
    }
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
