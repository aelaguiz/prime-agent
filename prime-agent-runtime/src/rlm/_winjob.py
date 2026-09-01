"""Windows Job Object containment for bash() children and the persistent REPL.

Each owner creates a kill-on-close Job before a suspended target is atomically
assigned through PROC_THREAD_ATTRIBUTE_JOB_LIST. Breakaway is never enabled, so
the target and descendants die when the Job is terminated or its last handle
closes. The standalone helper uses only stdlib ctypes. Non-Windows tests mock
the kernel32 boundary; native behavior remains a Windows CI responsibility.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import json
import ntpath
import os
import re
import subprocess
import sys
import threading
import time
from typing import BinaryIO, TextIO

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JobObjectBasicAccountingInformation, _JobObjectExtendedLimitInformation = 1, 9
_INT64, _SIZE_T, _DWORD = ctypes.c_int64, ctypes.c_size_t, wintypes.DWORD
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_RESUME_FAILED = 0xFFFFFFFF  # (DWORD)-1 from ResumeThread
_PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2000D  # value 13 | PROC_THREAD_ATTRIBUTE_INPUT
_PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002  # value 2 | PROC_THREAD_ATTRIBUTE_INPUT
_EXTENDED_STARTUPINFO_PRESENT = 0x00080000
_CREATE_SUSPENDED = 0x4
_CREATE_UNICODE_ENVIRONMENT = 0x400
_STARTF_USESTDHANDLES = 0x100
_HANDLE_FLAG_INHERIT = 0x1
_GENERIC_READ = 0x80000000
_FILE_SHARE_READ_WRITE = 0x3
_OPEN_EXISTING = 3
_WAIT_OBJECT_0 = 0
_WAIT_TIMEOUT = 0x102
_INFINITE = 0xFFFFFFFF
_PROTOCOL_VERSION = 1
_PERSISTENT_REPL_PROTOCOL_VERSION = 1
_PERSISTENT_REPL_CONTROL_INPUT_FD = 3
_PERSISTENT_REPL_CONTROL_OUTPUT_FD = 4
_PERSISTENT_REPL_REQUERY_SECONDS = 0.25
_PROTOCOL_NONCE = re.compile(r"^[a-f0-9]{64}$")
_ADMISSION_GENERATION = re.compile(
    r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"
)
_OWNER_TOKEN_PREFIX = "prime-agent-owner-token="
_OWNER_TOKEN = re.compile(rf"^{re.escape(_OWNER_TOKEN_PREFIX)}[a-f0-9]{{64}}$")
_DOTNET_FILETIME_OFFSET = 504911232000000000
_SYNCHRONIZE = 0x00100000
_STD_INPUT_HANDLE = 0xFFFFFFF6  # (DWORD)-10
_STD_OUTPUT_HANDLE = 0xFFFFFFF5  # (DWORD)-11
_STD_ERROR_HANDLE = 0xFFFFFFF4  # (DWORD)-12


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", _INT64), ("PerJobUserTimeLimit", _INT64),
        ("LimitFlags", _DWORD), ("MinimumWorkingSetSize", _SIZE_T),
        ("MaximumWorkingSetSize", _SIZE_T), ("ActiveProcessLimit", _DWORD),
        ("Affinity", _SIZE_T), ("PriorityClass", _DWORD), ("SchedulingClass", _DWORD)]


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS), ("ProcessMemoryLimit", _SIZE_T),
        ("JobMemoryLimit", _SIZE_T), ("PeakProcessMemoryUsed", _SIZE_T),
        ("PeakJobMemoryUsed", _SIZE_T)]


class _JOBOBJECT_BASIC_ACCOUNTING_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", _INT64), ("TotalKernelTime", _INT64),
        ("ThisPeriodTotalUserTime", _INT64), ("ThisPeriodTotalKernelTime", _INT64),
        ("TotalPageFaultCount", _DWORD), ("TotalProcesses", _DWORD),
        ("ActiveProcesses", _DWORD), ("TotalTerminatedProcesses", _DWORD)]


# Fixed-width Win64 ABI types on every host: wintypes.DWORD is 8-byte c_ulong on LP64 POSIX.
_DWORD32, _WORD16, _PTR, _WSTR = ctypes.c_uint32, ctypes.c_uint16, ctypes.c_void_p, ctypes.c_wchar_p


class _STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", _DWORD32), ("lpReserved", _WSTR), ("lpDesktop", _WSTR),
        ("lpTitle", _WSTR), ("dwX", _DWORD32), ("dwY", _DWORD32),
        ("dwXSize", _DWORD32), ("dwYSize", _DWORD32), ("dwXCountChars", _DWORD32),
        ("dwYCountChars", _DWORD32), ("dwFillAttribute", _DWORD32), ("dwFlags", _DWORD32),
        ("wShowWindow", _WORD16), ("cbReserved2", _WORD16),
        ("lpReserved2", _PTR), ("hStdInput", _PTR),
        ("hStdOutput", _PTR), ("hStdError", _PTR)]


class _STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", _STARTUPINFOW), ("lpAttributeList", _PTR)]


class _PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", _PTR), ("hThread", _PTR),
        ("dwProcessId", _DWORD32), ("dwThreadId", _DWORD32)]


class _FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", _DWORD32), ("dwHighDateTime", _DWORD32)]


_kernel32_cache: ctypes.WinDLL | None = None  # type: ignore[name-defined]


def _kernel32():
    global _kernel32_cache
    if _kernel32_cache is None:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # HANDLE argtypes/restype are mandatory: c_int truncates 64-bit handles.
        h, b, i, p = wintypes.HANDLE, wintypes.BOOL, ctypes.c_int, wintypes.LPVOID
        w = wintypes.LPCWSTR
        for name, argtypes, restype in (
            ("CreateJobObjectW", [p, w], h),
            ("SetInformationJobObject", [h, i, p, _DWORD], b),
            ("QueryInformationJobObject", [h, i, p, _DWORD, p], b),
            ("TerminateJobObject", [h, wintypes.UINT], b),
            ("CloseHandle", [h], b),
            ("CreatePipe", [p, p, p, _DWORD], b),
            ("SetHandleInformation", [h, _DWORD, _DWORD], b),
            ("CreateFileW", [w, _DWORD, _DWORD, p, _DWORD, _DWORD, h], h),
            ("InitializeProcThreadAttributeList", [p, _DWORD, _DWORD, p], b),
            ("UpdateProcThreadAttribute", [p, _DWORD, _SIZE_T, p, _SIZE_T, p, p], b),
            ("DeleteProcThreadAttributeList", [p], None),
            ("CreateProcessW", [w, wintypes.LPWSTR, p, p, b, _DWORD, p, w, p, p], b),
            ("ResumeThread", [h], _DWORD),  # (DWORD)-1 on failure
            ("WaitForSingleObject", [h, _DWORD], _DWORD),
            ("GetExitCodeProcess", [h, p], b),
            ("TerminateProcess", [h, wintypes.UINT], b),
            ("OpenProcess", [_DWORD, b, _DWORD], h),
            ("GetProcessTimes", [h, p, p, p, p], b),
            ("GetStdHandle", [_DWORD32], h),
            ("GetWindowsDirectoryW", [wintypes.LPWSTR, wintypes.UINT], wintypes.UINT),
        ):
            fn = getattr(k32, name)
            fn.argtypes, fn.restype = argtypes, restype
        _kernel32_cache = k32
    return _kernel32_cache


def _last_error() -> int:
    return ctypes.get_last_error() if hasattr(ctypes, "get_last_error") else 0


def _open_reader(handle: int) -> BinaryIO:
    """Wrap the pipe HANDLE in a binary reader, consuming the HANDLE on every path."""
    # Windows-only module, so the import cannot live at the top on POSIX.
    import msvcrt

    try:
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY)
    except BaseException:
        _kernel32().CloseHandle(handle)
        raise
    try:
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)  # the CRT fd owns the handle now; closing it closes both
        raise


def create_job() -> int | None:
    """A new kill-on-close job handle, or None when jobs are unavailable."""
    try:
        k32 = _kernel32()
        if not (job := k32.CreateJobObjectW(None, None)):
            return None
        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(
            job, _JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)):
            k32.CloseHandle(job)
            return None
        return job
    except (OSError, AttributeError):
        return None


class JobProcess:
    """Minimal Popen-like surface for a child spawn_in_job() created suspended."""

    def __init__(self, hprocess: int, hthread: int, pid: int, stdout: BinaryIO | None) -> None:
        self.pid = pid
        self.stdout: BinaryIO | None = stdout
        # Guards every (_exit_code, _hprocess, _hthread, _waiters) transition; never held blocking.
        self._lock = threading.Lock()
        self._hprocess: int | None = hprocess
        self._hthread: int | None = hthread
        self._exit_code: int | None = None
        self._waiters = 0  # wait() calls with a blocking WFSO in flight
        self._close_requested = False

    def resume(self) -> bool:
        """Release the suspended primary thread; the handle stays open on failure."""
        with self._lock:
            if self._hthread is None or _kernel32().ResumeThread(self._hthread) == _RESUME_FAILED:
                return False
            _kernel32().CloseHandle(self._hthread)
            self._hthread = None
            return True

    def close(self) -> None:
        """Release the process handle (idempotent); owned by BashHandle after reap."""
        with self._lock:
            self._close_requested = True
            self._close_hprocess_locked()

    def _cache_exit_code_locked(self) -> int:
        # Runs under the lock after a signaled wait, so never the STILL_ACTIVE(259) sentinel.
        k32 = _kernel32()
        code = _DWORD()
        if not k32.GetExitCodeProcess(self._hprocess, ctypes.byref(code)):
            # Handles stay open (nothing cached) so a retry is possible.
            raise OSError(f"GetExitCodeProcess failed: {_last_error()}")
        self._exit_code = int(code.value)
        if self._hthread is not None:
            k32.CloseHandle(self._hthread)
            self._hthread = None
        return self._exit_code

    def _close_hprocess_locked(self) -> None:
        # Closing a handle mid-WaitForSingleObject is UB: the last returning waiter closes it.
        if self._close_requested and self._waiters == 0 and self._hprocess is not None:
            _kernel32().CloseHandle(self._hprocess)
            self._hprocess = None

    def poll(self) -> int | None:
        # WaitForSingleObject(0) never blocks, so it may run under the lock.
        with self._lock:
            if self._exit_code is not None:
                return self._exit_code
            if self._hprocess is None:
                raise OSError("process handle closed")
            result = _kernel32().WaitForSingleObject(self._hprocess, 0)
            if result == _WAIT_TIMEOUT:
                return None
            if result != _WAIT_OBJECT_0:
                raise OSError(f"WaitForSingleObject failed: {_last_error()}")
            return self._cache_exit_code_locked()

    def wait(self, timeout: float | None = None) -> int:
        # Convert before registering: int(nan/inf) raises and would leak _waiters forever.
        millis = _INFINITE if timeout is None else max(0, int(timeout * 1000))
        with self._lock:
            if self._exit_code is not None:
                return self._exit_code
            if self._hprocess is None:
                raise OSError("process handle closed")
            hprocess = self._hprocess
            self._waiters += 1  # keeps the handle open while the wait runs
        result = None
        try:
            result = _kernel32().WaitForSingleObject(hprocess, millis)
        finally:
            with self._lock:
                try:
                    # Cache while the handle is still valid: the deferred close
                    # fires the moment _waiters drops to zero.
                    if result == _WAIT_OBJECT_0 and self._exit_code is None:
                        self._cache_exit_code_locked()
                finally:
                    self._waiters -= 1
                    self._close_hprocess_locked()  # last waiter after a close() request closes
        with self._lock:
            # A code cached concurrently during the wait wins, even over WAIT_FAILED.
            if self._exit_code is not None:
                return self._exit_code
            if result == _WAIT_TIMEOUT:
                raise subprocess.TimeoutExpired(f"pid {self.pid}", timeout or 0)
            raise OSError(f"WaitForSingleObject failed: {_last_error()}")

    def kill(self) -> None:
        with self._lock:
            if self._exit_code is not None or self._hprocess is None:
                return
            ok = bool(_kernel32().TerminateProcess(self._hprocess, 1))
        if not ok and self.poll() is None:
            raise OSError(f"TerminateProcess failed: {_last_error()}")


def spawn_in_job(job: int, argv: list[str], cwd: str, env: dict[str, str]) -> JobProcess:
    """Create argv suspended and atomically inside the caller-owned job (JOB_LIST
    attribute, no assignment window); raises OSError on any failure (nothing spawned)."""
    try:
        k32 = _kernel32()
    except (OSError, AttributeError) as exc:
        raise OSError("kernel32 unavailable") from exc
    read_handle = write_handle = nul_handle = None
    attr_list = None
    proc = None
    try:
        read_out, write_out = wintypes.HANDLE(), wintypes.HANDLE()
        if not k32.CreatePipe(ctypes.byref(read_out), ctypes.byref(write_out), None, 0):
            raise OSError(f"CreatePipe failed: {_last_error()}")
        read_handle, write_handle = int(read_out.value or 0), int(write_out.value or 0)
        if not k32.SetHandleInformation(write_handle, _HANDLE_FLAG_INHERIT, _HANDLE_FLAG_INHERIT):
            raise OSError(f"SetHandleInformation failed: {_last_error()}")
        nul = k32.CreateFileW(
            "NUL", _GENERIC_READ, _FILE_SHARE_READ_WRITE, None, _OPEN_EXISTING, 0, None)
        if not nul or nul == _INVALID_HANDLE_VALUE:
            raise OSError(f"CreateFileW(NUL) failed: {_last_error()}")
        nul_handle = int(nul)
        if not k32.SetHandleInformation(nul_handle, _HANDLE_FLAG_INHERIT, _HANDLE_FLAG_INHERIT):
            raise OSError(f"SetHandleInformation failed: {_last_error()}")
        # Two-call protocol: the sizing call fails with ERROR_INSUFFICIENT_BUFFER.
        size = ctypes.c_size_t(0)
        k32.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
        if not size.value:
            raise OSError(f"InitializeProcThreadAttributeList sizing failed: {_last_error()}")
        buffer = ctypes.create_string_buffer(size.value)
        if not k32.InitializeProcThreadAttributeList(buffer, 2, 0, ctypes.byref(size)):
            raise OSError(f"InitializeProcThreadAttributeList failed: {_last_error()}")
        attr_list = buffer
        jobs = (wintypes.HANDLE * 1)(job)
        if not k32.UpdateProcThreadAttribute(
            attr_list, 0, _PROC_THREAD_ATTRIBUTE_JOB_LIST, ctypes.byref(jobs),
            ctypes.sizeof(jobs), None, None):
            raise OSError(f"UpdateProcThreadAttribute failed: {_last_error()}")
        # HANDLE_LIST blocks concurrent spawns' handle leaks; both arrays outlive CreateProcessW.
        inheritable = (wintypes.HANDLE * 2)(write_handle, nul_handle)
        if not k32.UpdateProcThreadAttribute(
            attr_list, 0, _PROC_THREAD_ATTRIBUTE_HANDLE_LIST, ctypes.byref(inheritable),
            ctypes.sizeof(inheritable), None, None):
            raise OSError(f"UpdateProcThreadAttribute failed: {_last_error()}")
        startup = _STARTUPINFOEXW()
        startup.StartupInfo.cb = ctypes.sizeof(_STARTUPINFOEXW)
        startup.StartupInfo.dwFlags = _STARTF_USESTDHANDLES
        startup.StartupInfo.hStdInput = nul_handle
        startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = write_handle
        startup.lpAttributeList = ctypes.cast(attr_list, wintypes.LPVOID)
        # CreateProcessW may rewrite lpCommandLine in place: a writable buffer is mandatory.
        cmdline = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
        # Sorted case-insensitively per CreateProcessW; the implicit terminator is the second NUL.
        env_block = ctypes.create_unicode_buffer(
            "\0".join(
                f"{key}={value}" for key, value in sorted(env.items(), key=lambda kv: kv[0].upper())
            ) + "\0")
        info = _PROCESS_INFORMATION()
        flags = _EXTENDED_STARTUPINFO_PRESENT | _CREATE_SUSPENDED | _CREATE_UNICODE_ENVIRONMENT
        if not k32.CreateProcessW(
            None, cmdline, None, None, True, flags, env_block, cwd,
            ctypes.byref(startup), ctypes.byref(info)):
            raise OSError(f"CreateProcessW failed: {_last_error()}")
        try:
            # _open_reader consumes the read handle on every path: drop it at the call.
            reader_handle, read_handle = read_handle, None
            proc = JobProcess(
                int(info.hProcess or 0), int(info.hThread or 0), int(info.dwProcessId),
                _open_reader(reader_handle))
        except BaseException:
            # No JobProcess owns these yet; the caller's kill-on-close job reaps the child.
            for handle in (info.hProcess, info.hThread):
                if handle:
                    k32.CloseHandle(handle)
            raise
    finally:
        if attr_list is not None:
            k32.DeleteProcThreadAttributeList(attr_list)
        for handle in (write_handle, nul_handle):
            if handle is not None:
                k32.CloseHandle(handle)
        if read_handle is not None:  # only when _open_reader was never invoked
            k32.CloseHandle(read_handle)
    return proc


def spawn_persistent_repl_in_job(
    job: int, argv: list[str], cwd: str, env: dict[str, str]
) -> JobProcess:
    """Create a persistent REPL target suspended and atomically inside *job*.

    Unlike :func:`spawn_in_job`, the target receives the helper's three standard
    handles directly. The helper's inherited fd3/fd4 control handles are never
    present in the explicit HANDLE_LIST, so target stdout/stderr cannot forge authority.
    The returned process remains suspended until ``resume()`` succeeds.
    """
    try:
        k32 = _kernel32()
    except (OSError, AttributeError) as exc:
        raise OSError("kernel32 unavailable") from exc
    attr_list = None
    proc = None
    try:
        std_handles: list[int] = []
        for std_id in (_STD_INPUT_HANDLE, _STD_OUTPUT_HANDLE, _STD_ERROR_HANDLE):
            handle = k32.GetStdHandle(std_id)
            if not handle or handle == _INVALID_HANDLE_VALUE:
                raise OSError(f"GetStdHandle failed: {_last_error()}")
            value = int(handle)
            if not k32.SetHandleInformation(
                value, _HANDLE_FLAG_INHERIT, _HANDLE_FLAG_INHERIT
            ):
                raise OSError(f"SetHandleInformation failed: {_last_error()}")
            std_handles.append(value)

        size = ctypes.c_size_t(0)
        k32.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
        if not size.value:
            raise OSError(
                f"InitializeProcThreadAttributeList sizing failed: {_last_error()}"
            )
        buffer = ctypes.create_string_buffer(size.value)
        if not k32.InitializeProcThreadAttributeList(buffer, 2, 0, ctypes.byref(size)):
            raise OSError(f"InitializeProcThreadAttributeList failed: {_last_error()}")
        attr_list = buffer
        jobs = (wintypes.HANDLE * 1)(job)
        if not k32.UpdateProcThreadAttribute(
            attr_list,
            0,
            _PROC_THREAD_ATTRIBUTE_JOB_LIST,
            ctypes.byref(jobs),
            ctypes.sizeof(jobs),
            None,
            None,
        ):
            raise OSError(f"UpdateProcThreadAttribute failed: {_last_error()}")
        inheritable = (wintypes.HANDLE * 3)(*std_handles)
        if not k32.UpdateProcThreadAttribute(
            attr_list,
            0,
            _PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            ctypes.byref(inheritable),
            ctypes.sizeof(inheritable),
            None,
            None,
        ):
            raise OSError(f"UpdateProcThreadAttribute failed: {_last_error()}")

        startup = _STARTUPINFOEXW()
        startup.StartupInfo.cb = ctypes.sizeof(_STARTUPINFOEXW)
        startup.StartupInfo.dwFlags = _STARTF_USESTDHANDLES
        (
            startup.StartupInfo.hStdInput,
            startup.StartupInfo.hStdOutput,
            startup.StartupInfo.hStdError,
        ) = std_handles
        startup.lpAttributeList = ctypes.cast(attr_list, wintypes.LPVOID)
        cmdline = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
        env_block = ctypes.create_unicode_buffer(
            "\0".join(
                f"{key}={value}"
                for key, value in sorted(env.items(), key=lambda kv: kv[0].upper())
            )
            + "\0"
        )
        info = _PROCESS_INFORMATION()
        flags = (
            _EXTENDED_STARTUPINFO_PRESENT
            | _CREATE_SUSPENDED
            | _CREATE_UNICODE_ENVIRONMENT
        )
        if not k32.CreateProcessW(
            None,
            cmdline,
            None,
            None,
            True,
            flags,
            env_block,
            cwd,
            ctypes.byref(startup),
            ctypes.byref(info),
        ):
            raise OSError(f"CreateProcessW failed: {_last_error()}")
        proc = JobProcess(
            int(info.hProcess or 0),
            int(info.hThread or 0),
            int(info.dwProcessId),
            None,
        )
    finally:
        if attr_list is not None:
            k32.DeleteProcThreadAttributeList(attr_list)
        if proc is None:
            # CreateProcessW either did not create a target or the caller-owned
            # kill-on-close Job remains the only tree authority.  Any process
            # handles returned before construction must be closed here.
            info_value = locals().get("info")
            if isinstance(info_value, _PROCESS_INFORMATION):
                for handle in (info_value.hProcess, info_value.hThread):
                    if handle:
                        k32.CloseHandle(handle)
    return proc


def is_empty(job: int) -> bool | None:
    """True/False = job has no/some live processes; None = query failed."""
    try:
        info = _JOBOBJECT_BASIC_ACCOUNTING_INFORMATION()
        ok = _kernel32().QueryInformationJobObject(
            job, _JobObjectBasicAccountingInformation, ctypes.byref(info), ctypes.sizeof(info), None
        )
        return info.ActiveProcesses == 0 if ok else None
    except (OSError, AttributeError):
        return None


def terminate(job: int, exit_code: int = 1) -> bool:
    try:
        return bool(_kernel32().TerminateJobObject(job, exit_code))
    except (OSError, AttributeError):
        return False


def close(job: int) -> None:
    """Close the handle; closing the LAST handle fires kill-on-close."""
    try:
        _kernel32().CloseHandle(job)
    except (OSError, AttributeError):
        pass


class _WindowsJobProtocolRunner:
    """Standalone, site-free admission controller used by the TypeScript host."""

    def __init__(
        self,
        control_input: TextIO,
        target_output: BinaryIO,
        protocol_output: TextIO,
    ) -> None:
        self.control_input = control_input
        self.target_output = target_output
        self.protocol_output = protocol_output
        self.write_lock = threading.Lock()
        self.cleanup_lock = threading.Lock()
        self.finished = threading.Event()
        self.nonce: str | None = None
        self.job: int | None = None
        self.proc: JobProcess | None = None
        self.process_start_id: str | None = None
        self.pump_thread: threading.Thread | None = None
        # Only a positive Job-empty result is terminal. Failed/transient queries
        # remain retryable while this helper still owns the Job/process handles.
        self.cleanup_proof: dict[str, bool] | None = None
        self.cleanup_started = False
        self.cleanup_termination_succeeded = False
        self.cleanup_taskkill_attempted = False

    def emit(self, frame_type: str, **fields: object) -> None:
        if self.nonce is None:
            raise RuntimeError("protocol nonce is unavailable")
        record = {
            "primeAgentWindowsJob": _PROTOCOL_VERSION,
            "type": frame_type,
            "nonce": self.nonce,
            **fields,
        }
        data = json.dumps(record, separators=(",", ":")) + "\n"
        with self.write_lock:
            self.protocol_output.write(data)
            self.protocol_output.flush()

    def diagnostic(self, message: str) -> None:
        with self.write_lock:
            self.protocol_output.write(f"prime-agent Windows Job helper: {message}\n")
            self.protocol_output.flush()

    def read_record(self) -> dict[str, object] | None:
        line = self.control_input.readline()
        if not line:
            return None
        value = json.loads(line)
        return value if isinstance(value, dict) else None

    @staticmethod
    def _exact_keys(value: dict[str, object], keys: set[str]) -> bool:
        return set(value) == keys

    def validate_request(self, request: dict[str, object] | None) -> dict[str, object]:
        if not isinstance(request, dict):
            raise ValueError("invalid protocol request")
        nonce = request.get("nonce")
        if not isinstance(nonce, str) or _PROTOCOL_NONCE.fullmatch(nonce) is None:
            raise ValueError("invalid protocol nonce")
        # Bind error reporting only after the token itself is valid.
        self.nonce = nonce
        if not self._exact_keys(
            request, {"version", "nonce", "ownerPid", "argv", "cwd", "env"}
        ):
            raise ValueError("invalid protocol request keys")
        if request.get("version") != _PROTOCOL_VERSION:
            raise ValueError("invalid protocol version")
        owner_pid = request.get("ownerPid")
        if type(owner_pid) is not int or owner_pid <= 0:
            raise ValueError("invalid ownerPid")
        cwd = request.get("cwd")
        if not isinstance(cwd, str) or not cwd or "\0" in cwd:
            raise ValueError("invalid cwd")
        argv = request.get("argv")
        if (
            not isinstance(argv, list)
            or not argv
            or not isinstance(argv[0], str)
            or not argv[0]
            or not all(isinstance(value, str) and "\0" not in value for value in argv)
        ):
            raise ValueError("invalid argv")
        env = request.get("env")
        if not isinstance(env, dict) or not all(
            isinstance(key, str)
            and key
            and "=" not in key
            and "\0" not in key
            and isinstance(value, str)
            and "\0" not in value
            for key, value in env.items()
        ):
            raise ValueError("invalid env")
        return request

    def valid_identity_control(self, action: dict[str, object] | None, expected: str) -> bool:
        return bool(
            isinstance(action, dict)
            and self._exact_keys(
                action, {"action", "nonce", "pid", "processStartId"}
            )
            and action.get("action") == expected
            and action.get("nonce") == self.nonce
            and action.get("pid") == self.proc.pid  # type: ignore[union-attr]
            and action.get("processStartId") == self.process_start_id
        )

    def valid_early_terminate(self, action: dict[str, object] | None) -> bool:
        return bool(
            isinstance(action, dict)
            and self._exact_keys(action, {"action", "nonce"})
            and action.get("action") == "terminate"
            and action.get("nonce") == self.nonce
        )

    def exact_start_id(self) -> str | None:
        if self.proc is None:
            return None
        with self.proc._lock:
            handle = self.proc._hprocess
            if handle is None:
                return None
            creation = _FILETIME()
            exit_time = _FILETIME()
            kernel_time = _FILETIME()
            user_time = _FILETIME()
            if not _kernel32().GetProcessTimes(
                handle,
                ctypes.byref(creation),
                ctypes.byref(exit_time),
                ctypes.byref(kernel_time),
                ctypes.byref(user_time),
            ):
                return None
        filetime = (int(creation.dwHighDateTime) << 32) | int(creation.dwLowDateTime)
        return f"win:{filetime + _DOTNET_FILETIME_OFFSET}"

    def wait_job_empty(self, timeout: float) -> bool:
        job = self.job
        if job is None:
            return False
        deadline = time.monotonic() + timeout
        while True:
            empty = is_empty(job)
            if empty is True:
                return True
            remaining = deadline - time.monotonic()
            if empty is None or remaining <= 0:
                return False
            # Event.wait avoids a busy polling loop and lets finish() stop cleanup waits.
            if self.finished.wait(min(0.02, remaining)):
                return False

    @staticmethod
    def system32_path(name: str) -> tuple[str, str] | None:
        buffer = ctypes.create_unicode_buffer(32768)
        length = _kernel32().GetWindowsDirectoryW(buffer, len(buffer))
        if not length or length >= len(buffer):
            return None
        system_root = buffer.value
        system32 = ntpath.join(system_root, "System32")
        return ntpath.join(system32, name), system_root

    def taskkill_tree(self, pid: int) -> bool:
        try:
            resolved = self.system32_path("taskkill.exe")
            if resolved is None:
                return False
            executable, system_root = resolved
            system32 = ntpath.dirname(executable)
            completed = subprocess.run(
                [executable, "/PID", str(pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                cwd=system32,
                env={
                    "SystemRoot": system_root,
                    "WINDIR": system_root,
                    "PATH": system32,
                    "ComSpec": ntpath.join(system32, "cmd.exe"),
                    "NoDefaultCurrentDirectoryInExePath": "1",
                },
                shell=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
            return completed.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def cleanup_job(self, pid: int, timeout: float = 2.0) -> dict[str, bool]:
        with self.cleanup_lock:
            if self.cleanup_proof is not None:
                return dict(self.cleanup_proof)
            job = self.job
            if job is None:
                return {
                    "jobEmpty": False,
                    "jobTerminationAttempted": False,
                    "jobTerminationSucceeded": False,
                    "taskkillFallbackAttempted": False,
                }
            if self.wait_job_empty(0.05):
                proof = {
                    "jobEmpty": True,
                    "jobTerminationAttempted": self.cleanup_started,
                    "jobTerminationSucceeded": self.cleanup_termination_succeeded,
                    "taskkillFallbackAttempted": self.cleanup_taskkill_attempted,
                }
                self.cleanup_proof = proof
                return dict(proof)
            if not self.cleanup_started:
                self.cleanup_started = True
                self.cleanup_termination_succeeded = bool(terminate(job))
                if not self.cleanup_termination_succeeded:
                    self.cleanup_taskkill_attempted = True
                    self.taskkill_tree(pid)
            # taskkill/TerminateJobObject delivery is never proof. A false or
            # uncertain query is intentionally not cached, so a later call can
            # observe the same still-held Job become empty.
            proof = {
                "jobEmpty": self.wait_job_empty(max(0.0, timeout)),
                "jobTerminationAttempted": True,
                "jobTerminationSucceeded": self.cleanup_termination_succeeded,
                "taskkillFallbackAttempted": self.cleanup_taskkill_attempted,
            }
            if proof["jobEmpty"]:
                self.cleanup_proof = proof
            return dict(proof)

    def wait_leader_dead(self, timeout: float) -> tuple[int, bool]:
        if self.proc is None:
            return 1, True
        try:
            return self.proc.wait(timeout=timeout), True
        except (OSError, subprocess.SubprocessError):
            try:
                code = self.proc.poll()
            except OSError:
                code = None
            return (1 if code is None else code), code is not None

    def pump_output(self) -> None:
        if self.proc is None or self.proc.stdout is None:
            return
        try:
            while True:
                chunk = self.proc.stdout.read(65536)
                if not chunk:
                    return
                self.target_output.write(chunk)
                self.target_output.flush()
        except (OSError, ValueError, BrokenPipeError):
            return

    def drain_output(self) -> None:
        if self.pump_thread is not None:
            self.pump_thread.join(timeout=2.0)

    def watch_parent(self, parent_handle: int) -> None:
        result = _kernel32().WaitForSingleObject(parent_handle, _INFINITE)
        if result == _WAIT_OBJECT_0 and not self.finished.is_set():
            with self.cleanup_lock:
                if self.job is not None:
                    terminate(self.job)
                    close(self.job)
                    self.job = None
            os._exit(70)

    def control_loop(self) -> None:
        while not self.finished.is_set():
            try:
                action = self.read_record()
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                self.emit("error", stage="control", message=f"{type(exc).__name__}: {exc}")
                action = None
            if action is None or self.valid_identity_control(action, "terminate"):
                self.cleanup_job(self.proc.pid)  # type: ignore[union-attr]
                return
            self.emit("error", stage="control", message="invalid terminate control")
            self.cleanup_job(self.proc.pid)  # type: ignore[union-attr]
            return

    def emit_done(self, exit_code: int, leader_dead: bool, proof: dict[str, bool]) -> None:
        if self.proc is None or self.process_start_id is None:
            raise RuntimeError("cannot emit done without an exact target identity")
        self.emit(
            "done",
            pid=self.proc.pid,
            processStartId=self.process_start_id,
            exitCode=exit_code,
            leaderDead=leader_dead,
            **proof,
        )

    def run(self) -> int:
        request = self.validate_request(self.read_record())
        owner_pid = request["ownerPid"]
        parent_handle = _kernel32().OpenProcess(_SYNCHRONIZE, False, owner_pid)
        if (
            not parent_handle
            or _kernel32().WaitForSingleObject(parent_handle, 0) != _WAIT_TIMEOUT
        ):
            if parent_handle:
                _kernel32().CloseHandle(parent_handle)
            raise RuntimeError("exact parent watchdog could not be established")
        self.job = create_job()
        if self.job is None:
            _kernel32().CloseHandle(parent_handle)
            raise RuntimeError("kill-on-close Job could not be established")
        try:
            threading.Thread(
                target=self.watch_parent, args=(parent_handle,), daemon=True
            ).start()
        except BaseException:
            _kernel32().CloseHandle(parent_handle)
            raise
        # spawn_in_job creates the target suspended and atomically in this already-live Job.
        self.proc = spawn_in_job(
            self.job,
            request["argv"],  # type: ignore[arg-type]
            cwd=request["cwd"],  # type: ignore[arg-type]
            env=request["env"],  # type: ignore[arg-type]
        )
        self.process_start_id = self.exact_start_id()
        if self.process_start_id is None:
            raise RuntimeError("exact process start identity could not be established")
        self.pump_thread = threading.Thread(target=self.pump_output, daemon=True)
        self.pump_thread.start()
        self.emit(
            "ready",
            pid=self.proc.pid,
            processStartId=self.process_start_id,
            jobContained=True,
        )

        action = self.read_record()
        release = self.valid_identity_control(action, "release")
        terminate_early = self.valid_identity_control(
            action, "terminate"
        ) or self.valid_early_terminate(action)
        if not release:
            if not terminate_early:
                self.emit("error", stage="control", message="invalid suspended-target control")
            proof = self.cleanup_job(self.proc.pid)
            exit_code, leader_dead = self.wait_leader_dead(5.0)
            self.drain_output()
            self.emit_done(exit_code, leader_dead, proof)
            return 0 if leader_dead and proof["jobEmpty"] else 2

        if not self.proc.resume():
            self.emit(
                "error",
                stage="resume",
                message="suspended Job process could not be resumed",
            )
            proof = self.cleanup_job(self.proc.pid)
            exit_code, leader_dead = self.wait_leader_dead(5.0)
            self.drain_output()
            self.emit_done(exit_code, leader_dead, proof)
            return 2

        self.emit(
            "released", pid=self.proc.pid, processStartId=self.process_start_id
        )
        threading.Thread(target=self.control_loop, daemon=True).start()
        exit_code = self.proc.wait()
        proof = self.cleanup_job(self.proc.pid)
        return_code, leader_dead = self.wait_leader_dead(0.0)
        if leader_dead:
            return_code = exit_code
        self.drain_output()
        self.emit_done(return_code, leader_dead, proof)
        return 0 if leader_dead and proof["jobEmpty"] else 2

    def finish(self) -> None:
        self.finished.set()
        if self.proc is not None:
            try:
                if self.proc.stdout is not None:
                    self.proc.stdout.close()
            except (OSError, ValueError):
                pass
            try:
                self.proc.close()
            except OSError:
                pass
        if self.job is not None:
            close(self.job)
            self.job = None


class _WindowsPersistentReplRunner(_WindowsJobProtocolRunner):
    """Long-lived suspended-target admission for the framed Python REPL.

    Standard handles belong only to the target data plane. Admission and Job
    proof use the exact helper's inherited anonymous fd3/fd4 pair, which the
    target HANDLE_LIST deliberately excludes.
    """

    def __init__(self, control_input: TextIO, protocol_output: TextIO) -> None:
        super().__init__(control_input, getattr(sys.stdout, "buffer", sys.stdout), protocol_output)
        self.admission_generation: str | None = None
        self.target_token: str | None = None

    def emit(self, frame_type: str, **fields: object) -> None:
        if self.admission_generation is None or self.target_token is None:
            raise RuntimeError("persistent REPL admission identity is unavailable")
        record = {
            "primeAgentWindowsRepl": _PERSISTENT_REPL_PROTOCOL_VERSION,
            "type": frame_type,
            "admissionGeneration": self.admission_generation,
            "targetToken": self.target_token,
            **fields,
        }
        data = json.dumps(record, separators=(",", ":")) + "\n"
        with self.write_lock:
            self.protocol_output.write(data)
            self.protocol_output.flush()

    def diagnostic(self, message: str) -> None:
        with self.write_lock:
            self.protocol_output.write(
                f"prime-agent Windows persistent REPL helper: {message}\n"
            )
            self.protocol_output.flush()

    @staticmethod
    def _contains_owner_marker(value: str) -> bool:
        return _OWNER_TOKEN_PREFIX in value

    def validate_persistent_request(
        self, request: dict[str, object] | None
    ) -> dict[str, object]:
        if not isinstance(request, dict):
            raise ValueError("invalid persistent REPL protocol request")
        generation = request.get("admissionGeneration")
        token = request.get("targetToken")
        if (
            not isinstance(generation, str)
            or _ADMISSION_GENERATION.fullmatch(generation) is None
            or not isinstance(token, str)
            or _OWNER_TOKEN.fullmatch(token) is None
        ):
            raise ValueError("invalid persistent REPL admission identity")
        # Bind all later diagnostics only after both capabilities are valid.
        self.admission_generation = generation
        self.target_token = token
        if not self._exact_keys(
            request,
            {
                "version",
                "admissionGeneration",
                "targetToken",
                "ownerPid",
                "argv",
                "cwd",
                "env",
            },
        ):
            raise ValueError("invalid persistent REPL protocol request keys")
        if request.get("version") != _PERSISTENT_REPL_PROTOCOL_VERSION:
            raise ValueError("invalid persistent REPL protocol version")
        owner_pid = request.get("ownerPid")
        if type(owner_pid) is not int or owner_pid <= 0:
            raise ValueError("invalid ownerPid")
        cwd = request.get("cwd")
        if (
            not isinstance(cwd, str)
            or not cwd
            or "\0" in cwd
            or not ntpath.isabs(cwd)
        ):
            raise ValueError("invalid cwd")
        argv = request.get("argv")
        if (
            not isinstance(argv, list)
            or not argv
            or not isinstance(argv[0], str)
            or not argv[0]
            or not ntpath.isabs(argv[0])
            or not all(
                isinstance(value, str)
                and "\0" not in value
                and not self._contains_owner_marker(value)
                for value in argv
            )
        ):
            raise ValueError("invalid argv")
        env = request.get("env")
        # The target token exists exactly once in argv after the helper appends it.
        # A distinct PRIME_AGENT_BASH_COMMAND_PREFIX token is valid target data.
        if not isinstance(env, dict) or not all(
            isinstance(key, str)
            and key
            and "=" not in key
            and "\0" not in key
            and token not in key
            and isinstance(value, str)
            and "\0" not in value
            and token not in value
            for key, value in env.items()
        ):
            raise ValueError("invalid env")
        return request

    def valid_persistent_control(
        self, action: dict[str, object] | None, expected: str
    ) -> bool:
        return bool(
            isinstance(action, dict)
            and self.proc is not None
            and self.process_start_id is not None
            and self._exact_keys(
                action,
                {
                    "version",
                    "type",
                    "admissionGeneration",
                    "targetToken",
                    "targetPid",
                    "processStartId",
                },
            )
            and action.get("version") == _PERSISTENT_REPL_PROTOCOL_VERSION
            and action.get("type") == expected
            and action.get("admissionGeneration") == self.admission_generation
            and action.get("targetToken") == self.target_token
            and action.get("targetPid") == self.proc.pid
            and action.get("processStartId") == self.process_start_id
        )

    def control_loop(self) -> None:
        while not self.finished.is_set():
            try:
                action = self.read_record()
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                self.emit(
                    "error", stage="control", message=f"{type(exc).__name__}: {exc}"
                )
                action = None
            if action is None or self.valid_persistent_control(action, "terminate"):
                self.cleanup_job(self.proc.pid)  # type: ignore[union-attr]
                return
            self.emit("error", stage="control", message="invalid persistent REPL control")
            self.cleanup_job(self.proc.pid)  # type: ignore[union-attr]
            return

    def emit_persistent_done(
        self, exit_code: int, leader_dead: bool, proof: dict[str, bool]
    ) -> None:
        if self.proc is None or self.process_start_id is None:
            raise RuntimeError("cannot emit done without an exact target identity")
        if not leader_dead or proof.get("jobEmpty") is not True:
            raise RuntimeError("cannot emit terminal target-done without positive Job proof")
        self.emit(
            "target-done",
            targetPid=self.proc.pid,
            processStartId=self.process_start_id,
            exitCode=exit_code,
            leaderDead=True,
            **proof,
        )

    def await_persistent_done(
        self, preferred_exit_code: int | None = None
    ) -> tuple[int, dict[str, bool]]:
        """Re-query one held Job until exact leader-dead + Job-empty proof exists."""
        if self.proc is None:
            raise RuntimeError("persistent REPL target is unavailable")
        while True:
            exit_code, leader_dead = self.wait_leader_dead(
                _PERSISTENT_REPL_REQUERY_SECONDS
            )
            proof = self.cleanup_job(
                self.proc.pid, timeout=_PERSISTENT_REPL_REQUERY_SECONDS
            )
            if leader_dead and proof["jobEmpty"]:
                return (
                    preferred_exit_code
                    if preferred_exit_code is not None
                    else exit_code,
                    proof,
                )
            # Both waits above are bounded. This extra event wait prevents a
            # transient query-failure loop from becoming a busy loop.
            self.finished.wait(_PERSISTENT_REPL_REQUERY_SECONDS)

    def run(self) -> int:
        request = self.validate_persistent_request(self.read_record())
        owner_pid = request["ownerPid"]
        parent_handle = _kernel32().OpenProcess(_SYNCHRONIZE, False, owner_pid)
        if (
            not parent_handle
            or _kernel32().WaitForSingleObject(parent_handle, 0) != _WAIT_TIMEOUT
        ):
            if parent_handle:
                _kernel32().CloseHandle(parent_handle)
            raise RuntimeError("exact parent watchdog could not be established")
        self.job = create_job()
        if self.job is None:
            _kernel32().CloseHandle(parent_handle)
            raise RuntimeError("kill-on-close Job could not be established")
        try:
            threading.Thread(
                target=self.watch_parent, args=(parent_handle,), daemon=True
            ).start()
        except BaseException:
            _kernel32().CloseHandle(parent_handle)
            raise
        target_argv = [
            *request["argv"],  # type: ignore[misc]
            self.target_token,
        ]
        # The Job already exists. CreateProcessW atomically assigns the suspended
        # target and gives it only standard data-plane handles.
        self.proc = spawn_persistent_repl_in_job(
            self.job,
            target_argv,
            cwd=request["cwd"],  # type: ignore[arg-type]
            env=request["env"],  # type: ignore[arg-type]
        )
        self.process_start_id = self.exact_start_id()
        if self.process_start_id is None:
            raise RuntimeError("exact process start identity could not be established")
        self.emit(
            "target-pending",
            targetPid=self.proc.pid,
            processStartId=self.process_start_id,
            jobContained=True,
        )

        action = self.read_record()
        if not self.valid_persistent_control(action, "target-ack"):
            self.emit(
                "error",
                stage="control",
                message="stale or invalid persistent REPL acknowledgement",
            )
            self.cleanup_job(self.proc.pid, timeout=0.0)
            exit_code, proof = self.await_persistent_done()
            self.emit_persistent_done(exit_code, True, proof)
            return 0

        if not self.proc.resume():
            self.emit(
                "error",
                stage="resume",
                message="suspended persistent REPL target could not be resumed",
            )
            self.cleanup_job(self.proc.pid, timeout=0.0)
            exit_code, proof = self.await_persistent_done()
            self.emit_persistent_done(exit_code, True, proof)
            return 2

        self.emit(
            "target-released",
            targetPid=self.proc.pid,
            processStartId=self.process_start_id,
        )
        threading.Thread(target=self.control_loop, daemon=True).start()
        exit_code = self.proc.wait()
        return_code, proof = self.await_persistent_done(exit_code)
        self.emit_persistent_done(return_code, True, proof)
        return 0


def _persistent_repl_main() -> int:
    runner: _WindowsPersistentReplRunner | None = None
    exit_status = 1
    try:
        # Node creates this exact child's anonymous fd3/fd4 pair. The target's
        # explicit HANDLE_LIST contains only fd0/1/2 OS handles, so it cannot
        # read requests or forge authority frames.
        with os.fdopen(
            _PERSISTENT_REPL_CONTROL_INPUT_FD,
            "r",
            encoding="utf-8",
            buffering=1,
            newline="\n",
        ) as control_input, os.fdopen(
            _PERSISTENT_REPL_CONTROL_OUTPUT_FD,
            "w",
            encoding="utf-8",
            buffering=1,
            newline="\n",
        ) as protocol_output:
            runner = _WindowsPersistentReplRunner(control_input, protocol_output)
            try:
                exit_status = runner.run()
            except BaseException as exc:
                if runner.admission_generation is None or runner.target_token is None:
                    runner.diagnostic(f"{type(exc).__name__}: {exc}")
                else:
                    runner.emit(
                        "error",
                        stage="containment",
                        message=f"{type(exc).__name__}: {exc}",
                    )
                if runner.job is not None and runner.proc is not None:
                    runner.cleanup_job(runner.proc.pid, timeout=0.0)
                    exit_code, proof = runner.await_persistent_done()
                    if runner.process_start_id is not None:
                        runner.emit_persistent_done(exit_code, True, proof)
            finally:
                runner.finish()
    except BaseException:
        # If fd3/fd4 cannot be opened or the authority stream is lost, helper
        # exit closes any acquired kill-on-close Job. No unbound proof is sent.
        if runner is not None:
            runner.finish()
    return exit_status


def _standalone_main() -> int:
    target_output = getattr(sys.stdout, "buffer", sys.stdout)
    runner = _WindowsJobProtocolRunner(sys.stdin, target_output, sys.stderr)
    exit_status = 1
    try:
        exit_status = runner.run()
    except BaseException as exc:
        if runner.nonce is None:
            runner.diagnostic(f"{type(exc).__name__}: {exc}")
        else:
            runner.emit(
                "error", stage="containment", message=f"{type(exc).__name__}: {exc}"
            )
        if runner.job is not None and runner.proc is not None:
            proof = runner.cleanup_job(runner.proc.pid)
            exit_code, leader_dead = runner.wait_leader_dead(5.0)
            runner.drain_output()
            if runner.process_start_id is not None:
                runner.emit_done(exit_code, leader_dead, proof)
            else:
                runner.emit(
                    "setup-done",
                    pid=runner.proc.pid,
                    leaderDead=leader_dead,
                    **proof,
                )
    finally:
        runner.finish()
    return exit_status


if __name__ == "__main__":
    if sys.argv == [sys.argv[0], "--persistent-repl"]:
        raise SystemExit(_persistent_repl_main())
    if len(sys.argv) != 1:
        raise SystemExit("invalid Windows Job helper mode")
    raise SystemExit(_standalone_main())
