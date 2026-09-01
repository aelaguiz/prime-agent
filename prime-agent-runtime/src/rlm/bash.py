"""Async-by-default shell execution: bash() spawns immediately and returns a live handle."""

from __future__ import annotations

import asyncio
import atexit
import json
import ntpath
import os
import re
import secrets
import selectors
import stat
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Generator
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast

from . import _winjob

_IS_POSIX = os.name == "posix"

if _IS_POSIX:
    import fcntl
    import termios

_HEAD_CAP = 512 * 1024
_TAIL_CAP = 3 * 512 * 1024
_READ_CHUNK = 65536
_SUPERVISOR_PACKET_JSON = 1
_SUPERVISOR_PACKET_OUTPUT = 2
_SUPERVISOR_PACKET_HEADER = struct.Struct("!BQ")
# Cancelled one-shot awaits: TERM grace before the group KILL, then the bounded
# wait for a confirmed group exit before CancelledError propagates.
_CANCEL_TERM_GRACE = 0.5
_CANCEL_KILL_WAIT = 2.0

_live_handles: set["BashHandle"] = set()
_live_lock = threading.Lock()
_hook_installed = False
_hook_lock = threading.Lock()
_JOURNAL_PATH_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL"
_JOURNAL_GENERATION_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL_GENERATION"
_KERNEL_ADMISSION_GENERATION_ENV = "PRIME_AGENT_INTERNAL_KERNEL_ADMISSION_GENERATION"
_KERNEL_ADMISSION_PROTOCOL_ENV = "PRIME_AGENT_INTERNAL_KERNEL_ADMISSION_PROTOCOL"
_KERNEL_ADMISSION_PROTOCOL_VERSION = "2"
_KERNEL_LINEAGE_ENV = "PRIME_AGENT_INTERNAL_KERNEL_LINEAGE"
_KERNEL_PID_ENV = "PRIME_AGENT_INTERNAL_KERNEL_PID"
_KERNEL_PROCESS_START_ID_ENV = "PRIME_AGENT_INTERNAL_KERNEL_PROCESS_START_ID"
_KERNEL_ADMISSION_GENERATION = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_KERNEL_LINEAGE = re.compile(r"^[0-9a-f]{64}$")
_JOURNAL_WRITE_LOCK_SUFFIX = ".append.lock"
_JOURNAL_WRITE_LOCK_CLAIMS_SUFFIX = ".claims"
_JOURNAL_WRITE_LOCK_VERSION = 1
_JOURNAL_WRITE_LOCK_TIMEOUT = 1.0
_JOURNAL_WRITE_LOCK_LEASE = 5.0
_JOURNAL_WRITE_LOCK_MAX_BYTES = 16 * 1024
_JOURNAL_WRITE_LOCK_TOKEN = re.compile(r"^[0-9a-f]{64}$")
_LEGACY_JOURNAL_WRITE_LOCK_TOKEN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_QUALIFIED_LINUX_PROCESS_IDENTITY = re.compile(
    r"^proc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9][0-9]{0,19})$"
)
_WINDOWS_PROCESS_IDENTITY = re.compile(r"^win:(?:0|[1-9][0-9]{0,31})$")
_TOKEN_PROCESS_IDENTITY = re.compile(r"^token:[0-9a-f]{64}$")
_EXACT_PROCESS_IDENTITY = re.compile(
    r"^(?:proc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(?:0|[1-9][0-9]{0,19})|win:(?:0|[1-9][0-9]{0,31})|token:[0-9a-f]{64})$"
)
_LEGACY_PROCESS_IDENTITY = re.compile(r"^proc:(0|[1-9][0-9]{0,19})$")
_LINUX_BOOT_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
_UTC_ISO_TIMESTAMP = re.compile(
    r"^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|\+00:00)$"
)
_PROCESS_IDENTITY_OWNER_TOKEN_PREFIX = "prime-agent-owner-token="
_SUPERVISOR_PROTOCOL = 2
_SUPERVISOR_STARTUP_TIMEOUT = 5.0
_SUPERVISOR_MAX_FRAME = 64 * 1024 * 1024
# (processStartId, kernelPid, kernelProcessStartId, admissionGeneration, kernelLineage)
_journal_enrollments: dict[tuple[int, int], tuple[str, int, str, str, str]] = {}
_journal_lock = threading.Lock()


@dataclass(frozen=True)
class BashResult:
    exit_code: int
    output: str
    duration: float


class _BoundedBuffer:
    """First _HEAD_CAP bytes plus a rolling _TAIL_CAP-byte tail; the middle is dropped."""

    def __init__(self) -> None:
        self._head = bytearray()
        self._tail: deque[bytes] = deque()
        self._tail_size = 0
        self._dropped = 0
        self._lock = threading.Lock()

    def write(self, chunk: bytes) -> None:
        with self._lock:
            if len(self._head) < _HEAD_CAP:
                take = _HEAD_CAP - len(self._head)
                self._head.extend(chunk[:take])
                chunk = chunk[take:]
            if not chunk:
                return
            self._tail.append(chunk)
            self._tail_size += len(chunk)
            # Trim the oldest chunk instead of dropping it whole so exactly _TAIL_CAP bytes stay.
            while self._tail_size > _TAIL_CAP:
                excess = self._tail_size - _TAIL_CAP
                oldest = self._tail[0]
                if len(oldest) <= excess:
                    self._tail.popleft()
                    self._tail_size -= len(oldest)
                    self._dropped += len(oldest)
                else:
                    self._tail[0] = oldest[excess:]
                    self._tail_size -= excess
                    self._dropped += excess

    def size(self) -> int:
        with self._lock:
            return len(self._head) + self._tail_size

    def text(self) -> str:
        with self._lock:
            head = bytes(self._head)
            tail = b"".join(self._tail)
            dropped = self._dropped
        if not dropped:
            return (head + tail).decode("utf-8", errors="replace")
        marker = f"\n... [{dropped} bytes dropped] ...\n"
        return head.decode("utf-8", errors="replace") + marker + tail.decode("utf-8", errors="replace")


