"use strict";

const ICON_PLAY = "\uE102";
const ICON_PAUSE = "\uE103";

function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

function clampPosition(value) {
  const positionValue = Math.max(0, Number(value) || 0);
  return duration > 0 ? Math.min(positionValue, duration) : positionValue;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function formatTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "-:--";
  const seconds = Math.floor(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
    : `${minutes}:${remainder}`;
}

function setupSlider(root, vertical, onChange, onCommit, onInput = () => {}) {
  const filled = root.querySelector(".filled");
  const thumb = root.querySelector(".slider");
  let current = 0;
  let frame = null;
  let dragging = false;

  root.setAttribute("role", "slider");
  root.setAttribute("tabindex", "0");
  root.setAttribute("aria-valuemin", "0");
  root.setAttribute("aria-valuemax", "100");

  function apply(ratio) {
    current = clamp(ratio);
    const percent = `${current * 100}%`;
    if (vertical) {
      filled.style.height = percent;
      thumb.style.bottom = percent;
    } else {
      filled.style.width = percent;
      thumb.style.left = percent;
    }
    root.setAttribute("aria-valuenow", String(Math.round(current * 100)));
    onChange(current);
  }

  function cancelAnimation() {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    root.classList.remove("is-animating");
  }

  function animateTo(target, duration = 220) {
    if (dragging) return;
    cancelAnimation();
    const from = current;
    const to = clamp(target);
    const startedAt = performance.now();
    root.classList.add("is-animating");

    function step(now) {
      const progress = Math.min(1, (now - startedAt) / duration);
      apply(from + (to - from) * easeInOutCubic(progress));
      if (progress < 1) {
        frame = requestAnimationFrame(step);
      } else {
        frame = null;
        root.classList.remove("is-animating");
      }
    }

    frame = requestAnimationFrame(step);
  }

  function updateFromPointer(event) {
    const rect = root.getBoundingClientRect();
    const size = vertical ? rect.height : rect.width;
    if (size <= 0) return;
    const ratio = vertical
      ? (rect.bottom - event.clientY) / size
      : (event.clientX - rect.left) / size;
    apply(ratio);
    onInput(current);
  }

  function finish(event, commit) {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("is-dragging");
    if (root.hasPointerCapture(event.pointerId)) {
      root.releasePointerCapture(event.pointerId);
    }
    window.glass.interaction(false);
    if (commit) onCommit(current);
  }

  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (root === progressRoot && (!duration || !canSeek)) return;
    event.preventDefault();
    cancelAnimation();
    if (root === progressRoot) {
      window.clearTimeout(progressTimer);
      progressTimer = null;
    }
    dragging = true;
    root.classList.add("is-dragging");
    root.setPointerCapture(event.pointerId);
    window.glass.interaction(true);
    updateFromPointer(event);
  });

  root.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    event.preventDefault();
    updateFromPointer(event);
  });

  root.addEventListener("pointerup", (event) => finish(event, true));
  root.addEventListener("pointercancel", (event) => finish(event, true));
  root.addEventListener("lostpointercapture", () => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("is-dragging");
    window.glass.interaction(false);
    onCommit(current);
  });

  root.addEventListener("keydown", (event) => {
    if (root === progressRoot && (!duration || !canSeek)) return;
    const direction = vertical ? -1 : 1;
    let next;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = current + direction * 0.02;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = current - direction * 0.02;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = 1;
    } else {
      return;
    }
    event.preventDefault();
    window.glass.interaction(true);
    apply(next);
    onCommit(current);
    window.glass.interaction(false);
  });

  const initial = vertical
    ? filled.offsetHeight / Math.max(1, root.offsetHeight)
    : filled.offsetWidth / Math.max(1, root.offsetWidth);
  current = clamp(initial);
  apply(current);

  return {
    animateTo,
    setValue: (value) => {
      if (!dragging) apply(value);
    },
    getValue: () => current,
    isDragging: () => dragging,
  };
}

