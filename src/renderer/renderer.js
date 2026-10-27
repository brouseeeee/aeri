'use strict';

const stage = document.getElementById('stage');
const widget = document.getElementById('widget');
const volumePanel = document.getElementById('volumePanel');
const cover = document.getElementById('cover');
const coverWrap = document.getElementById('coverWrap');
const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');
const previousButton = document.getElementById('previousButton');
const playButton = document.getElementById('playButton');
const nextButton = document.getElementById('nextButton');
const elapsedEl = document.getElementById('elapsed');
const totalEl = document.getElementById('total');
const seekRow = document.querySelector('.seek-row');
const seek = document.getElementById('seek');
const seekFill = document.getElementById('seekFill');
const seekKnob = document.getElementById('seekKnob');
const volumeRow = document.getElementById('volumeRow');
const volumeButton = document.getElementById('volumeButton');
const volume = document.getElementById('volume');
const volumeFill = document.getElementById('volumeFill');
const volumeKnob = document.getElementById('volumeKnob');
const volumeValue = document.getElementById('volumeValue');

const initialParams = new URLSearchParams(window.location.search);

function glassMode(value) {
  if (value === true || value === 'on') return 'on';
  if (value === false || value === 'off') return 'off';
  return null;
}

function applyLayout(layout) {
  if (!layout) return;
  if (layout.side === 'left' || layout.side === 'right') stage.dataset.side = layout.side;
  if (layout.vertical === 'top' || layout.vertical === 'bottom') {
    stage.dataset.vertical = layout.vertical;
  }
  const glass = glassMode(layout.glass);
  if (glass) stage.dataset.glass = glass;
}
applyLayout({
  side: initialParams.get('side'),
  vertical: initialParams.get('vertical'),
  glass: initialParams.get('glass'),
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const PROGRESS_INTERVAL = 250;

let trackId = null;
let artId = null;
let artUrl = null;
let basePosition = 0;
let baseTime = performance.now();
let playing = false;
let uiPlaying = false;
let duration = 0;
let lastReportedPosition = null;
let canSeek = false;
let canNext = false;
let canPrevious = false;
let canToggle = false;
let lastSeekEnabled = null;
let lastPercent = -1;
let lastElapsedText = '';
let lastTotalText = '';
let lastControlKey = '';

let seekDragging = false;
let seekTarget = null;
let seekHoldUntil = 0;

let volumeDragging = false;
let volumeLevel = 0.5;
let muted = false;
let lastVolumeLocalAt = 0;
let lastVolumeSendAt = 0;
let lastVolumePercent = -1;

let pointerActive = false;
let tipTimer = null;
let seekFlashTimer = null;
let exitTimer = null;
let trackAnimationTimer = null;
let pendingTrackAnimation = false;
let optimisticPlaying = null;
let optimisticStateUntil = 0;
let progressTimer = null;
let widgetVisible = false;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.max(0, Math.floor(seconds + 0.0001));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function currentPosition() {
  if (seekTarget !== null) return seekTarget;
  let value = basePosition;
  if (playing) value += (performance.now() - baseTime) / 1000;
  if (duration > 0) value = Math.min(value, duration);
  return Math.max(0, value);
}

function updateProgress() {
  const position = currentPosition();
  const ratio = duration > 0 ? clamp(position / duration, 0, 1) : 0;
  seekFill.style.transform = `scaleX(${ratio})`;
  seekKnob.style.left = `${ratio * 100}%`;

  const elapsedText = formatTime(position);
  if (elapsedText !== lastElapsedText) {
    elapsedEl.textContent = elapsedText;
    seek.setAttribute('aria-valuetext', elapsedText);
    lastElapsedText = elapsedText;
  }

  const totalText = duration > 0 ? formatTime(duration) : '--:--';
  if (totalText !== lastTotalText) {
    totalEl.textContent = totalText;
    lastTotalText = totalText;
  }

  const percent = Math.round(ratio * 100);
  if (percent !== lastPercent) {
    seek.setAttribute('aria-valuenow', String(percent));
    lastPercent = percent;
  }

  if (lastSeekEnabled !== canSeek) {
    seek.classList.toggle('disabled', !canSeek);
    lastSeekEnabled = canSeek;
  }
}

function progressTick() {
  progressTimer = null;
  if (!widgetVisible || !playing || seekDragging) return;
  updateProgress();
  progressTimer = setTimeout(progressTick, PROGRESS_INTERVAL);
}

function syncProgressLoop() {
  clearTimeout(progressTimer);
  progressTimer = null;
  if (!widgetVisible || !playing || seekDragging) return;
  updateProgress();
  progressTimer = setTimeout(progressTick, PROGRESS_INTERVAL);
}

function applyArt(url, id) {
  if (url === artUrl && id === artId) return;
  artId = id ?? null;
  artUrl = url || null;

  if (!url) {
    coverWrap.classList.remove('has-art');
    cover.removeAttribute('src');
    return;
  }

  const loader = new Image();
  loader.decoding = 'async';
  loader.onload = () => {
    if (artUrl !== url) return;
    if (cover.getAttribute('src') !== url) cover.src = url;
    coverWrap.classList.add('has-art');
  };
  loader.onerror = () => {
    if (artUrl !== url) return;
    coverWrap.classList.remove('has-art');
    cover.removeAttribute('src');
  };
  loader.src = url;
}

function updateMeta(state) {
  const title = (state.title || 'Без названия').trim();
  const artist = (state.artist || 'Неизвестный исполнитель').trim();
  if (titleEl.textContent === title && artistEl.textContent === artist) return;

  titleEl.textContent = title;
  artistEl.textContent = artist;
  titleEl.title = title;
  artistEl.title = artist;
}

function updateControlState() {
  const hasControls = Boolean(trackId);
  const key = `${hasControls}${canPrevious}${canNext}${canToggle}${uiPlaying}`;
  if (key === lastControlKey) return;
  lastControlKey = key;

  previousButton.disabled = !hasControls || !canPrevious;
  nextButton.disabled = !hasControls || !canNext;
  playButton.disabled = !hasControls || !canToggle;
  playButton.setAttribute('aria-label', uiPlaying ? 'Пауза' : 'Воспроизвести');
}

function updateVolumeUi() {
  const percent = Math.round(volumeLevel * 100);
  volumeFill.style.transform = `scaleY(${volumeLevel})`;
  volumeKnob.style.bottom = `${volumeLevel * 100}%`;

  if (percent !== lastVolumePercent) {
    volumeValue.textContent = `${percent}%`;
    volume.setAttribute('aria-valuenow', String(percent));
    lastVolumePercent = percent;
  }

  volumeButton.classList.toggle('is-muted', muted);
  volumeButton.classList.toggle('is-low', !muted && volumeLevel < 0.35);
  volumeButton.setAttribute(
    'aria-label',
    muted ? 'Громкость, звук выключен' : `Громкость ${percent}%`
  );
}

function setVolume(value, mutedValue) {
  volumeLevel = clamp(Number(value) || 0, 0, 1);
  muted = Boolean(mutedValue);
  updateVolumeUi();
}

function flashVolumeTip() {
  volumeRow.classList.add('show-tip');
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => volumeRow.classList.remove('show-tip'), 1200);
}

function flashSeekTip() {
  widget.classList.add('seek-flash');
  clearTimeout(seekFlashTimer);
  seekFlashTimer = setTimeout(() => widget.classList.remove('seek-flash'), 800);
}

function clearTrackAnimation() {
  clearTimeout(trackAnimationTimer);
  trackAnimationTimer = null;
  pendingTrackAnimation = false;
  widget.classList.remove('track-change');
}

function playTrackAnimation() {
  if (reducedMotion.matches) return;
  clearTimeout(trackAnimationTimer);
  widget.classList.remove('track-change');
  void widget.offsetWidth;
  widget.classList.add('track-change');
  trackAnimationTimer = setTimeout(() => {
    widget.classList.remove('track-change');
    trackAnimationTimer = null;
  }, 900);
}

function queueTrackAnimation() {
  if (reducedMotion.matches) return;
  if (!widgetVisible) {
    pendingTrackAnimation = true;
    return;
  }
  pendingTrackAnimation = false;
  playTrackAnimation();
}

function handleState(state) {
  if (!state) return;

  if (!state.session) {
    trackId = null;
    playing = false;
    uiPlaying = false;
    duration = 0;
    lastReportedPosition = null;
    canSeek = false;
    canNext = false;
    canPrevious = false;
    canToggle = false;
    optimisticPlaying = null;
    optimisticStateUntil = 0;
    basePosition = 0;
    seekTarget = null;
    widget.classList.remove('playing');
    clearTrackAnimation();
    titleEl.textContent = 'Ничего не играет';
    artistEl.textContent = window.glass ? 'Включите трек в любом плеере' : '';
    applyArt(null, null);
    updateControlState();
    if (!volumeDragging && typeof state.volume === 'number') {
      setVolume(state.volume, state.muted);
    }
    updateProgress();
    syncProgressLoop();
    return;
  }

  duration = Number.isFinite(state.duration) ? Math.max(0, state.duration) : 0;
  canSeek = Boolean(state.canSeek) && duration > 0.5;
  canNext = state.canNext !== false;
  canPrevious = state.canPrevious !== false;
  canToggle = state.canToggle !== false;

  const now = performance.now();
  const actualPlaying = state.status === 'playing';
  const wasPlaying = playing;

  if (now < optimisticStateUntil && actualPlaying !== optimisticPlaying) {
    // Keep the icon responsive while the player acknowledges the command.
  } else {
    uiPlaying = actualPlaying;
    optimisticPlaying = null;
    optimisticStateUntil = 0;
  }
  widget.classList.toggle('playing', uiPlaying);
  updateControlState();

  const nextTrackId = [state.source, state.title, state.artist, state.album].join('\u001f');
  const trackChanged = nextTrackId !== trackId;
  const hadTrack = trackId !== null;
  if (trackChanged) {
    trackId = nextTrackId;
    updateMeta(state);
  }

  const reported = clamp(
    Number(state.position) || 0,
    0,
    duration || Number.MAX_SAFE_INTEGER
  );
  const reportChanged =
    lastReportedPosition === null || Math.abs(reported - lastReportedPosition) > 0.05;

  // Some players (notably Yandex Music) keep reporting the same timeline
  // position while playback is actually moving forward. Never reset the
  // local clock backwards just because a poll repeats that stale value.
  if (!seekDragging && now >= seekHoldUntil) {
    if (trackChanged || lastReportedPosition === null) {
      let anchor = reported;
      if (actualPlaying && Number.isFinite(state.lastUpdated)) {
        // Some players publish a position once and leave LastUpdatedTime to
        // describe when that snapshot was taken. Extrapolate it on the first
        // anchor so a mid-track start shows the real elapsed time.
        const age = Date.now() / 1000 - state.lastUpdated;
        if (age > 0 && age < 6 * 3600) {
          anchor = reported + age;
          if (duration > 0) anchor = Math.min(anchor, duration);
        }
      }
      basePosition = anchor;
      baseTime = now;
    } else if (!actualPlaying) {
      if (wasPlaying) {
        // Freeze at the locally interpolated position, not at a stale report.
        basePosition = clamp(currentPosition(), 0, duration || Number.MAX_SAFE_INTEGER);
        baseTime = now;
      } else if (reportChanged && Math.abs(reported - basePosition) > 0.75) {
        basePosition = reported;
        baseTime = now;
      }
    } else if (!wasPlaying) {
      // Resume from the frozen position and let the local clock run.
      baseTime = now;
      if (reported > basePosition + 0.75) {
        basePosition = reported;
      }
    } else {
      const local = currentPosition();
      if (reported > local + 0.75) {
        basePosition = reported;
        baseTime = now;
      } else if (reportChanged && reported < local - 8) {
        // A large backwards jump is a real external seek, not a stale poll.
        basePosition = reported;
        baseTime = now;
      }
    }
  }

  lastReportedPosition = reported;
  playing = actualPlaying;

  if (!volumeDragging && typeof state.volume === 'number' && now - lastVolumeLocalAt > 450) {
    const nextMuted = Boolean(state.muted);
    if (Math.abs(state.volume - volumeLevel) > 0.002 || nextMuted !== muted) {
      setVolume(state.volume, nextMuted);
    }
  }

  if (typeof state.art === 'string' && state.art.length > 0) {
    applyArt(state.art, state.artId);
  } else if (state.art === null || state.artId !== artId) {
    applyArt(null, state.artId ?? null);
  }

  if (trackChanged && hadTrack) queueTrackAnimation();

  updateProgress();
  syncProgressLoop();
}

function ratioFromEvent(event, element) {
  const rect = element.getBoundingClientRect();
  return clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
}

function verticalRatioFromEvent(event, element) {
  const rect = element.getBoundingClientRect();
  return clamp((rect.bottom - event.clientY) / Math.max(1, rect.height), 0, 1);
}

function pointInsideWidget(event) {
  const point = { x: event.clientX, y: event.clientY };
  return [widget, volumePanel].some((element) => {
    const rect = element.getBoundingClientRect();
    return (
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    );
  });
}

function beginPointerInteraction() {
  pointerActive = true;
  window.glass.interaction(true);
}

function endPointerInteraction(event) {
  pointerActive = seekDragging || volumeDragging;
  if (pointerActive) return;
  window.glass.interaction(false);
  if (event && !pointInsideWidget(event)) {
    window.glass.hover(false);
  }
}

function updateSeekPreview(event) {
  if (duration <= 0) return;
  seekTarget = ratioFromEvent(event, seek) * duration;
  updateProgress();
}

function finishSeek(event) {
  if (!seekDragging) return;
  seekDragging = false;
  seek.classList.remove('dragging');
  widget.classList.remove('seeking');
  const target = seekTarget;
  seekTarget = null;
  if (target !== null && canSeek) {
    basePosition = clamp(target, 0, duration);
    baseTime = performance.now();
    seekHoldUntil = baseTime + 900;
    window.glass.seek(basePosition);
  }
  updateProgress();
  syncProgressLoop();
  endPointerInteraction(event);
}

seekRow.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !canSeek) return;
  event.preventDefault();
  event.stopPropagation();
  seekDragging = true;
  pointerActive = true;
  seek.classList.add('dragging');
  widget.classList.add('seeking');
  seekRow.setPointerCapture(event.pointerId);
  beginPointerInteraction();
  updateSeekPreview(event);
  flashSeekTip();
  syncProgressLoop();
});

