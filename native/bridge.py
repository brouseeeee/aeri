"""Glass Player media bridge.

Runs as a long-lived child process of the Electron app. It polls the Windows
Global System Media Transport Controls (GSMTC) session and the default audio
endpoint, writes newline-delimited JSON to stdout, and accepts commands on
stdin.

Only standard Windows APIs are used: WinRT for media and Core Audio (through
pycaw) for the master volume.
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import hashlib
import json
import math
import os
import queue
import shutil
import sys
import threading
import time
import traceback
import winreg
from datetime import timezone

from hide_volume_osd import VolumeOsdHider

# comtypes initialises COM on import.  MTA is required: with an STA, WinRT
# artwork streams never complete because there is no STA message pump here.
sys.coinit_flags = 0

from pycaw.pycaw import AudioUtilities
from winrt.windows.applicationmodel.core import AppListEntry
from winrt.windows.foundation import Size
from winrt.windows.management.deployment import PackageManager
from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as MediaManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
)
from winrt.windows.storage.streams import DataReader

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", newline="\n")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", newline="\n")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")

POLL_SECONDS = 0.5
VOLUME_POLL_SECONDS = 0.1
COMMAND_TICK = 0.025
ARTWORK_RETRY_SECONDS = 0.5
YANDEX_MUSIC_AUMID_PREFIX = "a025c540.yandex.music_"
VK_VOLUME_MUTE = 0xAD
VK_VOLUME_DOWN = 0xAE
VK_VOLUME_UP = 0xAF

BROWSER_MARKERS = (
    "msedge",
    "chrome",
    "firefox",
    "brave",
    "opera",
    "vivaldi",
    "yandexbrowser",
    "browser",
)
MUSIC_MARKERS = (
    "yandex.desktop.music",
    "spotify",
    "apple",
    "itunes",
    "deezer",
    "tidal",
    "aimp",
    "foobar",
    "musicbee",
    "winamp",
    "zune",
    "amazon music",
    "soundcloud",
    "vk music",
)
APP_ICON_EXECUTABLES = (
    ("chrome", "chrome.exe"),
    ("msedge", "msedge.exe"),
    ("microsoftedge", "msedge.exe"),
    ("microsoft edge", "msedge.exe"),
    ("firefox", "firefox.exe"),
    ("brave", "brave.exe"),
    ("vivaldi", "vivaldi.exe"),
    ("opera", "opera.exe"),
    ("yandexbrowser", "browser.exe"),
    ("yandex browser", "browser.exe"),
    ("spotify", "spotify.exe"),
)


def log(message: str) -> None:
    print(f"[bridge] {message}", file=sys.stderr, flush=True)


def emit(payload: dict) -> None:
    try:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        raise SystemExit(0)


def safe_float(value, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        result = float(value)
        if not math.isfinite(result):
            return default
        return result
    except (TypeError, ValueError):
        return default


def image_content_type(data: bytes, reported_type: str = "") -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"BM"):
        return "image/bmp"
    if data.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"

    content_type = (reported_type or "").split(",", 1)[0].split(";", 1)[0].strip().lower()
    return content_type if content_type.startswith("image/") else "image/jpeg"


def parse_media_time(value: str) -> float | None:
    parts = (value or "").strip().split(":")
    if len(parts) not in (2, 3) or not all(part.isdigit() for part in parts):
        return None

    numbers = [int(part) for part in parts]
    if numbers[-1] >= 60 or (len(numbers) == 3 and numbers[1] >= 60):
        return None
    if len(numbers) == 2:
        return float(numbers[0] * 60 + numbers[1])
    return float(numbers[0] * 3600 + numbers[1] * 60 + numbers[2])


class YandexMusicTimelineReader:
    def __init__(self) -> None:
        self.window = None
        self.hwnd = 0
        self.slider = None
        self.position_text = None
        self.duration_text = None
        self.last_discovery_at = 0.0
        self.last_restore_at = 0.0

    def _ensure_visible(self, user32) -> bool:
        if not self.hwnd or not user32.IsWindow(self.hwnd):
            return False
        if not user32.IsIconic(self.hwnd):
            return True

        now = time.monotonic()
        if now - self.last_restore_at < 2.0:
            return False
        self.last_restore_at = now
        user32.ShowWindow(self.hwnd, 4)
        time.sleep(0.3)
        return not user32.IsIconic(self.hwnd)

    def _find_controls(self, auto) -> bool:
        window = auto.WindowControl(
            searchDepth=1,
            ClassName="ApplicationFrameWindow",
            SubName="Музык",
        )
        if not window.Exists(1, 0.2):
            return False

        import ctypes
        hwnd = int(window.NativeWindowHandle or 0)
        if not hwnd or not ctypes.windll.user32.IsWindow(hwnd):
            return False
        self.window = window
        self.hwnd = hwnd
        if not self._ensure_visible(ctypes.windll.user32):
            return False

        controls = [
            control
            for control, depth in auto.WalkControl(window, maxDepth=3)
            if depth == 2
        ]
        position_index = next(
            (
                index
                for index, control in enumerate(controls)
                if control.ControlTypeName == "TextControl"
                and control.AutomationId == "Time"
            ),
            None,
        )
        self.position_text = (
            controls[position_index] if position_index is not None else None
        )
        self.duration_text = None
        if position_index is not None:
            for control in controls[position_index + 1:]:
                if (
                    control.ControlTypeName == "TextControl"
                    and not control.AutomationId
                    and parse_media_time(control.Name) is not None
                ):
                    self.duration_text = control
                    break

        slider = window.SliderControl(searchDepth=15)
        self.slider = slider if slider.Exists(3, 0.3) else None
        self.window = window
        self.hwnd = hwnd
        return self.slider is not None or self.position_text is not None

    def read(self) -> tuple[float | None, float | None, float | None] | None:
        import ctypes
        import uiautomation as auto

        with auto.UIAutomationInitializerInThread():
            now = time.monotonic()
            if self.hwnd and not ctypes.windll.user32.IsWindow(self.hwnd):
                self.window = None
                self.hwnd = 0
                self.slider = None
                self.position_text = None
                self.duration_text = None

            if self.hwnd and not self._ensure_visible(ctypes.windll.user32):
                return None

            if self.window is None or (
                self.slider is None
                and self.position_text is None
                and now - self.last_discovery_at >= 2.0
            ):
                self.last_discovery_at = now
                if not self._find_controls(auto):
                    return None

            position = (
                parse_media_time(self.position_text.Name)
                if self.position_text is not None
                else None
            )
            duration = (
                parse_media_time(self.duration_text.Name)
                if self.duration_text is not None
                else None
            )
            progress_ratio = None
            if self.slider is not None:
                try:
                    value_pattern = self.slider.GetRangeValuePattern()
                    minimum = safe_float(value_pattern.Minimum, math.nan)
                    maximum = safe_float(value_pattern.Maximum, math.nan)
                    value = safe_float(value_pattern.Value, math.nan)
                    if (
                        all(math.isfinite(item) for item in (minimum, maximum, value))
                        and maximum > minimum
                    ):
                        progress_ratio = max(
                            0.0,
                            min(1.0, (value - minimum) / (maximum - minimum)),
                        )
                except Exception:
                    self.slider = None

            if progress_ratio is None and position is not None and duration:
                progress_ratio = max(0.0, min(1.0, position / duration))
            if position is None and duration is None and progress_ratio is None:
                return None
            return position, duration, progress_ratio


def is_browser(source: str) -> bool:
    lowered = (source or "").lower()
    return any(marker in lowered for marker in BROWSER_MARKERS)


def is_music_app(source: str) -> bool:
    lowered = (source or "").lower()
    return any(marker in lowered for marker in MUSIC_MARKERS)


class VolumeController:
    def __init__(self) -> None:
        self._endpoint = None
        self._device = None
        self._refresh()

    def _refresh(self) -> None:
        self._device = AudioUtilities.GetSpeakers()
        self._endpoint = self._device.EndpointVolume

    def _call(self, fn):
        try:
            return fn(self._endpoint)
        except Exception:
            self._refresh()
            return fn(self._endpoint)

    def get(self) -> tuple[float, bool]:
        level = safe_float(self._call(lambda ep: ep.GetMasterVolumeLevelScalar()), 0.0)
        muted = bool(self._call(lambda ep: ep.GetMute()))
        return max(0.0, min(1.0, level)), muted

    def set(self, level: float) -> tuple[float, bool]:
        clamped = max(0.0, min(1.0, safe_float(level, 0.0)))
        self._call(lambda ep: ep.SetMasterVolumeLevelScalar(clamped, None))
        return self.get()

    def set_muted(self, muted: bool) -> tuple[float, bool]:
        self._call(lambda ep: ep.SetMute(bool(muted), None))
        return self.get()

    def shutdown(self) -> None:
        pass


class Bridge:
    def __init__(self) -> None:
        self.volume = VolumeController()
        self.manager = None
        self.manager_failed_at = 0.0
        self.manager_event_tokens = []
        self.session = None
        self.session_source = ""
        self.session_event_source = None
        self.session_event_tokens = []
        self.loop = None
        self.refresh_requested = None
        self.art_key = ""
        self.art_uri = None
        self.art_hash = None
        self.art_track_key = ""
        self.art_fetched_at = 0.0
        self.art_failed_key = ""
        self.art_task = None
        self.art_task_key = ""
        self.art_emitted_key = ""
        self.current_track_key = ""
        self.app_icon_source = ""
        self.app_icon_uri = None
        self.app_icon_path = None
        self.app_icon_fetched_at = 0.0
        self.app_icon_failed_source = ""
        self.app_icon_task = None
        self.app_icon_task_source = ""
        self.yandex_progress_failed_at = 0.0
        self.yandex_timeline_reader = YandexMusicTimelineReader()
        self.yandex_ui_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="yandex-uia",
        )
        self.yandex_timeline_future = None
        self.yandex_timeline = None
        self.yandex_timeline_started_at = 0.0
        self.volume_failed_at = 0.0
        self.last_volume_state = None
        self.seq = 0
        self.last_seen_status = None
        self.stop = threading.Event()
        self.commands: queue.Queue[str] = queue.Queue()
        self.volume_key_events: queue.Queue[int] = queue.Queue()
        self.stdin_thread = threading.Thread(target=self._read_stdin, daemon=True)
        self.volume_osd_hider = VolumeOsdHider(self.volume_key_events.put)

    def _read_stdin(self) -> None:
        try:
            for line in sys.stdin:
                line = line.strip()
                if line:
                    self.commands.put(line)
        except Exception:
            pass
        finally:
            self.stop.set()

    def poll_volume(self) -> None:
        try:
            level, muted = self.volume.get()
        except Exception as exc:
            now = time.monotonic()
            if now - self.volume_failed_at >= 10.0:
                log(f"volume poll failed: {type(exc).__name__}: {exc}")
                self.volume_failed_at = now
            return

        state = (round(level, 4), muted)
        if state != self.last_volume_state:
            self.last_volume_state = state
            emit({"type": "volume", "volume": state[0], "muted": muted})

    def _signal_refresh(self) -> None:
        if self.loop is not None and self.loop.is_running() and self.refresh_requested is not None:
            self.loop.call_soon_threadsafe(self.refresh_requested.set)

    def _remove_event_tokens(self, tokens) -> None:
        for source, remove_name, token, _handler in tokens:
            try:
                getattr(source, remove_name)(token)
            except Exception as exc:
                log(f"SMTC event unsubscribe failed: {type(exc).__name__}: {exc}")
        tokens.clear()

    def _bind_manager_events(self, manager) -> None:
        if self.manager is manager and self.manager_event_tokens:
            return
        self._remove_event_tokens(self.manager_event_tokens)
        handler = lambda *_args: self._signal_refresh()
        for add_name, remove_name in (
            ("add_sessions_changed", "remove_sessions_changed"),
            ("add_current_session_changed", "remove_current_session_changed"),
        ):
            try:
                token = getattr(manager, add_name)(handler)
                self.manager_event_tokens.append((manager, remove_name, token, handler))
            except Exception as exc:
                log(f"SMTC event subscription failed ({add_name}): {type(exc).__name__}: {exc}")

    def _bind_session_events(self, session) -> None:
        if self.session_event_source is not None and session == self.session_event_source:
            return
        self._remove_event_tokens(self.session_event_tokens)
        self.session_event_source = session
        handler = lambda *_args: self._signal_refresh()
        for add_name, remove_name in (
            ("add_media_properties_changed", "remove_media_properties_changed"),
            ("add_playback_info_changed", "remove_playback_info_changed"),
            ("add_timeline_properties_changed", "remove_timeline_properties_changed"),
        ):
            try:
                token = getattr(session, add_name)(handler)
                self.session_event_tokens.append((session, remove_name, token, handler))
            except Exception as exc:
                log(f"SMTC event subscription failed ({add_name}): {type(exc).__name__}: {exc}")

    def _unbind_session_events(self) -> None:
        self._remove_event_tokens(self.session_event_tokens)
        self.session_event_source = None

    async def ensure_manager(self):
        now = time.monotonic()
        if self.manager is not None:
            return self.manager
        if now - self.manager_failed_at < 2.0:
            return None
        try:
            self.manager = await MediaManager.request_async()
            self._bind_manager_events(self.manager)
            return self.manager
        except Exception as exc:
            self.manager_failed_at = now
            log(f"media manager unavailable: {exc}")
            return None

    @staticmethod
    def _playback_status(session):
        try:
            return session.get_playback_info().playback_status
        except Exception:
            return None

    def _select_session(self, sessions):
        current = None
        try:
            current = self.manager.get_current_session() if self.manager else None
        except Exception:
            current = None

        # This is a music widget: a dedicated player should win over a browser
        # session, otherwise a paused song would be replaced by a background
        # YouTube tab.  Browsers are used only when no music app is available.
        music_sessions = [
            session
            for session in sessions
            if is_music_app(getattr(session, "source_app_user_model_id", ""))
        ]
        if music_sessions:
            playing_music = [
                session
                for session in music_sessions
                if self._playback_status(session) == PlaybackStatus.PLAYING
            ]
            if current in music_sessions:
                if self._playback_status(current) == PlaybackStatus.PLAYING:
                    return current
                if playing_music:
                    return playing_music[0]
                return current
            if playing_music:
                return playing_music[0]
            return music_sessions[0]

        if current is not None:
            if self._playback_status(current) == PlaybackStatus.PLAYING:
                return current

        playing = []
        for session in sessions:
            if self._playback_status(session) == PlaybackStatus.PLAYING:
                playing.append(session)
        if playing:
            return playing[0]

        if current is not None and not is_browser(getattr(current, "source_app_user_model_id", "")):
            return current

        if current is not None:
            return current
        return sessions[0] if sessions else None

    async def _load_art(self, props, key: str):
        """Return (changed, data_uri) for the current track's artwork."""
        if key == self.art_key and self.art_uri:
            return False, self.art_uri
        if (
            key == self.art_failed_key
            and time.monotonic() - self.art_fetched_at < ARTWORK_RETRY_SECONDS
        ):
            return False, None

        uri = None
        try:
            thumb = getattr(props, "thumbnail", None)
            if thumb is not None:
                stream = await asyncio.wait_for(thumb.open_read_async(), timeout=2.0)
                size = int(stream.size)
                if 0 < size <= 8 * 1024 * 1024:
                    reader = DataReader(stream.get_input_stream_at(0))
                    await asyncio.wait_for(reader.load_async(size), timeout=2.0)
                    data = bytes(reader.read_buffer(size))
                    image_hash = hashlib.sha256(data).digest()
                    same_as_previous_yandex_art = (
                        key.casefold().startswith(YANDEX_MUSIC_AUMID_PREFIX)
                        and self.art_track_key
                        and self.art_track_key.casefold().startswith(
                            YANDEX_MUSIC_AUMID_PREFIX
                        )
                        and self.art_track_key != key
                        and image_hash == self.art_hash
                    )
                    if not same_as_previous_yandex_art:
                        content_type = image_content_type(
                            data, getattr(stream, "content_type", "")
                        )
                        uri = "data:%s;base64,%s" % (
                            content_type,
                            base64.b64encode(data).decode("ascii"),
                        )
                        self.art_hash = image_hash
                        self.art_track_key = key
        except Exception as exc:
            log(f"artwork unavailable: {exc}")

        self.art_fetched_at = time.monotonic()
        if uri:
            self.art_key = key
            self.art_uri = uri
            self.art_failed_key = ""
        else:
            # Do not poison art_key: retry after the cooldown instead.
            self.art_key = ""
            self.art_uri = None
            self.art_failed_key = key
        return True, uri

    async def _finish_art_load(self, props, key: str) -> None:
        try:
            changed, art = await self._load_art(props, key)
            if changed and key == self.current_track_key:
                self.art_emitted_key = key
                emit({"type": "art", "artId": key, "art": art})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log(f"artwork task failed: {type(exc).__name__}: {exc}")
        finally:
            if self.art_task_key == key:
                self.art_task = None

    def _schedule_art(self, props, key: str) -> None:
        if key == self.art_key and self.art_uri:
            if self.art_emitted_key != key:
                self.art_emitted_key = key
                emit({"type": "art", "artId": key, "art": self.art_uri})
            return
        if (
            key == self.art_failed_key
            and time.monotonic() - self.art_fetched_at < ARTWORK_RETRY_SECONDS
        ):
            return
        if self.art_task is not None and not self.art_task.done():
            if self.art_task_key == key:
                return
            self.art_task.cancel()
        self.art_task_key = key
        self.art_task = asyncio.create_task(self._finish_art_load(props, key))

    async def _load_app_icon(self, source: str):
        """Return (changed, data_uri, executable_path) for the media source app."""
        now = time.monotonic()
        source_changed = source != self.app_icon_source
        if source_changed:
            self.app_icon_source = source
            self.app_icon_uri = None
            self.app_icon_path = None
            self.app_icon_fetched_at = 0.0
            self.app_icon_failed_source = ""
        elif self.app_icon_uri:
            return False, self.app_icon_uri, self.app_icon_path
        elif self.app_icon_path:
            return False, None, self.app_icon_path
        elif self.app_icon_failed_source == source and now - self.app_icon_fetched_at < 3.0:
            return False, None, None

        uri = None
        try:
            if "!" in source:
                package_family = source.split("!", 1)[0]
                packages = PackageManager().find_packages_by_user_security_id_package_family_name(
                    "", package_family
                )
                for package in packages:
                    entries: list[AppListEntry] = package.get_app_list_entries()
                    for entry in entries:
                        if entry.app_user_model_id != source:
                            continue
                        logo = entry.display_info.get_logo(Size(32.0, 32.0))
                        if logo is None:
                            break
                        stream = await asyncio.wait_for(logo.open_read_async(), timeout=1.0)
                        size = int(stream.size)
                        if 0 < size <= 8 * 1024 * 1024:
                            reader = DataReader(stream.get_input_stream_at(0))
                            await asyncio.wait_for(reader.load_async(size), timeout=1.0)
                            data = bytes(reader.read_buffer(size))
                            content_type = image_content_type(
                                data, getattr(stream, "content_type", "")
                            )
                            uri = "data:%s;base64,%s" % (
                                content_type,
                                base64.b64encode(data).decode("ascii"),
                            )
                        break
                    if uri:
                        break
        except Exception as exc:
            log(f"application icon unavailable for {source}: {exc}")

        icon_path = None if uri else self._find_app_icon_path(source)
        if not uri and not icon_path:
            log(f"no application icon found for {source}")
        self.app_icon_fetched_at = time.monotonic()
        self.app_icon_uri = uri
        self.app_icon_path = icon_path
        if not uri:
            self.app_icon_failed_source = source
        return True, uri, icon_path

    async def _finish_app_icon_load(self, source: str) -> None:
        try:
            changed, icon, icon_path = await self._load_app_icon(source)
            if changed and source == self.session_source:
                emit({
                    "type": "appIcon",
                    "appIconId": source,
                    "appIcon": icon,
                    "appIconPath": icon_path,
                })
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log(f"application icon task failed: {type(exc).__name__}: {exc}")
        finally:
            if self.app_icon_task_source == source:
                self.app_icon_task = None

    def _schedule_app_icon(self, source: str) -> None:
        now = time.monotonic()
        if source != self.app_icon_source:
            self.app_icon_source = source
            self.app_icon_uri = None
            self.app_icon_path = None
            self.app_icon_fetched_at = 0.0
            self.app_icon_failed_source = ""
        if self.app_icon_uri or self.app_icon_path:
            return
        if self.app_icon_failed_source == source and now - self.app_icon_fetched_at < 3.0:
            return
        if self.app_icon_task is not None and not self.app_icon_task.done():
            if self.app_icon_task_source == source:
                return
            self.app_icon_task.cancel()
        self.app_icon_task_source = source
        self.app_icon_task = asyncio.create_task(self._finish_app_icon_load(source))

    def _read_yandex_timeline(self, loop):
        now = time.monotonic()
        future = self.yandex_timeline_future
        if future is not None and future.done():
            try:
                self.yandex_timeline = future.result()
                self.yandex_progress_failed_at = 0.0
            except Exception as exc:
                if now - self.yandex_progress_failed_at >= 10.0:
                    log(f"Yandex Music timeline unavailable: {type(exc).__name__}: {exc}")
                    self.yandex_progress_failed_at = now
            self.yandex_timeline_future = None

        if (
            self.yandex_timeline_future is None
            and now - self.yandex_timeline_started_at >= 0.5
        ):
            self.yandex_timeline_started_at = now
            self.yandex_timeline_future = loop.run_in_executor(
                self.yandex_ui_executor,
                self.yandex_timeline_reader.read,
            )
            self.yandex_timeline_future.add_done_callback(
                lambda _future: self._signal_refresh()
            )
        return self.yandex_timeline

    @staticmethod
    def _find_app_icon_path(source: str):
        if source and os.path.isfile(source):
            return source

        lowered = (source or "").lower()
        executable = next(
            (name for marker, name in APP_ICON_EXECUTABLES if marker in lowered),
            None,
        )
        if not executable:
            return None

        registry_path = rf"Software\Microsoft\Windows\CurrentVersion\App Paths\{executable}"
        views = (0, winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY)
        for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for view in views:
                try:
                    with winreg.OpenKey(root, registry_path, 0, winreg.KEY_READ | view) as key:
                        candidate = os.path.expandvars(winreg.QueryValue(key, None))
                    if os.path.isfile(candidate):
                        return candidate
                except OSError:
                    continue
        if executable == "spotify.exe":
            locations = (
                os.path.join(os.environ.get("APPDATA", ""), "Spotify", executable),
                os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Spotify", executable),
                os.path.join(os.environ.get("PROGRAMFILES", ""), "Spotify", executable),
                os.path.join(os.environ.get("PROGRAMFILES(X86)", ""), "Spotify", executable),
            )
            for candidate in locations:
                if os.path.isfile(candidate):
                    return candidate
        return shutil.which(executable)

    def _clear_app_icon(self) -> bool:
        if not self.app_icon_source:
            return False
        self.app_icon_source = ""
        self.app_icon_uri = None
        self.app_icon_path = None
        self.app_icon_fetched_at = 0.0
        self.app_icon_failed_source = ""
        return True

    async def poll(self) -> None:
        manager = await self.ensure_manager()
        if manager is not None:
            self._bind_manager_events(manager)
        level, muted = self.volume.get()
        if manager is None:
            self._unbind_session_events()
            self.session = None
            self.current_track_key = ""
            self.art_emitted_key = ""
            self.art_key = ""
            self.art_uri = None
            if self.art_task is not None:
                self.art_task.cancel()
                self.art_task = None
            if self.app_icon_task is not None:
                self.app_icon_task.cancel()
                self.app_icon_task = None
            app_icon_cleared = self._clear_app_icon()
            emit(
                {
                    "type": "state",
                    "session": False,
                    "volume": round(level, 4),
                    "muted": muted,
                    **({"appIcon": None, "appIconId": ""} if app_icon_cleared else {}),
                    "timestamp": time.time(),
                    "seq": self._next_seq(),
                }
            )
            return

        try:
            sessions = list(manager.get_sessions())
        except Exception:
            sessions = []

        session = self._select_session(sessions)
        if session is None:
            self._unbind_session_events()
            self.session = None
            self.art_key = ""
            self.art_uri = None
            self.current_track_key = ""
            self.art_emitted_key = ""
            if self.art_task is not None:
                self.art_task.cancel()
                self.art_task = None
            if self.app_icon_task is not None:
                self.app_icon_task.cancel()
                self.app_icon_task = None
            app_icon_cleared = self._clear_app_icon()
            emit(
                {
                    "type": "state",
                    "session": False,
                    "volume": round(level, 4),
                    "muted": muted,
                    **({"appIcon": None, "appIconId": ""} if app_icon_cleared else {}),
                    "timestamp": time.time(),
                    "seq": self._next_seq(),
                }
            )
            return

        if self.session_event_source is not None and session != self.session_event_source:
            if self.art_task is not None:
                self.art_task.cancel()
                self.art_task = None
            if self.app_icon_task is not None:
                self.app_icon_task.cancel()
                self.app_icon_task = None
        self._bind_session_events(session)
        try:
            source = str(session.source_app_user_model_id or "")
            self.session = session
            self.session_source = source
            info = session.get_playback_info()
            props = await session.try_get_media_properties_async()
            title = str(props.title or "")
            artist = str(props.artist or "")
            album = str(props.album_title or "")
            status = info.playback_status.name.lower()
            controls = info.controls
            can_seek = bool(controls.is_playback_position_enabled)
            can_next = bool(getattr(controls, "is_next_enabled", True))
            can_previous = bool(getattr(controls, "is_previous_enabled", True))
            can_toggle = bool(
                getattr(controls, "is_play_enabled", True)
                or getattr(controls, "is_pause_enabled", True)
            )
            timeline = session.get_timeline_properties()
            position = safe_float(getattr(timeline.position, "total_seconds", lambda: 0)(), 0.0)
            duration = safe_float(getattr(timeline.end_time, "total_seconds", lambda: 0)(), 0.0)
            last_updated = getattr(timeline, "last_updated_time", None)
            last_updated_ts = None
            if last_updated is not None:
                try:
                    if last_updated.tzinfo is None:
                        last_updated = last_updated.replace(tzinfo=timezone.utc)
                    last_updated_ts = last_updated.timestamp()
                except Exception:
                    last_updated_ts = None
            if duration < 0:
                duration = 0.0
            position = max(0.0, min(position, duration if duration > 0 else position))
        except Exception as exc:
            log(f"session read failed: {type(exc).__name__}: {exc}")
            return

        yandex_position = None
        yandex_duration = None
        progress_ratio = None
        if (
            duration <= 0
            and source.casefold().startswith(YANDEX_MUSIC_AUMID_PREFIX)
        ):
            timeline = self._read_yandex_timeline(asyncio.get_running_loop())
            if timeline is not None:
                yandex_position, yandex_duration, progress_ratio = timeline
                if yandex_duration is not None:
                    duration = yandex_duration
                if yandex_position is not None:
                    position = yandex_position
                elif duration > 0 and progress_ratio is not None:
                    position = progress_ratio * duration
                if duration > 0:
                    position = min(position, duration)
                if yandex_position is not None or (
                    yandex_duration is not None and progress_ratio is not None
                ):
                    last_updated_ts = None

        key = "\x1f".join((source, title, artist, album))
        app_icon_source_changed = source != self.app_icon_source
        self.current_track_key = key
        self._schedule_art(props, key)
        self._schedule_app_icon(source)

        payload = {
            "type": "state",
            "session": True,
            "source": source,
            "title": title,
            "artist": artist,
            "album": album,
            "status": status,
            "position": round(position, 3),
            "duration": round(duration, 3),
            "lastUpdated": last_updated_ts,
            "canSeek": can_seek,
            "canNext": can_next,
            "canPrevious": can_previous,
            "canToggle": can_toggle,
            "volume": round(level, 4),
            "muted": muted,
            "artId": key,
            "appIconId": source,
            "timestamp": time.time(),
            "seq": self._next_seq(),
        }
        if progress_ratio is not None:
            payload["progressRatio"] = progress_ratio
        if app_icon_source_changed:
            payload["appIcon"] = None
        self.last_seen_status = status
        emit(payload)

    def _next_seq(self) -> int:
        self.seq += 1
        return self.seq

    async def handle_command(self, raw: str) -> None:
        try:
            cmd = json.loads(raw)
        except json.JSONDecodeError:
            log("bad command")
            return
        kind = cmd.get("cmd")
        if kind == "setVolume":
            level, muted = self.volume.set(safe_float(cmd.get("value"), 0.0))
            self.last_volume_state = (round(level, 4), muted)
            emit({"type": "volume", "volume": self.last_volume_state[0], "muted": muted})
            return
        if kind == "setMuted":
            level, muted = self.volume.set_muted(bool(cmd.get("value")))
            self.last_volume_state = (round(level, 4), muted)
            emit({"type": "volume", "volume": self.last_volume_state[0], "muted": muted})
            return
        if kind == "setVolumeOsdHidden":
            self.volume_osd_hider.set_enabled(bool(cmd.get("value")))
            return
        if kind == "seek":
            await self._seek(safe_float(cmd.get("value"), 0.0))
            return
        if kind == "toggle":
            await self._toggle()
            return
        if kind == "next":
            await self._skip(next_track=True)
            return
        if kind == "previous":
            await self._skip(next_track=False)
            return
        if kind == "refresh":
            return
        if kind == "shutdown":
            self.stop.set()

    def _handle_volume_key(self, key: int) -> None:
        try:
            level, muted = self.volume.get()
            if key == VK_VOLUME_MUTE:
                level, muted = self.volume.set_muted(not muted)
            elif key == VK_VOLUME_UP:
                if muted:
                    self.volume.set_muted(False)
                level, muted = self.volume.set(min(1.0, level + 0.02))
            elif key == VK_VOLUME_DOWN:
                level, muted = self.volume.set(max(0.0, level - 0.02))
            else:
                return

            self.last_volume_state = (round(level, 4), muted)
            emit({"type": "volume", "volume": self.last_volume_state[0], "muted": muted})
        except Exception as exc:
            log(f"volume key handling failed: {type(exc).__name__}: {exc}")

    async def _run_commands(self) -> None:
        while not self.stop.is_set():
            try:
                key = self.volume_key_events.get_nowait()
            except queue.Empty:
                try:
                    raw = self.commands.get_nowait()
                except queue.Empty:
                    await asyncio.sleep(COMMAND_TICK)
                    continue
            else:
                self._handle_volume_key(key)
                continue

            try:
                await self.handle_command(raw)
            except Exception as exc:
                log(f"command failed: {type(exc).__name__}: {exc}")

    async def _seek(self, target: float) -> None:
        session = self.session
        if session is None:
            emit({"type": "seek", "ok": False, "position": target})
            return
        try:
            info = session.get_playback_info()
            if not info.controls.is_playback_position_enabled:
                emit({"type": "seek", "ok": False, "position": target})
                return
            timeline = session.get_timeline_properties()
            duration = safe_float(getattr(timeline.end_time, "total_seconds", lambda: 0)(), 0.0)
            if duration > 0:
                target = max(0.0, min(target, duration))
            ticks = int(round(target * 10_000_000))
            ok = bool(await session.try_change_playback_position_async(ticks))
            emit({"type": "seek", "ok": ok, "position": target})
        except Exception as exc:
            log(f"seek failed: {type(exc).__name__}: {exc}")
            emit({"type": "seek", "ok": False, "position": target})

    async def _toggle(self) -> None:
        try:
            if self.session is not None:
                await self.session.try_toggle_play_pause_async()
                self._signal_refresh()
        except Exception as exc:
            log(f"toggle failed: {exc}")

    async def _skip(self, next_track: bool) -> None:
        try:
            if self.session is None:
                return
            controls = self.session.get_playback_info().controls
            if next_track:
                if controls.is_next_enabled:
                    await self.session.try_skip_next_async()
            else:
                if controls.is_previous_enabled:
                    await self.session.try_skip_previous_async()
            self._signal_refresh()
        except Exception as exc:
            log(f"skip failed: {exc}")

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.refresh_requested = asyncio.Event()
        self.stdin_thread.start()
        log("started")
        command_task = asyncio.create_task(self._run_commands())
        poll_task = None
        next_poll = 0.0
        next_volume_poll = 0.0
        while not self.stop.is_set():
            now = time.monotonic()
            if poll_task is not None and poll_task.done():
                try:
                    poll_task.result()
                except Exception as exc:
                    log(f"poll failed: {type(exc).__name__}: {exc}")
                poll_task = None

            if self.refresh_requested.is_set():
                self.refresh_requested.clear()
                next_poll = min(next_poll, now)

            if poll_task is None and now >= next_poll:
                poll_task = asyncio.create_task(self.poll())
                next_poll = now + POLL_SECONDS

            if now >= next_volume_poll:
                self.poll_volume()
                next_volume_poll = now + VOLUME_POLL_SECONDS

            await asyncio.sleep(COMMAND_TICK)

        self.stop.set()
        command_task.cancel()
        if poll_task is not None:
            poll_task.cancel()
        tasks = [command_task]
        if poll_task is not None:
            tasks.append(poll_task)
        await asyncio.gather(*tasks, return_exceptions=True)
        self.volume_osd_hider.set_enabled(False)
        self.volume.shutdown()


def main() -> None:
    try:
        bridge = Bridge()
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        pass
    except Exception:
        log(traceback.format_exc())
        raise


if __name__ == "__main__":
    main()