const currentTime = document.querySelector(".current-time");
const endTime = document.querySelector(".end-time");
const volumeCounter = document.querySelector(".volume-counter");
const progressRoot = document.querySelector(".progressbar");
const mixerRoot = document.querySelector(".mixer");
const playPauseButton = document.querySelector(".pause-play");
const playPauseIcon = document.querySelector(".icon-pause-play");
const previousButton = document.querySelector(".prev");
const nextButton = document.querySelector(".next");
const titleText = document.querySelector(".title-text");
const authorText = document.querySelector(".author-text");
const cover = document.querySelector(".cover");
const coverArtBlur = document.querySelector(".cover-art-blur");
const coverArt = document.querySelector(".cover-art");
const appIcon = document.querySelector(".app-icon");
const appIconFrame = document.querySelector(".app-icon-frame");
const coverPanel = document.querySelector(".composition-plane");
const rootWindow = document.querySelector(".windows-10-widget");

let duration = 0;
let position = 0;
let positionUpdatedAt = performance.now();
let playing = false;
let optimisticPlaying = null;
let optimisticPlayingUntil = 0;
let canSeek = false;
let canToggle = false;
let canNext = false;
let canPrevious = false;
let muted = false;
let trackKey = "";
let lastReportedPosition = null;
let externalProgressRatio = null;
let coverArtRequest = 0;
let appIconRequest = 0;
let progress = null;
let volume = null;
let progressTimer = null;
let volumeInputTimer = null;
let volumeChangeTimer = null;
let lastVolumeInputAt = 0;
let pendingVolumeInput = null;

function setPlaybackIcon(value) {
  playing = value;
  if (playPauseIcon) playPauseIcon.textContent = playing ? ICON_PAUSE : ICON_PLAY;
  if (playPauseButton) playPauseButton.setAttribute("aria-label", playing ? "Пауза" : "Воспроизвести");
}

function currentPosition() {
  if (!playing) return position;
  return Math.min(duration || Number.MAX_SAFE_INTEGER, position + (performance.now() - positionUpdatedAt) / 1000);
}

function updateCurrentTime(value) {
  const formatted = formatTime(value);
  setCurrentTimeText(formatted);
}

function setCurrentTimeText(formatted) {
  if (currentTime && currentTime.textContent !== formatted) {
    currentTime.textContent = formatted;
  }
}

function renderPosition(value, animate = false) {
  if (progress && progress.isDragging()) return;
  position = Math.max(0, Number(value) || 0);
  positionUpdatedAt = performance.now();
  updateCurrentTime(position);
  const ratio = duration > 0 ? clamp(position / duration) : 0;
  if (progress) {
    if (animate) progress.animateTo(ratio);
    else progress.setValue(ratio);
  }
}

function updateProgress() {
  if (!progress || !playing || !duration) return;
  if (progress.isDragging()) {
    progressTimer = null;
    return;
  }
  const nextPosition = currentPosition();
  progress.setValue(clamp(nextPosition / duration));
  updateCurrentTime(nextPosition);
  progressTimer = window.setTimeout(updateProgress, 250);
}

function startProgressLoop() {
  window.clearTimeout(progressTimer);
  progressTimer = null;
  if (!playing || !duration || progress.isDragging()) return;
  updateProgress();
}

function setVolume(value, animate = false) {
  if (volume && volume.isDragging()) return;
  const level = clamp(Number(value) || 0);
  if (volume) {
    const changed = Math.abs(volume.getValue() - level) > 0.005;
    if (animate && Math.abs(volume.getValue() - level) > 0.005) volume.animateTo(level, 180);
    else volume.setValue(level);
    if (changed) {
      mixerRoot.classList.add("volume-changed");
      window.clearTimeout(volumeChangeTimer);
      volumeChangeTimer = window.setTimeout(() => {
        mixerRoot.classList.remove("volume-changed");
        volumeChangeTimer = null;
      }, 900);
    }
  }
}