seekRow.addEventListener('pointermove', (event) => {
  if (!seekDragging) return;
  event.preventDefault();
  updateSeekPreview(event);
});

seekRow.addEventListener('pointerup', (event) => {
  if (!seekDragging) return;
  event.preventDefault();
  finishSeek(event);
});

seekRow.addEventListener('pointercancel', (event) => {
  if (!seekDragging) return;
  finishSeek(event);
});

seekRow.addEventListener('lostpointercapture', () => {
  if (seekDragging) finishSeek(null);
});

seekRow.addEventListener(
  'wheel',
  (event) => {
    if (!canSeek || duration <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const delta =
      Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!delta) return;
    const direction = delta < 0 ? 1 : -1;
    const target = clamp(currentPosition() + direction, 0, duration);
    basePosition = target;
    baseTime = performance.now();
    seekHoldUntil = baseTime + 950;
    seekTarget = null;
    window.glass.seek(target);
    updateProgress();
    flashSeekTip();
  },
  { passive: false }
);

volume.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  volumeDragging = true;
  pointerActive = true;
  volume.classList.add('dragging');
  volumeRow.classList.add('adjusting');
  volume.setPointerCapture(event.pointerId);
  beginPointerInteraction();
  const level = verticalRatioFromEvent(event, volume);
  const wasMuted = muted;
  setVolume(level, false);
  if (wasMuted) window.glass.setMuted(false);
  window.glass.setVolume(level);
  lastVolumeLocalAt = performance.now();
  lastVolumeSendAt = lastVolumeLocalAt;
  flashVolumeTip();
});

