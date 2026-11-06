from __future__ import annotations

import ctypes
import sys
import threading
import time
from collections.abc import Callable
from ctypes import wintypes


SW_HIDE = 0
EVENT_OBJECT_SHOW = 0x8002
HC_ACTION = 0
WH_KEYBOARD_LL = 13
VK_VOLUME_MUTE = 0xAD
VK_VOLUME_DOWN = 0xAE
VK_VOLUME_UP = 0xAF
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_SYSKEYDOWN = 0x0104
WM_SYSKEYUP = 0x0105
WINEVENT_OUTOFCONTEXT = 0
WINEVENT_SKIPOWNPROCESS = 0x0002
WM_QUIT = 0x0012
PM_NOREMOVE = 0
GA_ROOT = 2

class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wintypes.DWORD),
        ("scanCode", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]

WinEventProc = ctypes.WINFUNCTYPE(
    None,
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.HWND,
    wintypes.LONG,
    wintypes.LONG,
    wintypes.DWORD,
    wintypes.DWORD,
)
KeyboardProc = ctypes.WINFUNCTYPE(
    wintypes.LPARAM,
    ctypes.c_int,
    wintypes.WPARAM,
    wintypes.LPARAM,
)


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
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetAncestor.restype = wintypes.HWND
    user32.SetWinEventHook.argtypes = [
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        WinEventProc,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
    ]
    user32.SetWinEventHook.restype = wintypes.HANDLE
    user32.UnhookWinEvent.argtypes = [wintypes.HANDLE]
    user32.UnhookWinEvent.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = [
        ctypes.POINTER(wintypes.MSG),
        wintypes.HWND,
        wintypes.UINT,
        wintypes.UINT,
    ]
    user32.GetMessageW.restype = ctypes.c_int
    user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.TranslateMessage.restype = wintypes.BOOL
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.DispatchMessageW.restype = wintypes.LPARAM
    user32.PeekMessageW.argtypes = [
        ctypes.POINTER(wintypes.MSG),
        wintypes.HWND,
        wintypes.UINT,
        wintypes.UINT,
        wintypes.UINT,
    ]
    user32.PeekMessageW.restype = wintypes.BOOL
    user32.PostThreadMessageW.argtypes = [
        wintypes.DWORD,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    user32.PostThreadMessageW.restype = wintypes.BOOL
    user32.SetWindowsHookExW.argtypes = [
        ctypes.c_int,
        KeyboardProc,
        wintypes.HINSTANCE,
        wintypes.DWORD,
    ]
    user32.SetWindowsHookExW.restype = wintypes.HANDLE
    user32.UnhookWindowsHookEx.argtypes = [wintypes.HANDLE]
    user32.UnhookWindowsHookEx.restype = wintypes.BOOL
    user32.CallNextHookEx.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.WPARAM,
        wintypes.LPARAM,
    ]
    user32.CallNextHookEx.restype = wintypes.LPARAM
    return user32


def hide_osd_window(user32: ctypes.WinDLL, hwnd: int) -> None:
    root = user32.GetAncestor(hwnd, GA_ROOT)
    if not root:
        root = hwnd
    class_name = ctypes.create_unicode_buffer(64)
    if user32.GetClassNameW(root, class_name, len(class_name)) == 0:
        return
    if class_name.value != "NativeHWNDHost":
        return
    has_direct_ui_child = user32.FindWindowExW(root, None, "DirectUIHWND", None)
    if has_direct_ui_child and user32.IsWindowVisible(root):
        user32.ShowWindow(root, SW_HIDE)


def hide_osd(user32: ctypes.WinDLL) -> None:
    hwnd = user32.FindWindowW("NativeHWNDHost", None)
    while hwnd:
        hide_osd_window(user32, hwnd)
        hwnd = user32.FindWindowExW(None, hwnd, "NativeHWNDHost", None)