function sendVolumeDuringDrag(value) {
  pendingVolumeInput = value;
  const elapsed = performance.now() - lastVolumeInputAt;
  if (elapsed >= 35) {
    window.clearTimeout(volumeInputTimer);
    volumeInputTimer = null;
    pendingVolumeInput = null;
    lastVolumeInputAt = performance.now();
    window.glass.setVolume(value);
    return;
  }
  if (volumeInputTimer !== null) return;
  volumeInputTimer = window.setTimeout(() => {
    volumeInputTimer = null;
    if (pendingVolumeInput === null) return;
    const nextValue = pendingVolumeInput;
    pendingVolumeInput = null;
    lastVolumeInputAt = performance.now();
    window.glass.setVolume(nextValue);
  }, 35 - elapsed);
}

function flushVolumeInput(value) {
  window.clearTimeout(volumeInputTimer);
  volumeInputTimer = null;
  pendingVolumeInput = null;
  lastVolumeInputAt = performance.now();
  window.glass.setVolume(value);
}

function flashInteraction(element) {
  if (!element) return;
  element.classList.remove("interaction-pulse");
  void element.offsetWidth;
  element.classList.add("interaction-pulse");
  window.setTimeout(() => element.classList.remove("interaction-pulse"), 500);
}

function setCoverArt(art) {
  if (!cover || !coverArt) return;
  if (typeof art !== "string" || art.length === 0) {
    coverArtRequest += 1;
    cover.classList.remove("has-art");
    coverArt.removeAttribute("src");
    if (coverArtBlur) coverArtBlur.removeAttribute("src");
    delete coverArt.dataset.art;
    return;
  }
  if (coverArt.dataset.art === art) return;

  const request = ++coverArtRequest;
  cover.classList.remove("has-art");
  coverArt.dataset.art = art;
  coverArt.onload = () => {
    if (request === coverArtRequest) cover.classList.add("has-art");
  };
  coverArt.onerror = () => {
    if (request !== coverArtRequest) return;
    coverArt.removeAttribute("src");
    if (coverArtBlur) coverArtBlur.removeAttribute("src");
    delete coverArt.dataset.art;
    console.warn("Cover art could not be loaded; showing the default avatar.");
  };
  if (coverArtBlur) coverArtBlur.src = art;
  coverArt.src = art;
}

function setAppIcon(icon) {
  if (!appIcon || !appIconFrame) return;
  const request = ++appIconRequest;
  appIconFrame.classList.remove("has-icon");
  if (typeof icon !== "string" || icon.length === 0) {
    appIcon.removeAttribute("src");
    return;
  }
  appIcon.onload = () => {
    if (request === appIconRequest) appIconFrame.classList.add("has-icon");
  };
  appIcon.onerror = () => {
    if (request !== appIconRequest) return;
    appIcon.removeAttribute("src");
    console.warn("Application icon could not be loaded.");
  };
  appIcon.src = icon;
}

if (progressRoot) {
  progress = setupSlider(
    progressRoot,
    false,
    (ratio) => {
      const nextPosition = ratio * duration;
      if (duration > 0) {
        updateCurrentTime(nextPosition);
        if (progressRoot) progressRoot.setAttribute("aria-valuetext", formatTime(nextPosition));
      } else {
        setCurrentTimeText("--:--");
        if (progressRoot) {
          progressRoot.setAttribute("aria-valuetext", `${Math.round(ratio * 100)}%`);
        }
      }
    },
    (ratio) => {
      if (!canSeek || !duration) return;
      renderPosition(ratio * duration);
      window.glass.seek(position);
      flashInteraction(coverPanel);
      startProgressLoop();
    }
  );
  progressRoot.setAttribute("aria-disabled", "true");
  progressRoot.classList.add("disabled");
}