volume.addEventListener('pointermove', (event) => {
  if (!volumeDragging) return;
  event.preventDefault();
  const level = verticalRatioFromEvent(event, volume);
  setVolume(level, false);
  const now = performance.now();
  if (now - lastVolumeSendAt > 40) {
    window.glass.setVolume(level);
    lastVolumeSendAt = now;
    lastVolumeLocalAt = now;
  }
  flashVolumeTip();
});

function finishVolume(event) {
  if (!volumeDragging) return;
  volumeDragging = false;
  volume.classList.remove('dragging');
  volumeRow.classList.remove('adjusting');
  window.glass.setVolume(volumeLevel);
  lastVolumeLocalAt = performance.now();
  endPointerInteraction(event);
}

volume.addEventListener('pointerup', (event) => {
  if (!volumeDragging) return;
  event.preventDefault();
  finishVolume(event);
});
volume.addEventListener('pointercancel', (event) => {
  if (!volumeDragging) return;
  finishVolume(event);
});
volume.addEventListener('lostpointercapture', () => {
  if (volumeDragging) finishVolume(null);
});

volume.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    event.stopPropagation();
    const delta =
      Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!delta) return;
    const step = 0.02;
    const direction = delta < 0 ? 1 : -1;
    const target = clamp(volumeLevel + direction * step, 0, 1);
    let nextMuted = muted;
    if (muted && direction > 0) {
      nextMuted = false;
      window.glass.setMuted(false);
    }
    setVolume(target, nextMuted);
    window.glass.setVolume(target);
    lastVolumeLocalAt = performance.now();
    flashVolumeTip();
  },
  { passive: false }
);