class VolumeOsdHider:
    def __init__(self, on_volume_key: Callable[[int], None] | None = None) -> None:
        self._user32 = create_user32()
        self._on_volume_key = on_volume_key
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._thread_id = 0
        self._hook = None
        self._keyboard_hook = None
        self._pressed_volume_keys: set[int] = set()
        self._error: Exception | None = None
        self._callback = WinEventProc(self._on_window_event)
        self._keyboard_callback = KeyboardProc(self._on_keyboard_event)

    def set_enabled(self, enabled: bool) -> None:
        if enabled:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._ready.clear()
            self._error = None
            self._thread = threading.Thread(
                target=self._run,
                name="volume-osd-hider",
                daemon=True,
            )
            self._thread.start()
            self._ready.wait()
            if self._error is not None:
                error = self._error
                self._thread.join()
                self._thread = None
                raise RuntimeError("Could not install the Windows volume OSD hook.") from error
            return

        self._stop.set()
        if self._thread is not None:
            if self._thread.is_alive() and self._thread_id:
                if not self._user32.PostThreadMessageW(
                    self._thread_id, WM_QUIT, 0, 0
                ):
                    raise ctypes.WinError(ctypes.get_last_error())
            self._thread.join()
            self._thread = None

    def _run(self) -> None:
        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
            kernel32.GetModuleHandleW.restype = wintypes.HMODULE
            kernel32.GetCurrentThreadId.restype = wintypes.DWORD
            self._thread_id = kernel32.GetCurrentThreadId()
            message = wintypes.MSG()
            self._user32.PeekMessageW(
                ctypes.byref(message), None, 0, 0, PM_NOREMOVE
            )
            self._hook = self._user32.SetWinEventHook(
                EVENT_OBJECT_SHOW,
                EVENT_OBJECT_SHOW,
                None,
                self._callback,
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            )
            if not self._hook:
                raise ctypes.WinError(ctypes.get_last_error())
            if self._on_volume_key is not None:
                self._keyboard_hook = self._user32.SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    self._keyboard_callback,
                    kernel32.GetModuleHandleW(None),
                    0,
                )
                if not self._keyboard_hook:
                    raise ctypes.WinError(ctypes.get_last_error())
            hide_osd(self._user32)
        except Exception as error:
            self._error = error
            if self._keyboard_hook:
                self._user32.UnhookWindowsHookEx(self._keyboard_hook)
                self._keyboard_hook = None
            if self._hook:
                self._user32.UnhookWinEvent(self._hook)
                self._hook = None
            self._ready.set()
            return

        self._ready.set()
        while not self._stop.is_set():
            result = self._user32.GetMessageW(ctypes.byref(message), None, 0, 0)
            if result == -1:
                self._error = ctypes.WinError(ctypes.get_last_error())
                break
            if result == 0:
                break
            self._user32.TranslateMessage(ctypes.byref(message))
            self._user32.DispatchMessageW(ctypes.byref(message))

        if self._hook:
            self._user32.UnhookWinEvent(self._hook)
            self._hook = None
        if self._keyboard_hook:
            self._user32.UnhookWindowsHookEx(self._keyboard_hook)
            self._keyboard_hook = None

    def _on_window_event(
        self,
        _hook: int,
        event: int,
        hwnd: int,
        _object_id: int,
        _child_id: int,
        _event_thread: int,
        _event_time: int,
    ) -> None:
        if event == EVENT_OBJECT_SHOW:
            hide_osd_window(self._user32, hwnd)

    def _on_keyboard_event(self, code: int, message: int, data: int) -> int:
        if code == HC_ACTION and message in (
            WM_KEYDOWN,
            WM_KEYUP,
            WM_SYSKEYDOWN,
            WM_SYSKEYUP,
        ):
            key = ctypes.cast(
                data, ctypes.POINTER(KBDLLHOOKSTRUCT)
            ).contents.vkCode
            if key in (VK_VOLUME_MUTE, VK_VOLUME_DOWN, VK_VOLUME_UP):
                is_key_up = message in (WM_KEYUP, WM_SYSKEYUP)
                if is_key_up:
                    self._pressed_volume_keys.discard(key)
                elif key != VK_VOLUME_MUTE or key not in self._pressed_volume_keys:
                    self._pressed_volume_keys.add(key)
                    if self._on_volume_key is not None:
                        self._on_volume_key(key)
                return 1
        return self._user32.CallNextHookEx(self._keyboard_hook, code, message, data)


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
