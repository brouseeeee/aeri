from __future__ import annotations

import ctypes
import sys
import threading
import time
from ctypes import wintypes


SW_HIDE = 0
POLL_INTERVAL_SECONDS = 0.05


def create_user32() -> ctypes.WinDLL:
    if sys.platform != "win32":
        raise RuntimeError("The Windows volume OSD is only available on Windows.")

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    user32.FindWindowW.restype = wintypes.HWND
    user32.FindWindowExW.argtypes = [
        wintypes.HWND,
        wintypes.HWND,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
    ]
    user32.FindWindowExW.restype = wintypes.HWND
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    return user32


def hide_osd(user32: ctypes.WinDLL) -> None:
    hwnd = user32.FindWindowW("NativeHWNDHost", None)
    while hwnd:
        has_direct_ui_child = user32.FindWindowExW(
            hwnd, None, "DirectUIHWND", None
        )
        if has_direct_ui_child and user32.IsWindowVisible(hwnd):
            user32.ShowWindow(hwnd, SW_HIDE)
        hwnd = user32.FindWindowExW(None, hwnd, "NativeHWNDHost", None)


class VolumeOsdHider:
    def __init__(self) -> None:
        self._user32 = create_user32()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def set_enabled(self, enabled: bool) -> None:
        if enabled:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run,
                name="volume-osd-hider",
                daemon=True,
            )
            self._thread.start()
            return

        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            hide_osd(self._user32)
            self._stop.wait(POLL_INTERVAL_SECONDS)


def main() -> None:
    hider = VolumeOsdHider()
    hider.set_enabled(True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        hider.set_enabled(False)


if __name__ == "__main__":
    main()