volumeButton.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const nextMuted = !muted;
  muted = nextMuted;
  updateVolumeUi();
  window.glass.setMuted(nextMuted);
  lastVolumeLocalAt = performance.now();
  flashVolumeTip();
});

playButton.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (playButton.disabled) return;
  uiPlaying = !uiPlaying;
  optimisticPlaying = uiPlaying;
  optimisticStateUntil = performance.now() + 650;
  widget.classList.toggle('playing', uiPlaying);
  updateControlState();
  window.glass.toggle();
});

previousButton.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (previousButton.disabled) return;
  window.glass.previous();
});

nextButton.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (nextButton.disabled) return;
  window.glass.next();
});

stage.addEventListener(
  'pointerdown',
  () => {
    window.glass.focus();
  },
  true
);

stage.addEventListener('mouseenter', () => {
  window.glass.hover(true);
});

stage.addEventListener('mouseleave', () => {
  if (!pointerActive) window.glass.hover(false);
});

window.glass.onState(handleState);

window.glass.onVolume((payload) => {
  if (!payload || volumeDragging) return;
  if (typeof payload.volume === 'number') {
    setVolume(payload.volume, payload.muted);
    lastVolumeLocalAt = performance.now();
  }
});

window.glass.onSeek((payload) => {
  if (!payload || !payload.ok) return;
  const now = performance.now();
  if (typeof payload.position === 'number' && Number.isFinite(payload.position)) {
    basePosition = clamp(payload.position, 0, duration || Number.MAX_SAFE_INTEGER);
    baseTime = now;
    seekHoldUntil = now + 350;
    seekTarget = null;
    updateProgress();
    syncProgressLoop();
  }
});

