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
import json
import math
import queue
import sys
import threading
import time
import traceback
from datetime import timezone

# comtypes initialises COM on import.  MTA is required: with an STA, WinRT
# artwork streams never complete because there is no STA message pump here.
sys.coinit_flags = 0

from pycaw.pycaw import AudioUtilities
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
COMMAND_TICK = 0.025

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
        self.session = None
        self.session_source = ""
        self.art_key = ""
        self.art_uri = None
        self.art_fetched_at = 0.0
        self.art_failed_key = ""
        self.seq = 0
        self.last_seen_status = None
        self.stop = threading.Event()
        self.commands: queue.Queue[str] = queue.Queue()
        self.stdin_thread = threading.Thread(target=self._read_stdin, daemon=True)

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

    async def ensure_manager(self):
        now = time.monotonic()
        if self.manager is not None:
            return self.manager
        if now - self.manager_failed_at < 2.0:
            return None
        try:
            self.manager = await MediaManager.request_async()
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
        if key == self.art_failed_key and time.monotonic() - self.art_fetched_at < 12.0:
            return False, None

        uri = None
        try:
            thumb = getattr(props, "thumbnail", None)
            if thumb is not None:
                stream = await asyncio.wait_for(thumb.open_read_async(), timeout=2.5)
                size = int(stream.size)
                if 0 < size <= 8 * 1024 * 1024:
                    reader = DataReader(stream.get_input_stream_at(0))
                    await asyncio.wait_for(reader.load_async(size), timeout=2.5)
                    data = bytes(reader.read_buffer(size))
                    content_type = (getattr(stream, "content_type", "") or "").lower()
                    if not content_type.startswith("image/"):
                        if data.startswith(b"\x89PNG\r\n\x1a\n"):
                            content_type = "image/png"
                        elif data.startswith(b"\xff\xd8"):
                            content_type = "image/jpeg"
                        elif data.startswith(b"RIFF") and data[8:12] == b"WEBP":
                            content_type = "image/webp"
                        else:
                            content_type = "image/jpeg"
                    uri = "data:%s;base64,%s" % (
                        content_type,
                        base64.b64encode(data).decode("ascii"),
                    )
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

    async def poll(self) -> None:
        manager = await self.ensure_manager()
        level, muted = self.volume.get()
        if manager is None:
            emit(
                {
                    "type": "state",
                    "session": False,
                    "volume": round(level, 4),
                    "muted": muted,
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
            self.session = None
            self.art_key = ""
            emit(
                {
                    "type": "state",
                    "session": False,
                    "volume": round(level, 4),
                    "muted": muted,
                    "timestamp": time.time(),
                    "seq": self._next_seq(),
                }
            )
            return

        try:
            source = str(session.source_app_user_model_id or "")
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

        key = "\x1f".join((source, title, artist, album))
        art_changed, art = await self._load_art(props, key)

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
            "timestamp": time.time(),
            "seq": self._next_seq(),
        }
        if art_changed:
            payload["art"] = art
        self.session = session
        self.session_source = source
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
            emit({"type": "volume", "volume": round(level, 4), "muted": muted})
            return
        if kind == "setMuted":
            level, muted = self.volume.set_muted(bool(cmd.get("value")))
            emit({"type": "volume", "volume": round(level, 4), "muted": muted})
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
            if ok:
                # Refresh quickly so the UI receives the authoritative position.
                await asyncio.sleep(0.08)
                await self.poll()
        except Exception as exc:
            log(f"seek failed: {type(exc).__name__}: {exc}")
            emit({"type": "seek", "ok": False, "position": target})

    async def _toggle(self) -> None:
        try:
            if self.session is not None:
                await self.session.try_toggle_play_pause_async()
                await asyncio.sleep(0.1)
                await self.poll()
        except Exception as exc:
            log(f"toggle failed: {exc}")

    async def _skip(self, next_track: bool) -> None:
        try:
            if self.session is None:
                return
            if next_track:
                await self.session.try_skip_next_async()
            else:
                await self.session.try_skip_previous_async()
            await asyncio.sleep(0.2)
            await self.poll()
        except Exception as exc:
            log(f"skip failed: {exc}")

    async def run(self) -> None:
        self.stdin_thread.start()
        log("started")
        next_poll = 0.0
        while not self.stop.is_set():
            try:
                while True:
                    raw = self.commands.get_nowait()
                    await self.handle_command(raw)
            except queue.Empty:
                pass

            now = time.monotonic()
            if now >= next_poll:
                try:
                    await self.poll()
                except Exception as exc:
                    log(f"poll failed: {type(exc).__name__}: {exc}")
                next_poll = now + POLL_SECONDS
            await asyncio.sleep(COMMAND_TICK)
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