class BashHandle:
    """Live handle to a shell command; await it for the BashResult.

    A handle awaited before any other API use (the `await bash(cmd)` one-shot
    form, including `h = bash(cmd)` awaited immediately) owns the command:
    cancelling that await kills the process group. Touching .pid/.running/
    .output()/.tail()/.poll()/.kill() first marks the handle as a background
    handle; later awaits only wait and cancelling them leaves it running.
    """

    def __init__(self, command: str) -> None:
        self.command = command
        self._spawned_posix = _IS_POSIX
        self._buffer = _BoundedBuffer()
        self._done = threading.Event()
        self._eof = threading.Event()
        self._completion_terminal = threading.Event()
        self._completion_output: str | None = None
        self._completion_lock = threading.Lock()
        self._completion_pending = b""
        self._status: int | None = None
        self._status_known = threading.Event()
        self._reaped = False
        self._leader_reaped = False
        self._group_empty_proven = False
        self._result: BashResult | None = None
        self._callbacks: list[Callable[[], None]] = []
        self._callback_lock = threading.Lock()
        self._lifecycle_lock = threading.RLock()
        self._lifecycle_state = "starting"
        self._started = time.monotonic()
        self._status_read = -1
        self._wake_read = -1
        self._wake_write = -1
        self._pump_transfer = False
        self._job: int | None = None
        self._completion_marker: bytes | None = None
        self._control_sock: socket.socket | None = None
        self._control_send_lock = threading.Lock()
        self._owner_token: str | None = None
        self._control_token: str | None = None
        self._target_pid: int | None = None
        self._startup_receipt: dict[str, Any] | None = None
        self._startup_receipt_ready = threading.Event()
        self._protocol_terminal = threading.Event()
        self._protocol_error: RuntimeError | None = None
        self._target_complete_received = False
        self._cleanup_receipt: tuple[int, int, str, bool] | None = None
        self._pump_started = False
        self._release_sent = False
        self._journal_enrolled = False
        self._journal_process_start_id: str | None = None
        self._released = False
        self._startup_aborting = False
        self._startup_decided = threading.Event()
        self._proc: subprocess.Popen[bytes] | _winjob.JobProcess

        if os.name != "nt" and not (sys.platform.startswith("linux") or sys.platform == "darwin"):
            raise RuntimeError(
                f"bash(): exact-identity probe unavailable: unsupported platform {sys.platform}"
            )
        if os.environ.get(_JOURNAL_PATH_ENV) and _configured_kernel_lineage() is None:
            raise RuntimeError("bash(): kernel admission protocol/version or exact identity mismatch")

        if _IS_POSIX:
            script = _with_prefix(command)
            shell = _shell()
            target_cwd = os.getcwd()
            target_env = _child_env()
            parent_control, child_control = socket.socketpair()
            self._control_sock = parent_control
            self._owner_token = secrets.token_hex(32)
            self._control_token = secrets.token_hex(32)
            try:
                argv = _supervisor_argv(child_control.fileno(), self._owner_token)
                self._proc = subprocess.Popen(
                    argv,
                    cwd="/",
                    env=_bootstrap_env(),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    close_fds=True,
                    pass_fds=(child_control.fileno(),),
                )
            except BaseException:
                parent_control.close()
                raise
            finally:
                child_control.close()
            self._pid = self._proc.pid
            try:
                ready = _read_supervisor_line(self._control_sock)
                _validate_supervisor_ready(ready, self._pid, self._owner_token)
                start_id = _supervisor_process_start_id(self._pid, self._owner_token)
                if start_id is None:
                    raise RuntimeError(
                        "bash(): trusted supervisor exact-identity probe unavailable"
                    )
                self._journal_process_start_id = start_id
            except BaseException as exc:
                self._abort_spawn()
                if isinstance(exc, RuntimeError) and str(exc).startswith("bash():"):
                    raise
                raise RuntimeError(
                    f"bash(): trusted supervisor admission failed: {exc}"
                ) from exc
            release_payload = {
                "type": "release",
                "protocol": _SUPERVISOR_PROTOCOL,
                "pid": self._pid,
                "ownerToken": self._owner_token,
                "controlToken": self._control_token,
                "shell": shell,
                "script": script,
                "cwd": target_cwd,
                "env": target_env,
            }
        else:
            script = _with_prefix(command)
            self._job = _winjob.create_job()
            if self._job is None:
                raise RuntimeError("bash(): Windows job containment could not be established")
            try:
                self._proc = _winjob.spawn_in_job(
                    self._job, [_shell(), "-c", script], cwd=os.getcwd(), env=_child_env()
                )
            except BaseException:
                job, self._job = self._job, None
                _winjob.close(cast(int, job))
                raise
            self._pid = self._proc.pid

        with _live_lock:
            _live_handles.add(self)
        enrolled = _enroll_journal(
            self._pid,
            expected_start_id=self._journal_process_start_id,
        )
        if not enrolled:
            self._abort_spawn()
            raise RuntimeError(
                "bash(): orphan-journal enrollment failed (journal configured but the "
                "pid could not be recorded); the spawned process was killed"
            )
        self._journal_enrolled = True
        enrolled_start_id = _journal_enrollment_start_id(self._pid)
        if enrolled_start_id is not None:
            self._journal_process_start_id = enrolled_start_id
        support_threads = (
            [
                threading.Thread(target=self._pump, name=f"bash-pump-{self._pid}", daemon=True),
                threading.Thread(target=self._watch, name=f"bash-watch-{self._pid}", daemon=True),
            ]
            if self._spawned_posix
            else [
                threading.Thread(target=self._pump, name=f"bash-pump-{self._pid}", daemon=True),
                threading.Thread(target=self._report, name=f"bash-report-{self._pid}", daemon=True),
                threading.Thread(target=self._watch, name=f"bash-watch-{self._pid}", daemon=True),
            ]
        )
        started_threads: list[threading.Thread] = []
        try:
            for thread in support_threads:
                thread.start()
                started_threads.append(thread)
                if thread.name.startswith("bash-pump-"):
                    self._pump_started = True
            if _IS_POSIX:
                control = self._control_sock
                assert control is not None
                # A partial release can start the configured shell. Every later
                # failure therefore uses the supervisor's post-release cleanup.
                self._release_sent = True
                _send_control_frame(control, release_payload)
                if not self._startup_receipt_ready.wait(_SUPERVISOR_STARTUP_TIMEOUT):
                    raise RuntimeError("bash(): trusted supervisor start receipt timed out")
                if self._protocol_error is not None:
                    raise self._protocol_error
                started = self._startup_receipt
                if started is None:
                    raise RuntimeError("bash(): trusted supervisor omitted its start receipt")
                if started.get("type") == "startup_error":
                    raise RuntimeError(
                        f"bash(): configured shell failed to start: {started.get('message', 'unknown error')}"
                    )
                if started.get("type") != "started" or not _positive_int(started.get("targetPid")):
                    raise RuntimeError("bash(): trusted supervisor returned an invalid start receipt")
                self._target_pid = cast(int, started["targetPid"])
            elif not cast("_winjob.JobProcess", self._proc).resume():
                raise RuntimeError("bash(): Windows job containment could not be established")
            with self._lifecycle_lock:
                self._lifecycle_state = "active"
            self._startup_decided.set()
        except BaseException:
            self._abort_spawn(started_threads)
            raise

    @property
    def pid(self) -> int:
        self._released = True
        return self._pid

    @property
    def running(self) -> bool:
        self._released = True
        with self._lifecycle_lock:
            return self._lifecycle_state != "reaped"

    def output(self) -> str:
        self._released = True
        return self._buffer.text()

    def tail(self, n: int = 50) -> str:
        self._released = True
        return "\n".join(self._buffer.text().splitlines()[-n:])

    def poll(self) -> BashResult | None:
        self._released = True
        return self._result if self._done.is_set() else None

    def kill(self, sig: int = signal.SIGTERM, grace: float = 5.0) -> None:
        self._released = True
        timer: threading.Timer | None = None
        with self._lifecycle_lock:
            if self._reaped or self._lifecycle_state in {"aborting", "reaped"}:
                return
            if self._spawned_posix and _IS_POSIX:
                signal_number = int(sig)
                if signal_number == 0:
                    return
                if signal_number < 0 or signal_number >= signal.NSIG:
                    raise ValueError(f"invalid signal number: {signal_number}")
                if signal_number == signal.SIGSTOP:
                    raise ValueError("SIGSTOP cannot preserve the anchored bash supervisor")
                self._send_supervisor_signal_locked(signal_number)
                if signal_number == signal.SIGTERM:
                    self._lifecycle_state = "terminating"
                    timer = threading.Timer(grace, self._force_kill)
                    timer.daemon = True
            else:
                if self._job is not None and _winjob.terminate(self._job):
                    return
                if not _taskkill_tree(self._pid):
                    try:
                        self._proc.kill()
                    except OSError:
                        pass
                return
        if timer is not None:
            timer.start()

    def _send_supervisor_signal_locked(self, sig: int) -> bool:
        control = self._control_sock
        token = self._control_token
        target_pid = self._target_pid
        if (
            control is None
            or token is None
            or target_pid is None
            or self._leader_reaped
        ):
            return False
        try:
            with self._control_send_lock:
                _send_control_frame(
                    control,
                    {
                        "type": "signal",
                        "protocol": _SUPERVISOR_PROTOCOL,
                        "pid": self._pid,
                        "targetPid": target_pid,
                        "token": token,
                        "state": "running",
                        "signal": int(sig),
                    },
                )
        except (OSError, RuntimeError, ValueError):
            return False
        return True

    def _force_kill(self) -> None:
        with self._lifecycle_lock:
            if self._reaped or self._lifecycle_state in {"aborting", "reaped"}:
                return
            if self._spawned_posix and _IS_POSIX:
                self._lifecycle_state = "terminating"
                self._send_supervisor_signal_locked(signal.SIGKILL)
                return
            if self._job is not None and not _winjob.terminate(self._job):
                _taskkill_tree(self._pid)

    def _pump(self) -> None:
        if self._spawned_posix:
            self._pump_posix()
            return
        stdout = self._proc.stdout
        assert stdout is not None
        try:
            while chunk := stdout.read1(_READ_CHUNK):
                self._buffer.write(chunk)
        except (OSError, ValueError):
            pass
        stdout.close()
        self._eof.set()

    def _pump_posix(self) -> None:
        control = self._control_sock
        assert control is not None
        try:
            while True:
                packet = _recv_supervisor_packet(control)
                if packet is None:
                    break
                kind, data = packet
                if kind == _SUPERVISOR_PACKET_OUTPUT:
                    if self._startup_receipt is None or self._startup_receipt.get("type") != "started":
                        raise RuntimeError("bash(): supervisor output arrived before target admission")
                    if self._group_empty_proven:
                        raise RuntimeError("bash(): supervisor output arrived after group-empty proof")
                    self._buffer.write(data)
                    continue
                if kind != _SUPERVISOR_PACKET_JSON:
                    raise RuntimeError("bash(): trusted supervisor sent an invalid packet type")
                try:
                    payload = json.loads(data)
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise RuntimeError("bash(): trusted supervisor sent invalid JSON") from exc
                if not isinstance(payload, dict):
                    raise RuntimeError("bash(): trusted supervisor frame must be an object")
                self._accept_supervisor_frame(payload)
        except BaseException as exc:
            error = exc if isinstance(exc, RuntimeError) else RuntimeError(
                f"bash(): trusted supervisor protocol failed: {exc}"
            )
            self._record_posix_protocol_error(error)
        finally:
            self._startup_receipt_ready.set()
            self._protocol_terminal.set()
            self._eof.set()

    def _accept_supervisor_frame(self, payload: dict[str, Any]) -> None:
        if self._group_empty_proven:
            raise RuntimeError("bash(): trusted supervisor sent data after terminal proof")
        frame_type = payload.get("type")
        if frame_type == "started":
            expected_keys = {"type", "protocol", "pid", "targetPid", "token", "state"}
            if (
                set(payload) != expected_keys
                or payload.get("protocol") != _SUPERVISOR_PROTOCOL
                or payload.get("pid") != self._pid
                or payload.get("token") != self._control_token
                or payload.get("state") != "running"
                or not _positive_int(payload.get("targetPid"))
                or self._startup_receipt is not None
            ):
                raise RuntimeError("bash(): trusted supervisor returned an invalid start receipt")
            self._target_pid = cast(int, payload["targetPid"])
            self._startup_receipt = payload
            self._startup_receipt_ready.set()
            return
        if frame_type == "startup_error":
            expected_keys = {
                "type",
                "protocol",
                "pid",
                "targetPid",
                "token",
                "state",
                "message",
            }
            if (
                set(payload) != expected_keys
                or payload.get("protocol") != _SUPERVISOR_PROTOCOL
                or payload.get("pid") != self._pid
                or payload.get("targetPid") is not None
                or payload.get("token") != self._control_token
                or payload.get("state") != "setup-empty"
                or not isinstance(payload.get("message"), str)
                or self._startup_receipt is not None
            ):
                raise RuntimeError("bash(): trusted supervisor returned an invalid startup error")
            self._startup_receipt = payload
            self._startup_receipt_ready.set()
            return
        if frame_type == "cleanup_started":
            expected_keys = {
                "type",
                "protocol",
                "pid",
                "targetPid",
                "token",
                "helperPid",
                "state",
                "reason",
                "completionPending",
            }
            reason = payload.get("reason")
            pending = payload.get("completionPending")
            if (
                set(payload) != expected_keys
                or payload.get("protocol") != _SUPERVISOR_PROTOCOL
                or payload.get("pid") != self._pid
                or payload.get("targetPid") != self._target_pid
                or payload.get("token") != self._control_token
                or not _positive_int(payload.get("helperPid"))
                or payload.get("state") != "cleanup-started"
                or reason not in {"signal-kill", "parent-eof", "supervisor-error"}
                or not isinstance(pending, bool)
                or pending == self._target_complete_received
                or self._cleanup_receipt is not None
            ):
                raise RuntimeError("bash(): trusted supervisor returned an invalid cleanup receipt")
            self._cleanup_receipt = (
                cast(int, payload["helperPid"]),
                cast(int, payload["targetPid"]),
                cast(str, reason),
                cast(bool, pending),
            )
            return
        if frame_type == "target_complete":
            expected_keys = {
                "type",
                "protocol",
                "pid",
                "targetPid",
                "token",
                "state",
                "returncode",
                "forced",
            }
            returncode = payload.get("returncode")
            forced = payload.get("forced")
            if (
                set(payload) != expected_keys
                or payload.get("protocol") != _SUPERVISOR_PROTOCOL
                or payload.get("pid") != self._pid
                or payload.get("targetPid") != self._target_pid
                or payload.get("token") != self._control_token
                or payload.get("state") != "target-complete"
                or not isinstance(returncode, int)
                or isinstance(returncode, bool)
                or not isinstance(forced, bool)
                or self._target_complete_received
            ):
                raise RuntimeError("bash(): trusted supervisor returned an invalid completion receipt")
            if forced:
                cleanup = self._cleanup_receipt
                if cleanup is None or not cleanup[3] or returncode != -signal.SIGKILL:
                    raise RuntimeError("bash(): forced completion lacks matching cleanup authority")
            self._target_complete_received = True
            self._completion_output = self._buffer.text()
            self._completion_terminal.set()
            with self._callback_lock:
                self._status = returncode
            self._status_known.set()
            self._finalize(returncode, self._completion_output)
            return
        if frame_type == "group_empty":
            expected_keys = {
                "type",
                "protocol",
                "pid",
                "targetPid",
                "token",
                "helperPid",
                "state",
                "reason",
            }
            if (
                set(payload) != expected_keys
                or payload.get("protocol") != _SUPERVISOR_PROTOCOL
                or payload.get("pid") != self._pid
                or payload.get("state") != "group-empty"
            ):
                raise RuntimeError("bash(): trusted supervisor returned an invalid group proof")
            helper_pid = payload.get("helperPid")
            target_pid = payload.get("targetPid")
            reason = payload.get("reason")
            token = payload.get("token")
            if helper_pid is None:
                setup_proof = (
                    target_pid is None
                    and reason == "setup"
                    and token in {self._owner_token, self._control_token}
                    and not self._target_complete_received
                )
                natural_proof = (
                    target_pid == self._target_pid
                    and target_pid is not None
                    and reason == "natural"
                    and token == self._control_token
                    and self._target_complete_received
                )
                if not setup_proof and not natural_proof:
                    raise RuntimeError("bash(): group proof is not bound to the current state")
            else:
                cleanup = self._cleanup_receipt
                if (
                    cleanup is None
                    or helper_pid != cleanup[0]
                    or target_pid != cleanup[1]
                    or reason != cleanup[2]
                    or token != self._control_token
                    or not self._target_complete_received
                ):
                    raise RuntimeError("bash(): cleanup proof is not bound to its helper and state")
            self._group_empty_proven = True
            return
        raise RuntimeError("bash(): trusted supervisor returned an unknown frame")

    def _record_posix_protocol_error(self, error: RuntimeError) -> None:
        if self._protocol_error is None:
            self._protocol_error = error
        self._startup_receipt_ready.set()
        with self._lifecycle_lock:
            if self._release_sent and not self._leader_reaped:
                self._send_supervisor_signal_locked(signal.SIGKILL)

    def _abandon_completion(self) -> None:
        with self._completion_lock:
            if self._completion_terminal.is_set():
                return
            self._buffer.write(self._completion_pending)
            self._completion_pending = b""
            self._completion_terminal.set()

    def _wait_for_completion(self) -> str | None:
        self._completion_terminal.wait()
        return self._completion_output

    def _report(self) -> None:
        # Finalize at foreground completion (status channel), not EOF, so
        # `cmd &` does not hang the await; the shell then `wait`s for its
        # background jobs, keeping the journaled group identity alive.
        status: int | None = None
        try:
            status = self._read_status()
            # Reserve the delivered status before draining so a shell death during
            # the drain window cannot override it with wait()'s signal exit code.
            with self._callback_lock:
                self._status = status
        finally:
            # _watch blocks on this event without a timeout, so every exit path
            # (parsed status, EOF, garbage, exception) must set it.
            self._status_known.set()
        if status is not None:
            output = self._wait_for_completion()
            if output is None:
                self._drain_grace()
            self._finalize(status, output)

    def _watch(self) -> None:
        if self._spawned_posix:
            self._watch_posix()
            return
        exit_code = self._proc.wait()
        if self._wake_write >= 0:
            try:
                os.write(self._wake_write, b"x")
            except OSError:
                pass
            try:
                os.close(self._wake_write)
            except OSError:
                pass
            self._wake_write = -1
        self._status_known.wait()
        self._startup_decided.wait()
        if self._startup_aborting:
            return

        with self._callback_lock:
            delivered_status = self._status
        if delivered_status is None and not self._done.is_set():
            self._abandon_completion()
            self._drain_grace()
            self._finalize(exit_code)

        with self._lifecycle_lock:
            exact_dead = self._reap_group(False)
            self._reaped = True
            self._lifecycle_state = "reaped"
            cast("_winjob.JobProcess", self._proc).close()
            if exact_dead:
                _retire_journal(
                    self._pid,
                    self._journal_process_start_id,
                    exact_death_proven=True,
                    windows_tree_empty_proven=True,
                )
        with _live_lock:
            _live_handles.discard(self)

    def _watch_posix(self) -> None:
        self._proc.wait()
        with self._lifecycle_lock:
            self._leader_reaped = True
        self._startup_decided.wait()
        self._protocol_terminal.wait()
        if not self._startup_aborting and not self._done.is_set():
            # A trusted completion receipt is the only target-status authority.
            # Protocol loss returns an internal failure, never the supervisor's
            # possibly cleanup-induced process status as target status.
            self._finalize(127)
        self._finish_posix_reap()

    def _finish_posix_reap(self) -> None:
        with self._lifecycle_lock:
            if self._reaped:
                return
            self._leader_reaped = True
            self._reaped = True
            self._lifecycle_state = "reaped" if self._group_empty_proven else "retained"
            control, self._control_sock = self._control_sock, None
            if control is not None:
                try:
                    control.close()
                except OSError:
                    pass
            if self._group_empty_proven and self._journal_enrolled:
                _retire_journal(
                    self._pid,
                    self._journal_process_start_id,
                    exact_death_proven=True,
                )
        with _live_lock:
            _live_handles.discard(self)

    def _reap_group(self, spawned_posix: bool | None = None) -> bool:
        # POSIX group death is attested by the still-leading supervisor. Once
        # wait() has reaped that leader, this host never signals the numeric pgid.
        posix = _IS_POSIX if spawned_posix is None else spawned_posix
        if posix:
            return self._group_empty_proven
        if self._job is not None:
            job, self._job = self._job, None
            terminated = _winjob.terminate(job)
            if not terminated:
                _taskkill_tree(self._pid)
            exact_dead = _wait_windows_job_empty(job, 2.0)
            _winjob.close(job)
            return exact_dead
        _taskkill_tree(self._pid)
        return False

    def _read_status(self) -> int | None:
        if self._status_read < 0:
            return None
        try:
            # DefaultSelector (kqueue/epoll) instead of select(): select() rejects
            # fds >= FD_SETSIZE (1024) even when the process fd limit is higher.
            with selectors.DefaultSelector() as sel:
                sel.register(self._status_read, selectors.EVENT_READ)
                sel.register(self._wake_read, selectors.EVENT_READ)
                line = b""
                while b"\n" not in line:
                    ready = {key.fd for key, _ in sel.select()}
                    # Prefer status bytes: any status write happens before shell exit,
                    # so it is already readable whenever the wake fd fires.
                    if self._status_read not in ready:
                        break  # shell died without writing a status
                    chunk = os.read(self._status_read, 64)
                    if not chunk:
                        break  # EOF without a full status line
                    line += chunk
            return int(line)
        except (OSError, ValueError):
            return None
        finally:
            for fd_name in ("_status_read", "_wake_read"):
                fd = cast(int, getattr(self, fd_name))
                if fd >= 0:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                    setattr(self, fd_name, -1)

    def _drain_grace(self) -> None:
        # Best-effort fallback when process exit/EOF arrives without a sentinel.
        deadline = time.monotonic() + 0.5
        size = self._buffer.size()
        while time.monotonic() < deadline:
            if self._eof.wait(0.05):
                return
            # A chunk between pipe read and buffer commit (transfer flag) is
            # invisible to both FIONREAD and the buffer size; wait it out.
            if self._pipe_pending() or self._pump_transfer:
                size = self._buffer.size()
                continue
            current = self._buffer.size()
            if current == size:
                return
            size = current

    def _pipe_pending(self) -> bool:
        # POSIX only: FIONREAD on the capture pipe; Windows keeps the
        # quiescence heuristic (best-effort parity).
        if not self._spawned_posix or self._eof.is_set():
            return False
        stdout = self._proc.stdout
        if stdout is None:
            return False
        try:
            pending = struct.unpack("i", fcntl.ioctl(stdout.fileno(), termios.FIONREAD, struct.pack("i", 0)))[0]
        except (OSError, ValueError):
            return False
        return pending > 0

    def _finalize(self, exit_code: int, output: str | None = None) -> None:
        with self._callback_lock:
            if self._done.is_set():
                return
            self._result = BashResult(
                exit_code=exit_code,
                output=self._buffer.text() if output is None else output,
                duration=time.monotonic() - self._started,
            )
            self._done.set()
            callbacks = self._callbacks
            self._callbacks = []
        for callback in callbacks:
            callback()

    def _add_done_callback(self, callback: Callable[[], None]) -> None:
        with self._callback_lock:
            if not self._done.is_set():
                self._callbacks.append(callback)
                return
        callback()

    async def _wait(self) -> BashResult:
        # Asyncio-native wakeup: no executor thread is parked for the command's
        # duration, so many concurrent awaits cannot exhaust the default pool.
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[None] = loop.create_future()

        def _wake() -> None:
            try:
                loop.call_soon_threadsafe(lambda: fut.done() or fut.set_result(None))
            except RuntimeError:
                pass  # awaiting loop already closed

        self._add_done_callback(_wake)
        await fut
        assert self._result is not None
        return self._result

    async def _wait_owned(self) -> BashResult:
        # One-shot `await bash(cmd)` owns the process: a cancelled await (e.g.
        # a kernel interrupt) must not leave the command running. TERM, bounded
        # grace, group KILL, then a bounded confirmed-exit wait before the
        # CancelledError propagates, so no side effect can land after it.
        try:
            return await self._wait()
        except asyncio.CancelledError:
            # Signal synchronously first: even if the cleanup awaits below are
            # re-cancelled, TERM is already delivered and the escalation timer
            # armed. The confirm wait runs as a shielded task so repeated
            # cancels of this task cannot skip it (they re-raise into awaits
            # inside this except block); the loop re-awaits until it finishes
            # (the confirm coroutine itself is bounded).
            self.kill(grace=_CANCEL_TERM_GRACE)
            confirm = asyncio.ensure_future(self._confirm_group_exit())
            while not confirm.done():
                try:
                    await asyncio.shield(confirm)
                except asyncio.CancelledError:
                    continue
            raise

    async def _confirm_group_exit(self) -> None:
        if not await self._await_group_death(_CANCEL_TERM_GRACE):
            if self._spawned_posix:
                self._force_kill()
            else:
                await asyncio.to_thread(self.kill)
            await self._await_group_death(_CANCEL_KILL_WAIT)

    def _group_alive(self) -> bool:
        if self._spawned_posix and _IS_POSIX:
            with self._lifecycle_lock:
                return self._lifecycle_state != "reaped"
        job = self._job
        if job is not None:
            empty = _winjob.is_empty(job)
            if empty is not None:
                return not empty
        return self._proc.poll() is None

    async def _await_group_death(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while self._group_alive():
            if time.monotonic() >= deadline:
                return False
            await asyncio.sleep(0.02)
        return True

    def _abort_spawn(self, started_threads: list[threading.Thread] | None = None) -> None:
        if self._spawned_posix:
            self._abort_spawn_posix(started_threads)
            return
        self._startup_aborting = True
        windows_tree_empty = False
        with self._lifecycle_lock:
            self._lifecycle_state = "aborting"
            if self._job is not None:
                job, self._job = self._job, None
                terminated = _winjob.terminate(job)
                if not terminated:
                    _taskkill_tree(self._pid)
                windows_tree_empty = _wait_windows_job_empty(job, 2.0)
                _winjob.close(job)
            if not windows_tree_empty:
                try:
                    self._proc.kill()
                except OSError:
                    pass
        self._startup_decided.set()
        started = started_threads or []
        process_reaped = False
        try:
            self._proc.wait(timeout=5)
            process_reaped = True
        except (OSError, subprocess.SubprocessError):
            try:
                self._proc.kill()
                self._proc.wait(timeout=2)
                process_reaped = True
            except (OSError, subprocess.SubprocessError):
                pass

        for thread in started:
            if thread is not threading.current_thread():
                thread.join(timeout=5)
        for fd_name in ("_status_read", "_wake_read", "_wake_write"):
            fd = cast(int, getattr(self, fd_name))
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
                setattr(self, fd_name, -1)
        if self._proc.stdout is not None:
            try:
                self._proc.stdout.close()
            except (OSError, ValueError):
                pass
        for thread in started:
            if thread is not threading.current_thread() and thread.is_alive():
                thread.join(timeout=1)

        with self._lifecycle_lock:
            self._leader_reaped = process_reaped
            self._group_empty_proven = windows_tree_empty
            self._reaped = process_reaped
            self._lifecycle_state = "reaped" if process_reaped else "aborting"
            if process_reaped:
                cast("_winjob.JobProcess", self._proc).close()
            if windows_tree_empty and self._journal_enrolled:
                _retire_journal(
                    self._pid,
                    self._journal_process_start_id,
                    exact_death_proven=True,
                    windows_tree_empty_proven=True,
                )
        with _live_lock:
            _live_handles.discard(self)

    def _abort_spawn_posix(self, started_threads: list[threading.Thread] | None) -> None:
        self._startup_aborting = True
        with self._lifecycle_lock:
            self._lifecycle_state = "aborting"
            delivered = False
            if self._release_sent and self._target_pid is not None:
                delivered = self._send_supervisor_signal_locked(signal.SIGKILL)
            if not delivered:
                control = self._control_sock
                if control is not None:
                    try:
                        control.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
        self._startup_decided.set()
        self._startup_receipt_ready.set()
        process_reaped = False
        try:
            self._proc.wait(timeout=5)
            process_reaped = True
        except (OSError, subprocess.SubprocessError):
            # Never signal the numeric leader/PGID here. The live supervisor or
            # its escaped helper retains the only post-release kill authority.
            pass
        if process_reaped:
            with self._lifecycle_lock:
                self._leader_reaped = True

        started = started_threads or []
        if not self._pump_started:
            self._drain_posix_control_without_pump()
        else:
            self._protocol_terminal.wait(5)
        for thread in started:
            if thread is not threading.current_thread():
                thread.join(timeout=5)

        if process_reaped and self._protocol_terminal.is_set():
            self._finish_posix_reap()
        elif process_reaped:
            with self._lifecycle_lock:
                self._reaped = True
                self._lifecycle_state = "retained"
            with _live_lock:
                _live_handles.discard(self)

    def _drain_posix_control_without_pump(self) -> None:
        control = self._control_sock
        if control is None:
            self._protocol_terminal.set()
            return
        while True:
            try:
                packet = _read_supervisor_packet_timeout(control, 0.2)
            except TimeoutError:
                return
            except BaseException as exc:
                self._record_posix_protocol_error(
                    exc if isinstance(exc, RuntimeError) else RuntimeError(str(exc))
                )
                self._protocol_terminal.set()
                return
            if packet is None:
                self._protocol_terminal.set()
                return
            kind, data = packet
            try:
                if kind == _SUPERVISOR_PACKET_OUTPUT:
                    self._buffer.write(data)
                    continue
                if kind != _SUPERVISOR_PACKET_JSON:
                    raise RuntimeError("bash(): trusted supervisor sent an invalid packet type")
                payload = json.loads(data)
                if not isinstance(payload, dict):
                    raise RuntimeError("bash(): trusted supervisor frame must be an object")
                self._accept_supervisor_frame(payload)
            except BaseException as exc:
                self._record_posix_protocol_error(
                    exc if isinstance(exc, RuntimeError) else RuntimeError(str(exc))
                )
                self._protocol_terminal.set()
                return

    def __await__(self) -> Generator[Any, None, BashResult]:
        # A handle awaited before any other API use is a one-shot command tied
        # to the await (kill-on-cancel); touching the handle API first marks it
        # as a deliberate background handle whose awaits only wait.
        if self._released:
            return self._wait().__await__()
        self._released = True
        return self._wait_owned().__await__()

    def __repr__(self) -> str:
        state = f"exit_code={self._result.exit_code}" if self._result else "running"
        return f"<BashHandle pid={self._pid} {state} command={self.command!r}>"


def bash(command: str) -> BashHandle:
    """Start a shell command immediately; await the handle for the result.

    `await bash(cmd)` is a one-shot: cancelling the await (e.g. an interrupt)
    kills the command's process group. `h = bash(cmd)` used as a background
    handle (any .pid/.running/.output()/.tail()/.poll()/.kill() access before
    the first await) survives cancellation; awaiting it only waits. Leak
    containment is per-platform: an isolated, journal-enrolled process-group
    supervisor on POSIX; a kill-on-close job object on Windows entered while
    the child is still suspended. bash() raises before user code when either
    containment path cannot be established.
    On POSIX, the trusted supervisor frames raw target output and its own
    target-exit receipt on one private ordered stream. Bytes that arrive after
    that receipt (for example from an admitted background job) stay visible via
    handle.output()/tail() but are not in BashResult.output.

    This is lifecycle containment, not a same-user sandbox. Deliberately killing
    the Prime host/supervisor or escaping the admitted group with setsid/setpgid
    is outside the contract.
    """
    if not isinstance(command, str) or not command:
        raise TypeError("command must be a non-empty str")
    _install_shutdown_hook()
    return BashHandle(command)


def _shell() -> str:
    # Read per call so env changes made in the REPL apply to later commands.
    override = os.environ.get("PRIME_AGENT_BASH_SHELL")
    if override:
        if not os.path.isabs(override):
            raise ValueError("PRIME_AGENT_BASH_SHELL must be an absolute path")
        return override
    if not _IS_POSIX:
        # Never consult PATH on Windows: a repo-controlled PATH could supply
        # the shell. The host injects PRIME_AGENT_BASH_SHELL when one exists.
        raise RuntimeError(
            "bash() needs PRIME_AGENT_BASH_SHELL set to the absolute path of a "
            "POSIX shell on Windows (e.g. install Git Bash in its default "
            "location so the host injects it)"
        )
    # PATH fallback only serves bare/standalone POSIX runtime use: the host
    # always injects PRIME_AGENT_BASH_SHELL (an absolute path) when a shell exists.
    shell = shutil.which("bash")
    return shell or "/bin/sh"


def _with_prefix(command: str) -> str:
    prefix = os.environ.get("PRIME_AGENT_BASH_COMMAND_PREFIX")
    return f"{prefix}\n{command}" if prefix else command


def _supervisor_path() -> str:
    return os.path.realpath(os.path.join(os.path.dirname(__file__), "_bash_supervisor.py"))


def _supervisor_argv(control_fd: int, owner_token: str) -> list[str]:
    if _JOURNAL_WRITE_LOCK_TOKEN.fullmatch(owner_token) is None:
        raise RuntimeError("bash(): invalid supervisor owner token")
    executable = os.path.realpath(sys.executable)
    if not os.path.isabs(executable):
        raise RuntimeError("bash(): Python executable must be absolute")
    return [
        executable,
        "-I",
        "-S",
        _supervisor_path(),
        "--control-fd",
        str(control_fd),
        f"{_PROCESS_IDENTITY_OWNER_TOKEN_PREFIX}{owner_token}",
        f"protocol={_SUPERVISOR_PROTOCOL}",
    ]


def _bootstrap_env() -> dict[str, str]:
    # The dynamic loader sees this environment before isolated Python starts.
    # Build it from literals, rather than trying to deny-list ambient injection.
    return {"LC_ALL": "C", "LANG": "C", "PATH": os.defpath}


def _send_supervisor_packet(control: socket.socket, kind: int, data: bytes) -> None:
    if kind not in {_SUPERVISOR_PACKET_JSON, _SUPERVISOR_PACKET_OUTPUT}:
        raise RuntimeError("bash(): invalid supervisor packet type")
    if len(data) > _SUPERVISOR_MAX_FRAME:
        raise RuntimeError("bash(): supervisor packet is too large")
    control.sendall(_SUPERVISOR_PACKET_HEADER.pack(kind, len(data)) + data)


def _send_control_frame(control: socket.socket, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, separators=(",", ":")).encode()
    if not data:
        raise RuntimeError("bash(): supervisor control frame is empty")
    _send_supervisor_packet(control, _SUPERVISOR_PACKET_JSON, data)


def _recv_supervisor_exact(control: socket.socket, size: int) -> bytes | None:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = control.recv(remaining)
        if not chunk:
            if chunks:
                raise RuntimeError("bash(): trusted supervisor closed a partial packet")
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _recv_supervisor_packet(control: socket.socket) -> tuple[int, bytes] | None:
    header = _recv_supervisor_exact(control, _SUPERVISOR_PACKET_HEADER.size)
    if header is None:
        return None
    kind, size = _SUPERVISOR_PACKET_HEADER.unpack(header)
    if kind not in {_SUPERVISOR_PACKET_JSON, _SUPERVISOR_PACKET_OUTPUT} or size > _SUPERVISOR_MAX_FRAME:
        raise RuntimeError("bash(): trusted supervisor sent an invalid packet header")
    data = _recv_supervisor_exact(control, size)
    if data is None and size:
        raise RuntimeError("bash(): trusted supervisor closed a partial packet")
    return kind, data or b""


def _read_supervisor_packet_timeout(
    control: socket.socket, timeout: float
) -> tuple[int, bytes] | None:
    deadline = time.monotonic() + timeout

    def read_exact(size: int) -> bytes | None:
        chunks: list[bytes] = []
        remaining = size
        with selectors.DefaultSelector() as selector:
            selector.register(control, selectors.EVENT_READ)
            while remaining:
                wait = deadline - time.monotonic()
                if wait <= 0 or not selector.select(wait):
                    raise TimeoutError
                try:
                    chunk = control.recv(remaining)
                except (BlockingIOError, InterruptedError):
                    continue
                if not chunk:
                    if chunks:
                        raise RuntimeError("bash(): trusted supervisor closed a partial packet")
                    return None
                chunks.append(chunk)
                remaining -= len(chunk)
        return b"".join(chunks)

    header = read_exact(_SUPERVISOR_PACKET_HEADER.size)
    if header is None:
        return None
    kind, size = _SUPERVISOR_PACKET_HEADER.unpack(header)
    if kind not in {_SUPERVISOR_PACKET_JSON, _SUPERVISOR_PACKET_OUTPUT} or size > _SUPERVISOR_MAX_FRAME:
        raise RuntimeError("bash(): trusted supervisor sent an invalid packet header")
    data = read_exact(size)
    if data is None and size:
        raise RuntimeError("bash(): trusted supervisor closed a partial packet")
    return kind, data or b""


def _try_read_supervisor_line(
    control: socket.socket | None, timeout: float = _SUPERVISOR_STARTUP_TIMEOUT
) -> dict[str, Any] | None:
    if control is None:
        return None
    try:
        packet = _read_supervisor_packet_timeout(control, timeout)
    except (OSError, RuntimeError, TimeoutError):
        return None
    if packet is None or packet[0] != _SUPERVISOR_PACKET_JSON:
        return None
    try:
        value = json.loads(packet[1])
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _read_supervisor_line(control: socket.socket | None) -> dict[str, Any]:
    value = _try_read_supervisor_line(control)
    if value is None:
        raise RuntimeError("bash(): trusted supervisor did not return a valid receipt")
    return value


def _validate_supervisor_ready(payload: dict[str, Any], pid: int, owner_token: str) -> None:
    expected = {
        "type": "ready",
        "protocol": _SUPERVISOR_PROTOCOL,
        "pid": pid,
        "pgid": pid,
        "sid": pid,
        "ownerToken": owner_token,
        "state": "gated",
    }
    if payload != expected:
        raise RuntimeError("bash(): trusted supervisor returned an invalid admission receipt")
    try:
        if os.getpgid(pid) != pid or os.getsid(pid) != pid:
            raise RuntimeError("bash(): trusted supervisor is not the process-group leader")
    except OSError as exc:
        raise RuntimeError("bash(): trusted supervisor disappeared during admission") from exc


def _supervisor_process_start_id(pid: int, owner_token: str) -> str | None:
    identity = _process_start_id(pid)
    if not _is_exact_process_identity(identity):
        return None
    if sys.platform == "darwin":
        expected = f"token:{owner_token}"
        return identity if identity == expected else None
    if sys.platform.startswith("linux"):
        return identity
    return None


def _child_env() -> dict[str, str]:
    env = {**os.environ, "NO_COLOR": "1", "TERM": "dumb", "CLICOLOR": "0", "FORCE_COLOR": "0"}
    env.pop(_JOURNAL_PATH_ENV, None)
    env.pop(_JOURNAL_GENERATION_ENV, None)
    env.pop(_KERNEL_ADMISSION_GENERATION_ENV, None)
    env.pop(_KERNEL_ADMISSION_PROTOCOL_ENV, None)
    env.pop(_KERNEL_LINEAGE_ENV, None)
    env.pop(_KERNEL_PID_ENV, None)
    env.pop(_KERNEL_PROCESS_START_ID_ENV, None)
    env.pop("PRIME_AGENT_KERNEL_OWNER_PID", None)
    for key in list(env):
        if key.startswith("PRIME_AGENT_INTERNAL_BASH_SUPERVISOR_"):
            env.pop(key, None)
    return env


def _wait_windows_job_empty(job: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        empty = _winjob.is_empty(job)
        if empty is True:
            return True
        if empty is None or time.monotonic() >= deadline:
            return False
        time.sleep(0.02)


def _system32(*parts: str) -> str:
    # Never trust ambient SystemRoot/PATH for privileged process helpers.
    return ntpath.join(r"C:\Windows", "System32", *parts)


def _helper_env() -> dict[str, str]:
    return {
        "SystemRoot": r"C:\Windows",
        "WINDIR": r"C:\Windows",
        "NoDefaultCurrentDirectoryInExePath": "1",
    }


def _taskkill_tree(pid: int) -> bool:
    # Windows has no process groups to signal; taskkill /T kills the whole tree.
    try:
        return (
            subprocess.run(
                [_system32("taskkill.exe"), "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2,
                env=_helper_env(),
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


_UINT64_MAX_DECIMAL = "18446744073709551615"


def _is_canonical_u64_decimal(value: str) -> bool:
    return (
        re.fullmatch(r"(?:0|[1-9][0-9]{0,19})", value) is not None
        and (len(value) < len(_UINT64_MAX_DECIMAL) or value <= _UINT64_MAX_DECIMAL)
    )


def _is_exact_process_identity(value: str | None) -> bool:
    if value is None:
        return False
    linux = _QUALIFIED_LINUX_PROCESS_IDENTITY.fullmatch(value)
    if linux is not None:
        return _is_canonical_u64_decimal(linux.group(2))
    return (
        _WINDOWS_PROCESS_IDENTITY.fullmatch(value) is not None
        or _TOKEN_PROCESS_IDENTITY.fullmatch(value) is not None
    )


def _project_legacy_process_identity(value: str | None) -> str | None:
    if not _is_exact_process_identity(value):
        return None
    assert value is not None
    linux = _QUALIFIED_LINUX_PROCESS_IDENTITY.fullmatch(value)
    if linux is not None:
        return f"proc:{linux.group(2)}"
    if _WINDOWS_PROCESS_IDENTITY.fullmatch(value) is not None:
        return value
    return None


def _is_legacy_process_identity(value: str | None) -> bool:
    if value is None:
        return False
    match = _LEGACY_PROCESS_IDENTITY.fullmatch(value)
    return match is not None and _is_canonical_u64_decimal(match.group(1))


def _normalize_portable_process_identity_hint(value: str | None) -> str | None:
    prefix = "ps:lstart:"
    if value is None or not value.startswith(prefix):
        return None
    payload = value[len(prefix) :]
    if (
        not payload
        or not payload.isascii()
        or any(ord(character) < 0x20 or ord(character) > 0x7E for character in payload)
        or len(payload.encode("ascii")) > 1024
    ):
        return None
    normalized = re.sub(r"[ \t\f\v]+", " ", payload.strip(" \t\f\v"))
    return f"{prefix}{normalized}" if normalized and normalized == payload else None


def _is_retained_coarse_process_identity(value: str | None) -> bool:
    prefix = "ps:"
    if value is None or not value.startswith(prefix):
        return False
    payload = value[len(prefix) :]
    if not payload or any(ord(character) < 0x20 or 0x7F <= ord(character) <= 0x9F for character in payload):
        return False
    try:
        return len(payload.encode("utf-8")) <= 1024
    except UnicodeError:
        return False


def _is_coarse_process_identity(value: str | None) -> bool:
    return value is not None and _normalize_portable_process_identity_hint(value) == value


def _process_identity_owner_token_from_command(command: str) -> str | None:
    if command.count(_PROCESS_IDENTITY_OWNER_TOKEN_PREFIX) != 1:
        return None
    pattern = re.compile(
        rf"(?:^|\s){re.escape(_PROCESS_IDENTITY_OWNER_TOKEN_PREFIX)}([0-9a-f]{{64}})(?=$|\s)"
    )
    matches = pattern.findall(command)
    return matches[0] if len(matches) == 1 else None


_cached_linux_boot_id: str | None = None


def _read_linux_identity_file(path: str, max_bytes: int = _JOURNAL_WRITE_LOCK_MAX_BYTES) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError("process identity path is not a regular file")
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining > 0:
            chunk = os.read(fd, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > max_bytes:
            raise OSError("process identity file is too large")
        return data
    finally:
        os.close(fd)


def _strict_ascii_identity_text(data: bytes, max_bytes: int = _JOURNAL_WRITE_LOCK_MAX_BYTES) -> str | None:
    if len(data) > max_bytes or any(byte > 0x7F for byte in data):
        return None
    try:
        return data.decode("ascii")
    except UnicodeDecodeError:
        return None


def _parse_linux_boot_id(data: bytes) -> str | None:
    text = _strict_ascii_identity_text(data)
    if text is None:
        return None
    boot_id = text[:-1] if text.endswith("\n") else text
    if text not in {boot_id, f"{boot_id}\n"} or _LINUX_BOOT_ID.fullmatch(boot_id) is None:
        return None
    return boot_id


def _linux_boot_id() -> str | None:
    global _cached_linux_boot_id
    if _cached_linux_boot_id is not None:
        return _cached_linux_boot_id
    try:
        boot_id = _parse_linux_boot_id(_read_linux_identity_file("/proc/sys/kernel/random/boot_id"))
    except OSError:
        return None
    if boot_id is not None:
        _cached_linux_boot_id = boot_id
    return boot_id


def _parse_linux_process_start_ticks(pid: int, data: bytes) -> str | None:
    if len(data) > _JOURNAL_WRITE_LOCK_MAX_BYTES:
        return None
    if data.endswith(b"\n"):
        data = data[:-1]
    prefix = f"{pid} (".encode("ascii")
    if not data.startswith(prefix):
        return None
    command_end = data.rfind(b") ")
    if command_end < len(prefix):
        return None
    tail = data[command_end + 2 :]
    if any(byte > 0x7F or byte < 0x20 or byte == 0x7F for byte in tail):
        return None
    fields = tail.decode("ascii").split(" ")
    if len(fields) < 20 or any(not field for field in fields):
        return None
    ticks = fields[19]
    return ticks if _is_canonical_u64_decimal(ticks) else None


def _process_start_id(pid: int) -> str | None:
    if os.name == "nt":
        # Mirrors getWindowsProcessStartId in session-lease.ts byte-for-byte so
        # the host's identity comparison matches the journaled string.
        try:
            out = subprocess.run(
                [
                    _system32("WindowsPowerShell", "v1.0", "powershell.exe"),
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    f"([System.Diagnostics.Process]::GetProcessById({pid})).StartTime.ToUniversalTime().Ticks",
                ],
                capture_output=True,
                text=True,
                timeout=5,
                env=_helper_env(),
            ).stdout.strip()
            return f"win:{out}" if re.fullmatch(r"(?:0|[1-9][0-9]{0,31})", out) is not None else None
        except (OSError, subprocess.SubprocessError):
            return None
    if sys.platform.startswith("linux"):
        # The immutable boot authority is read (and safely cached) first. The
        # PID-specific stat read is last so a recycled PID cannot mix epochs.
        boot_id = _linux_boot_id()
        if boot_id is None:
            return None
        try:
            process_stat = _read_linux_identity_file(f"/proc/{pid}/stat")
        except OSError:
            return None
        start_ticks = _parse_linux_process_start_ticks(pid, process_stat)
        return f"proc:{boot_id}:{start_ticks}" if start_ticks is not None else None
    try:
        # macOS has no /proc. A parent-issued delimiter-bounded argv token is
        # exact; otherwise lstart is a scheme-tagged diagnostic hint only.
        ps = "/bin/ps" if sys.platform == "darwin" else "ps"
        if sys.platform == "darwin":
            command = subprocess.run(
                [ps, "-ww", "-o", "command=", "-p", str(pid)],
                capture_output=True,
                text=True,
                timeout=5,
                env=_bootstrap_env(),
            ).stdout
            if len(command.encode()) > _JOURNAL_WRITE_LOCK_MAX_BYTES or "\x00" in command:
                return None
            marker_count = command.count(_PROCESS_IDENTITY_OWNER_TOKEN_PREFIX)
            token = _process_identity_owner_token_from_command(command)
            if marker_count:
                return f"token:{token}" if token is not None else None
        raw_out = subprocess.run(
            [ps, "-p", str(pid), "-o", "lstart="],
            capture_output=True,
            text=True,
            timeout=5,
            env=_bootstrap_env(),
        ).stdout
        out = raw_out[:-1] if raw_out.endswith("\n") else raw_out
        if (
            not out
            or "\x00" in out
            or "\r" in out
            or "\n" in out
            or len(out.encode("utf-8")) > 1024
        ):
            return None
        normalized = re.sub(r"[ \t\f\v]+", " ", out.strip(" \t\f\v"))
        return _normalize_portable_process_identity_hint(f"ps:lstart:{normalized}")
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return None


def _process_identity_observation(pid: int) -> tuple[str, str | None]:
    presence = _pid_exists(pid)
    if presence is False:
        return "absent", None
    if presence is None:
        return "probe-uncertain", None
    identity = _process_start_id(pid)
    if _is_exact_process_identity(identity):
        return "present-exact", identity
    if _is_coarse_process_identity(identity):
        return "present-coarse", identity
    # The process may have exited during the identity query. Only a fresh
    # absence converts that race into exact-dead proof.
    presence = _pid_exists(pid)
    if presence is False:
        return "absent", None
    if presence is None:
        return "probe-uncertain", None
    return "present-unknown", None


def _journal_process_group_presence(
    pid: int, *, platform: str | None = None, killpg: Callable[[int, int], None] | None = None
) -> str:
    actual_platform = platform or ("win32" if os.name == "nt" else sys.platform)
    if actual_platform == "win32" or pid <= 0:
        return "unsupported"
    probe = killpg or os.killpg
    try:
        probe(pid, 0)
        return "present"
    except ProcessLookupError:
        return "absent"
    except PermissionError:
        return "present"
    except OSError:
        return "uncertain"


def _journal_candidate_cleanup_proven(
    pid: int,
    process_start_id: str | None,
    *,
    platform: str | None = None,
    identity_probe: Callable[[int], tuple[str, str | None]] | None = None,
    group_probe: Callable[[int], str] | None = None,
    windows_tree_empty_proven: bool = False,
) -> bool:
    actual_platform = platform or ("win32" if os.name == "nt" else sys.platform)
    if actual_platform == "win32":
        # Only the live owner of the held Job can make this same-operation
        # attestation. Leader death or taskkill delivery is never enough.
        return windows_tree_empty_proven
    identity = (identity_probe or _process_identity_observation)(pid)
    exact = _is_exact_process_identity(process_start_id)
    if not exact:
        group = (group_probe or _journal_process_group_presence)(pid)
        return identity[0] == "absent" and group == "absent"
    leader_gone = identity[0] == "absent" or (
        identity[0] == "present-exact" and identity[1] != process_start_id
    )
    if not leader_gone:
        return False
    group = (group_probe or _journal_process_group_presence)(pid)
    return group == "absent"


def _journal_candidate_signal_authorized(
    pid: int,
    process_start_id: str | None,
    *,
    caller_has_authority: bool,
    identity_probe: Callable[[int], tuple[str, str | None]] | None = None,
) -> bool:
    if not caller_has_authority or not _is_exact_process_identity(process_start_id):
        return False
    observation = (identity_probe or _process_identity_observation)(pid)
    return observation == ("present-exact", process_start_id)


def _read_fd_all(fd: int) -> bytes:
    os.lseek(fd, 0, os.SEEK_SET)
    chunks: list[bytes] = []
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


def _positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


_JournalCandidate = tuple[
    int,
    int,
    str | None,
    int | None,
    str | None,
    str | None,
    str | None,
]


def _strict_authority_state(
    path: str, data: bytes, *, include_candidates: bool = False
) -> tuple[str, int] | tuple[str, int, frozenset[_JournalCandidate]] | None:
    if data and not data.endswith(b"\n"):
        return None
    generation: str | None = None
    sequence: int | None = None
    header_seen = False
    candidates: set[_JournalCandidate] = set()
    try:
        for raw_line in data.splitlines():
            if not raw_line:
                continue
            record = json.loads(raw_line)
            if not isinstance(record, dict):
                return None
            if record.get("version") == 1:
                if header_seen:
                    return None
                pid = record.get("pid")
                owner_pid = record.get("ownerPid")
                kernel_pid = record.get("kernelPid")
                start_id = record.get("processStartId")
                if (
                    not _positive_int(pid)
                    or not _positive_int(owner_pid)
                    or (kernel_pid is not None and not _positive_int(kernel_pid))
                    or not isinstance(record.get("active"), bool)
                    or (
                        start_id is not None
                        and (
                            not isinstance(start_id, str)
                            or not (
                                _is_exact_process_identity(start_id)
                                or _is_legacy_process_identity(start_id)
                                or _is_retained_coarse_process_identity(start_id)
                            )
                        )
                    )
                    or not isinstance(record.get("recordedAt"), str)
                ):
                    return None
                assert isinstance(pid, int) and isinstance(owner_pid, int)
                candidate: _JournalCandidate = (
                    owner_pid,
                    pid,
                    start_id,
                    cast(int | None, kernel_pid),
                    None,
                    None,
                    None,
                )
                if record["active"]:
                    # PID-only and coarse legacy records are sticky anchors. A
                    # later enriched record is additional evidence, not a
                    # replacement for the earlier uncertainty.
                    candidates.add(candidate)
                elif not any(
                    candidate_owner == owner_pid and candidate_pid == pid
                    for candidate_owner, candidate_pid, *_ in candidates
                ):
                    return None
                continue
            if record.get("version") != 2:
                return None
            if record.get("type") == "authority":
                candidate_generation = record.get("generation")
                if (
                    header_seen
                    or not isinstance(candidate_generation, str)
                    or not candidate_generation
                    or record.get("sequence") != 0
                    or not isinstance(record.get("createdAt"), str)
                ):
                    return None
                header_seen = True
                generation = candidate_generation
                sequence = 0
                continue
            if record.get("type") != "process" or not header_seen or record.get("generation") != generation:
                return None
            pid = record.get("pid")
            owner_pid = record.get("ownerPid")
            kernel_pid = record.get("kernelPid")
            kernel_start_id = record.get("kernelProcessStartId")
            kernel_authority_start_id = record.get("kernelAuthorityProcessStartId")
            admission_generation = record.get("admissionGeneration")
            kernel_lineage = record.get("kernelLineage")
            start_id = record.get("processStartId")
            authority_start_id = record.get("authorityProcessStartId")
            state = record.get("state")
            record_sequence = record.get("sequence")
            if (
                not _positive_int(pid)
                or not _positive_int(owner_pid)
                or (kernel_pid is not None and not _positive_int(kernel_pid))
                or (
                    kernel_start_id is not None
                    and (not isinstance(kernel_start_id, str) or not kernel_start_id)
                )
                or (
                    kernel_authority_start_id is not None
                    and (
                        not isinstance(kernel_authority_start_id, str)
                        or not _is_exact_process_identity(kernel_authority_start_id)
                    )
                )
                or (
                    isinstance(kernel_authority_start_id, str)
                    and isinstance(kernel_start_id, str)
                    and _project_legacy_process_identity(kernel_authority_start_id) != kernel_start_id
                )
                or (
                    admission_generation is not None
                    and (
                        not isinstance(admission_generation, str)
                        or _KERNEL_ADMISSION_GENERATION.fullmatch(admission_generation) is None
                    )
                )
                or (
                    kernel_lineage is not None
                    and (
                        not isinstance(kernel_lineage, str)
                        or _KERNEL_LINEAGE.fullmatch(kernel_lineage) is None
                    )
                )
                or (start_id is not None and (not isinstance(start_id, str) or not start_id))
                or (
                    authority_start_id is not None
                    and (
                        not isinstance(authority_start_id, str)
                        or not _is_exact_process_identity(authority_start_id)
                    )
                )
                or (
                    isinstance(authority_start_id, str)
                    and isinstance(start_id, str)
                    and _project_legacy_process_identity(authority_start_id) != start_id
                )
                or (start_id is None and authority_start_id is None)
                or state not in {"enrolled", "retired"}
                or not _positive_int(record_sequence)
                or sequence is None
                or record_sequence != sequence + 1
                or not isinstance(record.get("recordedAt"), str)
            ):
                return None
            assert isinstance(pid, int) and isinstance(owner_pid, int) and isinstance(record_sequence, int)
            sequence = record_sequence
            effective_start_id = cast(str | None, authority_start_id or start_id)
            effective_kernel_start_id = cast(str | None, kernel_authority_start_id or kernel_start_id)
            key: _JournalCandidate = (
                owner_pid,
                pid,
                effective_start_id,
                cast(int | None, kernel_pid),
                effective_kernel_start_id,
                cast(str | None, admission_generation),
                cast(str | None, kernel_lineage),
            )
            if state == "enrolled":
                if key in candidates:
                    return None
                candidates.add(key)
            elif key not in candidates:
                return None
            else:
                candidates.remove(key)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if generation is None or sequence is None:
        return None
    if include_candidates:
        return generation, sequence, frozenset(candidates)
    return generation, sequence


def _parse_lock_timestamp(value: object) -> float | None:
    if not isinstance(value, str) or _UTC_ISO_TIMESTAMP.fullmatch(value) is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.timestamp()


def _accepted_journal_write_lock_token(value: object) -> bool:
    return isinstance(value, str) and (
        _JOURNAL_WRITE_LOCK_TOKEN.fullmatch(value) is not None
        or _LEGACY_JOURNAL_WRITE_LOCK_TOKEN.fullmatch(value) is not None
    )


def _journal_write_lock_record(data: bytes) -> dict[str, Any] | None:
    if len(data) > _JOURNAL_WRITE_LOCK_MAX_BYTES:
        return None
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    allowed_keys = {
        "version",
        "ownerPid",
        "processStartId",
        "processIdentityHint",
        "token",
        "createdAt",
        "expiresAt",
    }
    if not set(value).issubset(allowed_keys):
        return None
    start_id = value.get("processStartId")
    hint = value.get("processIdentityHint")
    if start_id is not None and hint is not None:
        return None
    if start_id is not None and not (
        isinstance(start_id, str)
        and (
            _is_exact_process_identity(start_id)
            or _is_legacy_process_identity(start_id)
            or _is_retained_coarse_process_identity(start_id)
        )
    ):
        return None
    if hint is not None and not (
        isinstance(hint, str) and _is_retained_coarse_process_identity(hint)
    ):
        return None
    if (
        value.get("version") != _JOURNAL_WRITE_LOCK_VERSION
        or not _positive_int(value.get("ownerPid"))
        or not _accepted_journal_write_lock_token(value.get("token"))
        or _parse_lock_timestamp(value.get("createdAt")) is None
        or _parse_lock_timestamp(value.get("expiresAt")) is None
    ):
        return None
    return value


def _nofollow_flag() -> int:
    return cast(int, getattr(os, "O_NOFOLLOW", 0))


def _read_fd_bounded(fd: int, max_bytes: int) -> bytes | None:
    os.lseek(fd, 0, os.SEEK_SET)
    chunks: list[bytes] = []
    total = 0
    while total <= max_bytes:
        chunk = os.read(fd, min(65536, max_bytes + 1 - total))
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
        total += len(chunk)
    return None


def _path_matches_identity(path: str, device: int, inode: int) -> bool:
    try:
        current = os.stat(path, follow_symlinks=False)
    except OSError:
        return False
    return (
        stat.S_ISREG(current.st_mode)
        and current.st_dev == device
        and current.st_ino == inode
    )


def _path_matches_open_file(path: str, fd: int) -> bool:
    try:
        opened = os.fstat(fd)
    except OSError:
        return False
    return stat.S_ISREG(opened.st_mode) and _path_matches_identity(
        path, opened.st_dev, opened.st_ino
    )


def _close_then_unlink_open_file(
    path: str, fd: int, *, expected: tuple[int, int] | None = None
) -> bool:
    identity: tuple[int, int] | None = None
    try:
        opened = os.fstat(fd)
        candidate = (opened.st_dev, opened.st_ino)
        if (
            stat.S_ISREG(opened.st_mode)
            and (expected is None or candidate == expected)
            and _path_matches_identity(path, *candidate)
        ):
            identity = candidate
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        return False
    if identity is None or not _path_matches_identity(path, *identity):
        return False
    try:
        os.unlink(path)
    except OSError:
        return False
    return True


@dataclass(frozen=True)
class _CanonicalJournalWriteLock:
    fd: int
    record: dict[str, Any]


def _open_canonical_journal_write_lock(path: str) -> _CanonicalJournalWriteLock | None:
    fd = -1
    try:
        fd = os.open(path, os.O_RDONLY | _nofollow_flag())
        if not _path_matches_open_file(path, fd):
            raise OSError("non-canonical lock")
        data = _read_fd_bounded(fd, _JOURNAL_WRITE_LOCK_MAX_BYTES)
        if data is None:
            raise OSError("oversized lock")
        record = _journal_write_lock_record(data)
        if record is None:
            raise OSError("invalid lock")
        return _CanonicalJournalWriteLock(fd, record)
    except OSError:
        if fd >= 0:
            os.close(fd)
        return None


def _close_canonical_journal_write_lock(lock: _CanonicalJournalWriteLock | None) -> None:
    if lock is not None:
        os.close(lock.fd)


def _read_journal_write_lock(path: str) -> dict[str, Any] | None:
    lock = _open_canonical_journal_write_lock(path)
    try:
        return None if lock is None else lock.record
    finally:
        _close_canonical_journal_write_lock(lock)


def _same_journal_write_lock(left: dict[str, Any], right: dict[str, Any]) -> bool:
    # Validation rejects unknown fields, so dict equality is full-record equality.
    return left == right


def _pid_exists(pid: int) -> bool | None:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None
    return True


def _journal_lock_owner_exact_dead(record: dict[str, Any]) -> bool:
    status, identity = _process_identity_observation(cast(int, record["ownerPid"]))
    if status == "absent":
        return True
    expected = cast(str | None, record.get("processStartId"))
    return (
        _is_exact_process_identity(expected)
        and status == "present-exact"
        and identity != expected
    )


def _process_identity_record_fields() -> dict[str, str]:
    identity = _process_start_id(os.getpid())
    if _is_exact_process_identity(identity):
        return {"processStartId": cast(str, identity)}
    if _is_coarse_process_identity(identity):
        return {"processIdentityHint": cast(str, identity)}
    return {}


def _write_fd_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short orphan journal lock write")
        view = view[written:]


def _secure_claims_directory(path: str) -> tuple[int, int] | None:
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    except OSError:
        return None
    try:
        current = os.stat(path, follow_symlinks=False)
    except OSError:
        return None
    if not stat.S_ISDIR(current.st_mode):
        return None
    if os.name != "nt" and stat.S_IMODE(current.st_mode) != 0o700:
        return None
    return current.st_dev, current.st_ino


def _same_secure_claims_directory(path: str, expected: tuple[int, int]) -> bool:
    try:
        current = os.stat(path, follow_symlinks=False)
    except OSError:
        return False
    return (
        stat.S_ISDIR(current.st_mode)
        and (current.st_dev, current.st_ino) == expected
        and (os.name == "nt" or stat.S_IMODE(current.st_mode) == 0o700)
    )


@dataclass(frozen=True)
class _JournalWriteLockRemovalClaim:
    fd: int
    path: str
    device: int
    inode: int


def _claim_journal_write_lock_removal(
    lock_path: str, old_record: dict[str, Any]
) -> _JournalWriteLockRemovalClaim | None:
    token = old_record.get("token")
    if not _accepted_journal_write_lock_token(token):
        return None
    claims_path = f"{lock_path}{_JOURNAL_WRITE_LOCK_CLAIMS_SUFFIX}"
    claims_identity = _secure_claims_directory(claims_path)
    if claims_identity is None:
        return None
    claim_path = os.path.join(claims_path, cast(str, token))
    fd = -1
    try:
        fd = os.open(
            claim_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _nofollow_flag(),
            0o600,
        )
        if os.name != "nt":
            os.fchmod(fd, 0o600)
        marker = {
            "version": 1,
            "type": "journal-lock-removal-claim",
            "lockRecord": old_record,
            "claimer": {
                "ownerPid": os.getpid(),
                **_process_identity_record_fields(),
                "token": secrets.token_hex(32),
                "createdAt": datetime.now(timezone.utc).isoformat(),
            },
        }
        _write_fd_all(fd, (json.dumps(marker, separators=(",", ":")) + "\n").encode())
        os.fsync(fd)
        opened = os.fstat(fd)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (os.name != "nt" and stat.S_IMODE(opened.st_mode) != 0o600)
            or not _same_secure_claims_directory(claims_path, claims_identity)
            or not _path_matches_open_file(claim_path, fd)
        ):
            raise OSError("unsafe orphan journal lock removal claim")
        return _JournalWriteLockRemovalClaim(fd, claim_path, opened.st_dev, opened.st_ino)
    except OSError:
        if fd >= 0:
            _close_then_unlink_open_file(claim_path, fd)
        return None


def _release_journal_write_lock_removal_claim(claim: _JournalWriteLockRemovalClaim) -> None:
    # Windows denies delete-sharing for these CRT descriptors. Close only after
    # recording and checking the per-token claim inode, then re-check the path.
    _close_then_unlink_open_file(
        claim.path,
        claim.fd,
        expected=(claim.device, claim.inode),
    )


@dataclass(frozen=True)
class _JournalWriteLockCandidate:
    fd: int
    path: str
    record: dict[str, Any]


def _safe_remove_journal_write_lock_candidate(candidate: _JournalWriteLockCandidate) -> None:
    _close_then_unlink_open_file(candidate.path, candidate.fd)


def _create_journal_write_lock_candidate(lock_path: str) -> _JournalWriteLockCandidate | None:
    token = secrets.token_hex(32)
    now = datetime.now(timezone.utc)
    record: dict[str, Any] = {
        "version": _JOURNAL_WRITE_LOCK_VERSION,
        "ownerPid": os.getpid(),
        **_process_identity_record_fields(),
        "token": token,
        "createdAt": now.isoformat(),
        "expiresAt": datetime.fromtimestamp(
            now.timestamp() + _JOURNAL_WRITE_LOCK_LEASE, timezone.utc
        ).isoformat(),
    }
    candidate_path = f"{lock_path}.candidate-{os.getpid()}-{token}"
    fd = -1
    try:
        fd = os.open(
            candidate_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _nofollow_flag(),
            0o600,
        )
        if os.name != "nt":
            os.fchmod(fd, 0o600)
        _write_fd_all(fd, (json.dumps(record, separators=(",", ":")) + "\n").encode())
        os.fsync(fd)
        return _JournalWriteLockCandidate(fd, candidate_path, record)
    except OSError:
        if fd >= 0:
            _close_then_unlink_open_file(candidate_path, fd)
        return None


def _reclaim_expired_dead_journal_write_lock(
    path: str, candidate: _JournalWriteLockCandidate
) -> str:
    observed = _read_journal_write_lock(path)
    if observed is None:
        return "not-reclaimed"
    expires_at = _parse_lock_timestamp(observed.get("expiresAt"))
    if (
        expires_at is None
        or expires_at > time.time()
        or not _journal_lock_owner_exact_dead(observed)
    ):
        return "not-reclaimed"
    claim = _claim_journal_write_lock_removal(path, observed)
    if claim is None:
        return "not-reclaimed"
    confirmed: _CanonicalJournalWriteLock | None = None
    try:
        confirmed = _open_canonical_journal_write_lock(path)
        if confirmed is None:
            return "not-reclaimed"
        confirmed_expiry = _parse_lock_timestamp(confirmed.record.get("expiresAt"))
        if (
            not _same_journal_write_lock(confirmed.record, observed)
            or confirmed_expiry is None
            or confirmed_expiry > time.time()
            or not _journal_lock_owner_exact_dead(confirmed.record)
            or not _path_matches_open_file(path, confirmed.fd)
        ):
            return "not-reclaimed"
        opened = os.fstat(confirmed.fd)
        identity = (opened.st_dev, opened.st_ino)
        _close_canonical_journal_write_lock(confirmed)
        confirmed = None
        latest = _read_journal_write_lock(path)
        if (
            latest is None
            or not _same_journal_write_lock(latest, observed)
            or not _path_matches_identity(path, *identity)
            or not _journal_lock_owner_exact_dead(latest)
        ):
            return "not-reclaimed"
        # All read descriptors are closed before unlink for Windows. The
        # unguessable per-token claim remains the deletion capability.
        os.unlink(path)
        try:
            os.link(candidate.path, path)
            return "acquired"
        except FileExistsError:
            return "reclaimed"
    finally:
        _close_canonical_journal_write_lock(confirmed)
        _release_journal_write_lock_removal_claim(claim)


def _acquire_journal_write_lock(path: str) -> tuple[str, dict[str, Any]] | None:
    lock_path = f"{path}{_JOURNAL_WRITE_LOCK_SUFFIX}"
    if _secure_claims_directory(f"{lock_path}{_JOURNAL_WRITE_LOCK_CLAIMS_SUFFIX}") is None:
        return None
    candidate = _create_journal_write_lock_candidate(lock_path)
    if candidate is None:
        return None
    deadline = time.monotonic() + _JOURNAL_WRITE_LOCK_TIMEOUT
    while True:
        try:
            os.link(candidate.path, lock_path)
        except FileExistsError:
            try:
                reclaimed = _reclaim_expired_dead_journal_write_lock(lock_path, candidate)
            except OSError:
                _safe_remove_journal_write_lock_candidate(candidate)
                return None
            if reclaimed == "acquired":
                _safe_remove_journal_write_lock_candidate(candidate)
                return lock_path, candidate.record
            if time.monotonic() >= deadline:
                _safe_remove_journal_write_lock_candidate(candidate)
                return None
            time.sleep(0.01)
            continue
        except OSError:
            _safe_remove_journal_write_lock_candidate(candidate)
            return None
        _safe_remove_journal_write_lock_candidate(candidate)
        return lock_path, candidate.record


def _release_journal_write_lock(lock: tuple[str, dict[str, Any]]) -> None:
    lock_path, record = lock
    claim = _claim_journal_write_lock_removal(lock_path, record)
    if claim is None:
        return
    current: _CanonicalJournalWriteLock | None = None
    try:
        current = _open_canonical_journal_write_lock(lock_path)
        if current is None:
            return
        if not (
            _same_journal_write_lock(current.record, record)
            and _path_matches_open_file(lock_path, current.fd)
        ):
            return
        opened = os.fstat(current.fd)
        identity = (opened.st_dev, opened.st_ino)
        _close_canonical_journal_write_lock(current)
        current = None
        latest = _read_journal_write_lock(lock_path)
        if (
            latest is None
            or not _same_journal_write_lock(latest, record)
            or not _path_matches_identity(lock_path, *identity)
        ):
            return
        os.unlink(lock_path)
    except OSError:
        pass
    finally:
        _close_canonical_journal_write_lock(current)
        _release_journal_write_lock_removal_claim(claim)


def _opened_path_is_current(fd: int, path: str) -> bool:
    try:
        opened = os.fstat(fd)
        current = os.stat(path, follow_symlinks=False)
    except OSError:
        return False
    return (
        opened.st_dev == current.st_dev
        and opened.st_ino == current.st_ino
        and opened.st_size == current.st_size
    )


def _configured_kernel_lineage() -> tuple[int, str, str, str] | None:
    admission_protocol = os.environ.get(_KERNEL_ADMISSION_PROTOCOL_ENV)
    admission_generation = os.environ.get(_KERNEL_ADMISSION_GENERATION_ENV)
    kernel_lineage = os.environ.get(_KERNEL_LINEAGE_ENV)
    configured_pid = os.environ.get(_KERNEL_PID_ENV)
    configured_start_id = os.environ.get(_KERNEL_PROCESS_START_ID_ENV)
    if all(
        value is None
        for value in (
            admission_protocol,
            admission_generation,
            kernel_lineage,
            configured_pid,
            configured_start_id,
        )
    ):
        return None
    if (
        admission_protocol != _KERNEL_ADMISSION_PROTOCOL_VERSION
        or not admission_generation
        or _KERNEL_ADMISSION_GENERATION.fullmatch(admission_generation) is None
        or not kernel_lineage
        or _KERNEL_LINEAGE.fullmatch(kernel_lineage) is None
        or (configured_pid is None) != (configured_start_id is None)
    ):
        return None
    kernel_pid = os.getpid()
    if configured_pid is not None:
        try:
            if int(configured_pid) != kernel_pid:
                return None
        except ValueError:
            return None
        kernel_process_start_id = configured_start_id
    else:
        kernel_process_start_id = _process_start_id(kernel_pid)
    if not _is_exact_process_identity(kernel_process_start_id):
        return None
    return (
        kernel_pid,
        cast(str, kernel_process_start_id),
        admission_generation,
        kernel_lineage,
    )


def _journal_identity_record_fields(
    value: str,
    legacy_field: str,
    authority_field: str,
) -> dict[str, str]:
    if not _is_exact_process_identity(value):
        return {legacy_field: value}
    legacy = _project_legacy_process_identity(value)
    return {
        **({legacy_field: legacy} if legacy == value else {}),
        authority_field: value,
    }


def _record_journal_transition(
    pid: int,
    state: str,
    *,
    expected_start_id: str | None = None,
    exact_death_proven: bool = False,
    windows_tree_empty_proven: bool = False,
) -> bool:
    """Append a generation-bound, globally sequenced journal transition.

    Configured writers open only an existing authority and fail closed on a
    missing, replaced, torn, malformed, or generation-mismatched file.
    """
    if state not in {"enrolled", "retired"}:
        return False
    active = state == "enrolled"
    path = os.environ.get(_JOURNAL_PATH_ENV)
    generation = os.environ.get(_JOURNAL_GENERATION_ENV)
    owner = os.environ.get("PRIME_AGENT_KERNEL_OWNER_PID")
    if path is None and generation is None:
        return True
    if not path or not generation or not owner:
        return False
    assert path is not None and generation is not None and owner is not None
    try:
        owner_pid = int(owner)
    except ValueError:
        return False
    if owner_pid <= 0:
        return False

    key = (owner_pid, pid)
    with _journal_lock:
        if active:
            lineage = _configured_kernel_lineage()
            if lineage is None:
                return False
            observed_start_id = _process_start_id(pid)
            if expected_start_id is not None:
                if (
                    not _is_exact_process_identity(expected_start_id)
                    or observed_start_id != expected_start_id
                ):
                    return False
                start_id = expected_start_id
            else:
                start_id = observed_start_id
                if not _is_exact_process_identity(start_id):
                    return False
            kernel_pid, kernel_process_start_id, admission_generation, kernel_lineage = lineage
        else:
            enrollment = _journal_enrollments.get(key)
            if enrollment is None:
                return False
            (
                start_id,
                kernel_pid,
                kernel_process_start_id,
                admission_generation,
                kernel_lineage,
            ) = enrollment
            if (
                expected_start_id is None
                or start_id != expected_start_id
                or not exact_death_proven
                or (not _IS_POSIX and not windows_tree_empty_proven)
            ):
                return False

        lock = _acquire_journal_write_lock(path)
        if lock is None:
            return False
        try:
            try:
                fd = os.open(path, os.O_RDWR | os.O_APPEND)
            except OSError:
                return False
            try:
                authority = _strict_authority_state(path, _read_fd_all(fd))
                if authority is None or authority[0] != generation:
                    return False
                if not _opened_path_is_current(fd, path):
                    return False
                record: dict[str, Any] = {
                    "version": 2,
                    "type": "process",
                    "generation": generation,
                    "sequence": authority[1] + 1,
                    "pid": pid,
                    "ownerPid": owner_pid,
                    "kernelPid": kernel_pid,
                    **_journal_identity_record_fields(
                        kernel_process_start_id,
                        "kernelProcessStartId",
                        "kernelAuthorityProcessStartId",
                    ),
                    "admissionGeneration": admission_generation,
                    "kernelLineage": kernel_lineage,
                    **_journal_identity_record_fields(
                        start_id,
                        "processStartId",
                        "authorityProcessStartId",
                    ),
                    "state": state,
                    "recordedAt": datetime.now(timezone.utc).isoformat(),
                }
                data = (json.dumps(record, separators=(",", ":")) + "\n").encode()
                view = memoryview(data)
                while view:
                    written = os.write(fd, view)
                    if written <= 0:
                        return False
                    view = view[written:]
                os.fsync(fd)
                if not _opened_path_is_current(fd, path):
                    return False
                try:
                    with open(path, "rb") as current_file:
                        confirmed = _strict_authority_state(path, current_file.read())
                except OSError:
                    return False
                if confirmed != (generation, record["sequence"]):
                    return False
            except OSError:
                return False
            finally:
                os.close(fd)
        finally:
            _release_journal_write_lock(lock)
        if active:
            _journal_enrollments[key] = (
                cast(str, start_id),
                kernel_pid,
                kernel_process_start_id,
                admission_generation,
                kernel_lineage,
            )
        else:
            _journal_enrollments.pop(key, None)
        return True


def _journal_enrollment_start_id(pid: int) -> str | None:
    owner = os.environ.get("PRIME_AGENT_KERNEL_OWNER_PID")
    try:
        owner_pid = int(owner or "")
    except ValueError:
        return None
    with _journal_lock:
        enrollment = _journal_enrollments.get((owner_pid, pid))
        return enrollment[0] if enrollment is not None else None


def _enroll_journal(pid: int, *, expected_start_id: str | None = None) -> bool:
    return _record_journal_transition(
        pid, "enrolled", expected_start_id=expected_start_id
    )


def _retire_journal(
    pid: int,
    process_start_id: str | None,
    *,
    exact_death_proven: bool,
    windows_tree_empty_proven: bool = False,
) -> bool:
    return _record_journal_transition(
        pid,
        "retired",
        expected_start_id=process_start_id,
        exact_death_proven=exact_death_proven,
        windows_tree_empty_proven=windows_tree_empty_proven,
    )


def _kill_live_handles() -> None:
    with _live_lock:
        handles = list(_live_handles)
    for handle in handles:
        if _IS_POSIX:
            with handle._lifecycle_lock:
                if handle._lifecycle_state in {"aborting", "reaped"}:
                    continue
                handle._lifecycle_state = "terminating"
                handle._send_supervisor_signal_locked(signal.SIGKILL)
        else:
            with handle._lifecycle_lock:
                if handle._reaped or handle._lifecycle_state == "reaped":
                    continue
                delivered = handle._job is not None and _winjob.terminate(handle._job)
                if not delivered:
                    delivered = _taskkill_tree(handle._pid)
                if not delivered:
                    try:
                        handle._proc.kill()
                    except OSError:
                        pass
        # Shutdown hooks signal only. A later canonical reaper retains authority
        # until it can observe exact child/tree death.


def _install_shutdown_hook() -> None:
    global _hook_installed
    with _hook_lock:
        if _hook_installed:
            return
        _hook_installed = True
    atexit.register(_kill_live_handles)