window.glass.onLayout((layout) => {
  applyLayout(layout);
});

window.glass.onDragging((value) => {
  stage.classList.toggle('dragging', Boolean(value));
});

window.glass.onArt((payload) => {
  if (!payload) return;
  applyArt(payload.art || null, payload.artId);
});

window.glass.onVisibility((visible) => {
  clearTimeout(exitTimer);
  if (visible) {
    widgetVisible = true;
    stage.classList.remove('leaving');
    stage.classList.add('visible');
    syncProgressLoop();
    if (pendingTrackAnimation) {
      pendingTrackAnimation = false;
      requestAnimationFrame(() => {
        if (widgetVisible) playTrackAnimation();
      });
    }
    return;
  }

  widgetVisible = false;
  clearTimeout(progressTimer);
  progressTimer = null;
  stage.classList.add('leaving');
  stage.classList.remove('visible');
  exitTimer = setTimeout(() => {
    if (!stage.classList.contains('visible')) stage.classList.remove('leaving');
  }, 200);
  widget.classList.remove('seeking');
  seek.classList.remove('dragging');
  seekDragging = false;
  volumeDragging = false;
  volume.classList.remove('dragging');
  volumeRow.classList.remove('adjusting');
  seekTarget = null;
  pointerActive = false;
  stage.classList.remove('dragging');
  window.glass.interaction(false);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(progressTimer);
    progressTimer = null;
  } else {
    syncProgressLoop();
  }
});

setVolume(0.5, false);
updateMeta({ title: 'Ничего не играет', artist: 'Включите трек в любом плеере' });
updateControlState();
updateProgress();
window.glass.requestState();