if (mixerRoot) {
  volume = setupSlider(
    mixerRoot,
    true,
    (ratio) => {
      if (volumeCounter) volumeCounter.textContent = String(Math.round(ratio * 100));
    },
    (ratio) => {
      flushVolumeInput(ratio);
      if (muted && ratio > 0) {
        muted = false;
        window.glass.setMuted(false);
      }
      flashInteraction(mixerRoot.closest(".volume-bar"));
    },
    (ratio) => {
      sendVolumeDuringDrag(ratio);
      if (muted && ratio > 0) {
        muted = false;
        window.glass.setMuted(false);
      }
    }
  );
}

function handleState(state) {
  if (!state) return;

  if (!state.session) {
    duration = 0;
    canSeek = false;
    canToggle = false;
    canNext = false;
    canPrevious = false;
    optimisticPlaying = null;
    optimisticPlayingUntil = 0;
    trackKey = "";
    lastReportedPosition = null;
    externalProgressRatio = null;
    renderPosition(0);
    setCurrentTimeText("-:--");
    setPlaybackIcon(false);
    setCoverArt(null);
    if (titleText) titleText.textContent = "Ничего не играет";
    if (authorText) authorText.textContent = "Включите трек в любом плеере";
    if (previousButton) previousButton.disabled = true;
    if (nextButton) nextButton.disabled = true;
    if (playPauseButton) playPauseButton.disabled = true;
    if (progressRoot) {
      progressRoot.setAttribute("aria-disabled", "true");
      progressRoot.classList.add("disabled");
    }
    if (endTime) endTime.textContent = "-:--";
    if (typeof state.volume === "number") setVolume(state.volume, true);
    return;
  }

  const nextTrackKey = [state.source, state.title, state.artist, state.album].join("\u001f");
  const changedTrack = trackKey && trackKey !== nextTrackKey;
  const trackChanged = !trackKey || trackKey !== nextTrackKey;
  if (changedTrack) flashInteraction(cover);
  trackKey = nextTrackKey;

  if (titleText) titleText.textContent = state.title || "Без названия";
  if (authorText) authorText.textContent = state.artist || "Неизвестный исполнитель";
  if (typeof state.art === "string" && state.art.length > 0) setCoverArt(state.art);
  else if (state.art === null || changedTrack) setCoverArt(null);

  duration = Number.isFinite(state.duration) ? Math.max(0, state.duration) : 0;
  canSeek = state.canSeek === true && duration > 0;
  externalProgressRatio = Number.isFinite(state.progressRatio)
    ? clamp(state.progressRatio)
    : null;
  canToggle = state.canToggle === true;
  canNext = state.canNext === true;
  canPrevious = state.canPrevious === true;
  if (endTime) endTime.textContent = duration ? formatTime(duration) : "-:--";
  if (previousButton) previousButton.disabled = !canPrevious;
  if (nextButton) nextButton.disabled = !canNext;
  if (playPauseButton) playPauseButton.disabled = !canToggle;
  if (progressRoot) {
    progressRoot.setAttribute("aria-disabled", String(!canSeek));
    progressRoot.classList.toggle("disabled", !canSeek);
  }

  const wasPlaying = playing;
  const positionBeforeState = currentPosition();
  const actualPlaying = state.status === "playing";
  if (performance.now() >= optimisticPlayingUntil || actualPlaying === optimisticPlaying) {
    setPlaybackIcon(actualPlaying);
    optimisticPlaying = null;
    optimisticPlayingUntil = 0;
  }
  if (!duration && externalProgressRatio !== null) {
    position = 0;
    positionUpdatedAt = performance.now();
    setCurrentTimeText("--:--");
    if (progress) progress.setValue(externalProgressRatio);
  } else if (!duration && progress) {
    progress.setValue(0);
  }
  const reportedPosition = clampPosition(state.position);
  const reportChanged =
    lastReportedPosition === null || Math.abs(reportedPosition - lastReportedPosition) > 0.05;

  if (duration > 0 && (trackChanged || lastReportedPosition === null)) {
    let anchor = reportedPosition;
    if (playing && Number.isFinite(state.lastUpdated)) {
      const age = Date.now() / 1000 - state.lastUpdated;
      if (age > 0 && age < 6 * 3600) {
        anchor += age;
        if (duration > 0) anchor = Math.min(anchor, duration);
      }
    }
    renderPosition(anchor, true);
  } else if (duration > 0 && !playing) {
    if (wasPlaying) {
      renderPosition(positionBeforeState);
    } else if (reportChanged && Math.abs(reportedPosition - position) > 0.75) {
      renderPosition(reportedPosition, true);
    }
  } else if (duration > 0 && !wasPlaying) {
    renderPosition(reportedPosition > positionBeforeState + 0.75
      ? reportedPosition
      : positionBeforeState);
  } else if (duration > 0) {
    const localPosition = currentPosition();
    if (reportedPosition > localPosition + 0.75) {
      renderPosition(reportedPosition, true);
    } else if (reportChanged && reportedPosition < localPosition - 8) {
      renderPosition(reportedPosition, true);
    }
  }
  lastReportedPosition = reportedPosition;
  if (typeof state.volume === "number") setVolume(state.volume, true);
  muted = Boolean(state.muted);
  startProgressLoop();
}

if (playPauseButton) {
  playPauseButton.addEventListener("click", () => {
    if (playPauseButton.disabled) return;
    optimisticPlaying = !playing;
    optimisticPlayingUntil = performance.now() + 1500;
    setPlaybackIcon(optimisticPlaying);
    window.glass.toggle();
    flashInteraction(playPauseButton);
  });
}

if (previousButton) {
  previousButton.addEventListener("click", () => {
    if (previousButton.disabled) return;
    window.glass.previous();
    flashInteraction(coverPanel);
  });
}

if (nextButton) {
  nextButton.addEventListener("click", () => {
    if (nextButton.disabled) return;
    window.glass.next();
    flashInteraction(coverPanel);
  });
}

if (rootWindow) {
  let dragPointerId = null;

  rootWindow.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".progressbar, .mixer, button")) return;
    window.glass.focus();
    if (event.button !== 0) return;
    event.preventDefault();
    dragPointerId = event.pointerId;
    rootWindow.setPointerCapture(event.pointerId);
    window.glass.startWindowDrag(event.screenX, event.screenY);
  });

  rootWindow.addEventListener("pointermove", (event) => {
    if (event.pointerId === dragPointerId) {
      window.glass.moveWindowDrag(event.screenX, event.screenY);
    }
  });

  const finishWindowDrag = (event) => {
    if (event.pointerId !== dragPointerId) return;
    dragPointerId = null;
    if (rootWindow.hasPointerCapture(event.pointerId)) {
      rootWindow.releasePointerCapture(event.pointerId);
    }
    window.glass.endWindowDrag();
  };

  rootWindow.addEventListener("pointerup", finishWindowDrag);
  rootWindow.addEventListener("pointercancel", finishWindowDrag);
  rootWindow.addEventListener("lostpointercapture", finishWindowDrag);
}

window.glass.onState(handleState);
window.glass.onVolume((payload) => {
  if (!payload) return;
  if (typeof payload.volume === "number") setVolume(payload.volume, true);
  muted = Boolean(payload.muted);
});
window.glass.onSeek((payload) => {
  if (payload && payload.ok && Number.isFinite(payload.position)) {
    renderPosition(payload.position, true);
  }
});
window.glass.onArt((payload) => {
  setCoverArt(payload && payload.art);
});
window.glass.onAppIcon((payload) => {
  setAppIcon(payload && payload.appIcon);
});
window.glass.onVisibility((visible) => {
  if (rootWindow) rootWindow.classList.toggle("is-visible", Boolean(visible));
});
window.glass.onDragging((dragging) => {
  if (rootWindow) rootWindow.classList.toggle("is-window-dragging", Boolean(dragging));
});

document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) window.glass.interaction(true);
});
window.addEventListener("pointerup", () => window.glass.interaction(false));
window.addEventListener("pointercancel", () => window.glass.interaction(false));

window.glass.requestState();
