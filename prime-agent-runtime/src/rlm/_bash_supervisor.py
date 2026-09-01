"""Trusted POSIX process-group supervisor for :mod:`rlm.bash`.

This file is executed directly with ``python -I -S``. Keep imports stdlib-only.
The containment contract is one exact session/group leader plus processes that
remain in that group. It is lifecycle containment, not a same-user sandbox.
"""

from __future__ import annotations

import json
import os
import re
import selectors
import signal
import socket
import struct
import subprocess
import sys
import time
from typing import Any, NoReturn

_OWNER_PREFIX = "prime-agent-owner-token="
_TOKEN = re.compile(r"^[0-9a-f]{64}$")
_PROTOCOL = 2
_PACKET_JSON = 1
_PACKET_OUTPUT = 2
_PACKET_HEADER = struct.Struct("!BQ")
_MAX_PACKET = 64 * 1024 * 1024
_POLL_INTERVAL = 0.02
_CLEANUP_RECEIPT_TIMEOUT = 0.5
_OUTPUT_CHUNK = 65536
_FORBIDDEN_TARGET_ENV = {
    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL",
    "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL_GENERATION",
    "PRIME_AGENT_KERNEL_OWNER_PID",
    "PRIME_AGENT_INTERNAL_BASH_SUPERVISOR_CONTROL_FD",
    "PRIME_AGENT_INTERNAL_BASH_SUPERVISOR_STATUS_FD",
    "PRIME_AGENT_INTERNAL_BASH_SUPERVISOR_OWNER_TOKEN",
}


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short supervisor write")
        view = view[written:]


def _send_packet(control: socket.socket, kind: int, data: bytes) -> None:
    if kind not in {_PACKET_JSON, _PACKET_OUTPUT} or len(data) > _MAX_PACKET:
        raise RuntimeError("invalid supervisor packet")
    control.sendall(_PACKET_HEADER.pack(kind, len(data)) + data)


def _send_json(control: socket.socket, payload: dict[str, Any]) -> None:
    _send_packet(control, _PACKET_JSON, json.dumps(payload, separators=(",", ":")).encode())


def _send_json_bounded(control: socket.socket, payload: dict[str, Any]) -> bool:
    """Send the pre-kill receipt without letting a stalled host delay cleanup."""
    try:
        previous_timeout = control.gettimeout()
    except OSError:
        return False
    try:
        control.settimeout(_CLEANUP_RECEIPT_TIMEOUT)
        _send_json(control, payload)
        return True
    except OSError:
        return False
    finally:
        try:
            control.settimeout(previous_timeout)
        except OSError:
            pass


def _recv_exact(control: socket.socket, size: int) -> bytes | None:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = control.recv(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _recv_packet(control: socket.socket) -> tuple[int, bytes] | None:
    header = _recv_exact(control, _PACKET_HEADER.size)
    if header is None:
        return None
    kind, size = _PACKET_HEADER.unpack(header)
    if kind not in {_PACKET_JSON, _PACKET_OUTPUT} or size > _MAX_PACKET:
        raise RuntimeError("invalid supervisor packet header")
    data = _recv_exact(control, size)
    return None if data is None else (kind, data)


def _recv_json(control: socket.socket) -> dict[str, Any] | None:
    packet = _recv_packet(control)
    if packet is None:
        return None
    kind, data = packet
    if kind != _PACKET_JSON:
        raise RuntimeError("host sent a non-control supervisor packet")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise RuntimeError("supervisor control packet must be an object")
    return value


def _parse_packets(buffer: bytearray) -> list[tuple[int, bytes]]:
    packets: list[tuple[int, bytes]] = []
    while len(buffer) >= _PACKET_HEADER.size:
        kind, size = _PACKET_HEADER.unpack(buffer[: _PACKET_HEADER.size])
        if kind not in {_PACKET_JSON, _PACKET_OUTPUT} or size > _MAX_PACKET:
            raise RuntimeError("invalid supervisor packet header")
        packet_size = _PACKET_HEADER.size + size
        if len(buffer) < packet_size:
            break
        data = bytes(buffer[_PACKET_HEADER.size : packet_size])
        del buffer[:packet_size]
        packets.append((kind, data))
    return packets


def _parse_args(argv: list[str]) -> tuple[int, str]:
    if len(argv) != 4 or argv[0] != "--control-fd":
        raise RuntimeError("invalid supervisor arguments")
    control_fd = int(argv[1])
    owner_argument = argv[2]
    if argv[3] != f"protocol={_PROTOCOL}" or not owner_argument.startswith(_OWNER_PREFIX):
        raise RuntimeError("invalid supervisor owner argument")
    owner_token = owner_argument[len(_OWNER_PREFIX) :]
    if _TOKEN.fullmatch(owner_token) is None or control_fd < 3:
        raise RuntimeError("invalid supervisor authority")
    return control_fd, owner_token


def _validated_release(
    payload: dict[str, Any], own_pid: int, owner_token: str
) -> tuple[str, str, str, dict[str, str], str]:
    if set(payload) != {
        "type",
        "protocol",
        "pid",
        "ownerToken",
        "controlToken",
        "shell",
        "script",
        "cwd",
        "env",
    }:
        raise RuntimeError("invalid supervisor release packet")
    if (
        payload.get("type") != "release"
        or payload.get("protocol") != _PROTOCOL
        or payload.get("pid") != own_pid
        or payload.get("ownerToken") != owner_token
    ):
        raise RuntimeError("invalid supervisor release authority")
    control_token = payload.get("controlToken")
    shell = payload.get("shell")
    script = payload.get("script")
    cwd = payload.get("cwd")
    env = payload.get("env")
    if not isinstance(control_token, str) or _TOKEN.fullmatch(control_token) is None:
        raise RuntimeError("invalid supervisor control token")
    if not isinstance(shell, str) or not shell or not os.path.isabs(shell):
        raise RuntimeError("invalid supervisor shell")
    if not isinstance(script, str) or not isinstance(cwd, str) or not os.path.isabs(cwd):
        raise RuntimeError("invalid supervisor target")
    if not isinstance(env, dict):
        raise RuntimeError("invalid supervisor environment")
    target_env: dict[str, str] = {}
    for key, value in env.items():
        if not isinstance(key, str) or not isinstance(value, str) or "\x00" in key or "\x00" in value:
            raise RuntimeError("invalid supervisor environment entry")
        if key in _FORBIDDEN_TARGET_ENV or key.startswith("PRIME_AGENT_INTERNAL_BASH_SUPERVISOR_"):
            raise RuntimeError("authority environment cannot enter the target")
        target_env[key] = value
    return shell, script, cwd, target_env, control_token


def _validated_signal(
    payload: dict[str, Any], own_pid: int, target_pid: int, control_token: str
) -> int:
    if set(payload) != {"type", "protocol", "pid", "targetPid", "token", "state", "signal"}:
        raise RuntimeError("invalid supervisor signal packet")
    if (
        payload.get("type") != "signal"
        or payload.get("protocol") != _PROTOCOL
        or payload.get("pid") != own_pid
        or payload.get("targetPid") != target_pid
        or payload.get("token") != control_token
        or payload.get("state") != "running"
    ):
        raise RuntimeError("invalid supervisor signal authority")
    requested = payload.get("signal")
    if (
        not isinstance(requested, int)
        or isinstance(requested, bool)
        or requested <= 0
        or requested >= signal.NSIG
    ):
        raise RuntimeError("invalid supervisor signal")
    if requested == signal.SIGSTOP:
        raise RuntimeError("SIGSTOP cannot preserve the anchored supervisor")
    return requested


def _linux_group_members(pgid: int, own_pid: int) -> set[int] | None:
    try:
        names = os.listdir("/proc")
    except OSError:
        return None
    members: set[int] = set()
    for name in names:
        if not name.isdigit():
            continue
        pid = int(name)
        if pid == own_pid:
            continue
        try:
            with open(f"/proc/{pid}/stat", "rb") as process_file:
                raw = process_file.read(16 * 1024 + 1)
            if len(raw) > 16 * 1024:
                return None
            close = raw.rindex(b")")
            fields = raw[close + 2 :].split()
            if len(fields) < 3:
                return None
            if int(fields[2]) == pgid:
                members.add(pid)
        except FileNotFoundError:
            continue
        except (PermissionError, ValueError, OSError):
            return None
    return members


def _ps_group_members(pgid: int, own_pid: int) -> set[int] | None:
    ps = "/bin/ps" if os.path.exists("/bin/ps") else "/usr/bin/ps"
    try:
        result = subprocess.run(
            [ps, "-axo", "pid=,pgid="],
            capture_output=True,
            text=True,
            timeout=2,
            env={"LC_ALL": "C", "LANG": "C", "PATH": "/usr/bin:/bin"},
            start_new_session=True,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0 or len(result.stdout.encode()) > 16 * 1024 * 1024:
        return None
    members: set[int] = set()
    try:
        for line in result.stdout.splitlines():
            fields = line.split()
            if len(fields) != 2:
                continue
            pid, candidate_pgid = map(int, fields)
            if candidate_pgid == pgid and pid != own_pid:
                members.add(pid)
    except ValueError:
        return None
    return members


def _group_members(pgid: int, own_pid: int) -> set[int] | None:
    if sys.platform.startswith("linux"):
        members = _linux_group_members(pgid, own_pid)
        if members is not None:
            return members
    return _ps_group_members(pgid, own_pid)


def _signal_anchored_group(pgid: int, requested: int) -> None:
    """Signal the one group still anchored by this exact live leader."""
    os.killpg(pgid, requested)


def _group_observably_absent(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return True
    except (PermissionError, OSError):
        return False
    return False


def _send_output(control: socket.socket, chunk: bytes) -> bool:
    try:
        _send_packet(control, _PACKET_OUTPUT, chunk)
    except OSError:
        return False
    return True


def _drain_output_nonblocking(control: socket.socket, fd: int) -> bool:
    while True:
        try:
            chunk = os.read(fd, _OUTPUT_CHUNK)
        except (BlockingIOError, InterruptedError):
            return False
        if not chunk:
            return True
        if not _send_output(control, chunk):
            raise BrokenPipeError("supervisor output control stream closed")


def _cleanup_helper_main(
    control: socket.socket,
    output_fd: int,
    ready_fd: int,
    go_fd: int,
    pgid: int,
    supervisor_pid: int,
    target_pid: int,
    control_token: str,
    reason: str,
    completion_sent: bool,
) -> NoReturn:
    try:
        os.setsid()
        _write_all(ready_fd, b"R")
    except BaseException:
        try:
            _write_all(ready_fd, b"E")
        except OSError:
            pass
        os._exit(126)
    try:
        os.close(ready_fd)
    except OSError:
        pass
    try:
        os.read(go_fd, 1)
    except OSError:
        pass
    finally:
        try:
            os.close(go_fd)
        except OSError:
            pass

    # The matching leader is still paused in the original group when this
    # atomic signal is issued. No member PID is inspected or signaled.
    while True:
        try:
            _signal_anchored_group(pgid, signal.SIGKILL)
            break
        except OSError:
            time.sleep(_POLL_INTERVAL)

    try:
        os.set_blocking(output_fd, True)
    except OSError:
        pass
    while True:
        try:
            chunk = os.read(output_fd, _OUTPUT_CHUNK)
        except InterruptedError:
            continue
        except OSError:
            break
        if not chunk:
            break
        _send_output(control, chunk)
    try:
        os.close(output_fd)
    except OSError:
        pass

    if not completion_sent:
        try:
            _send_json(
                control,
                {
                    "type": "target_complete",
                    "protocol": _PROTOCOL,
                    "pid": supervisor_pid,
                    "targetPid": target_pid,
                    "token": control_token,
                    "state": "target-complete",
                    "returncode": -signal.SIGKILL,
                    "forced": True,
                },
            )
        except OSError:
            pass

    while not _group_observably_absent(pgid):
        time.sleep(_POLL_INTERVAL)
    try:
        _send_json(
            control,
            {
                "type": "group_empty",
                "protocol": _PROTOCOL,
                "pid": supervisor_pid,
                "targetPid": target_pid,
                "token": control_token,
                "helperPid": os.getpid(),
                "state": "group-empty",
                "reason": reason,
            },
        )
    except OSError:
        pass
    try:
        control.close()
    except OSError:
        pass
    os._exit(0)


def _kill_anchored_group_without_proof(pgid: int) -> NoReturn:
    """Last-resort cleanup when no escaped observer can be established."""
    while True:
        try:
            _signal_anchored_group(pgid, signal.SIGKILL)
        except OSError:
            time.sleep(_POLL_INTERVAL)
            continue
        # SIGKILL includes this exact leader. Do not report group absence when
        # no outside helper exists to observe it after the leader dies.
        while True:
            signal.pause()


def _cleanup_and_never_return(
    control: socket.socket,
    output_fd: int,
    pgid: int,
    supervisor_pid: int,
    target_pid: int,
    control_token: str,
    reason: str,
    completion_sent: bool,
) -> NoReturn:
    """Fork a session-escaped killer, then keep the exact group anchor alive."""
    ready_read = ready_write = go_read = go_write = -1
    try:
        ready_read, ready_write = os.pipe()
        go_read, go_write = os.pipe()
        helper_pid = os.fork()
    except OSError:
        for fd in (ready_read, ready_write, go_read, go_write):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        _kill_anchored_group_without_proof(pgid)
    if helper_pid == 0:
        try:
            os.close(ready_read)
            os.close(go_write)
            _cleanup_helper_main(
                control,
                output_fd,
                ready_write,
                go_read,
                pgid,
                supervisor_pid,
                target_pid,
                control_token,
                reason,
                completion_sent,
            )
        finally:
            os._exit(126)

    os.close(ready_write)
    os.close(go_read)
    try:
        helper_ready = os.read(ready_read, 1)
    except OSError:
        helper_ready = b""
    finally:
        os.close(ready_read)
    if helper_ready != b"R":
        try:
            os.close(go_write)
        except OSError:
            pass
        try:
            os.waitpid(helper_pid, 0)
        except OSError:
            pass
        _kill_anchored_group_without_proof(pgid)
    _send_json_bounded(
        control,
        {
            "type": "cleanup_started",
            "protocol": _PROTOCOL,
            "pid": supervisor_pid,
            "targetPid": target_pid,
            "token": control_token,
            "helperPid": helper_pid,
            "state": "cleanup-started",
            "reason": reason,
            "completionPending": not completion_sent,
        },
    )
    helper_released = False
    try:
        _write_all(go_write, b"G")
        helper_released = True
    except OSError:
        pass
    finally:
        try:
            os.close(go_write)
        except OSError:
            pass
    if not helper_released:
        _kill_anchored_group_without_proof(pgid)
    try:
        os.close(output_fd)
    except OSError:
        pass
    try:
        control.close()
    except OSError:
        pass
    while True:
        signal.pause()


def _install_signal_handlers() -> None:
    def ignored(_signum: int, _frame: Any) -> None:
        return

    for caught in signal.valid_signals():
        if not isinstance(caught, int) or caught in {signal.SIGKILL, signal.SIGSTOP}:
            continue
        try:
            # A caught disposition resets to default across exec, unlike
            # SIG_IGN, so the configured target receives normal signals.
            signal.signal(caught, ignored)
        except (OSError, RuntimeError, ValueError):
            pass


def _target_exit(exit_code: int) -> NoReturn:
    if exit_code < 0:
        requested = -exit_code
        try:
            signal.signal(requested, signal.SIG_DFL)
            os.kill(os.getpid(), requested)
        except (OSError, ValueError):
            pass
        os._exit(128 + requested)
    os._exit(exit_code & 0xFF)


def _run(control: socket.socket, owner_token: str) -> int:
    own_pid = os.getpid()
    os.setsid()
    _install_signal_handlers()
    pgid = os.getpgrp()
    sid = os.getsid(0)
    if pgid != own_pid or sid != own_pid:
        raise RuntimeError("supervisor failed to become session and group leader")

    _send_json(
        control,
        {
            "type": "ready",
            "protocol": _PROTOCOL,
            "pid": own_pid,
            "pgid": pgid,
            "sid": sid,
            "ownerToken": owner_token,
            "state": "gated",
        },
    )
    release = _recv_json(control)
    if release is None:
        try:
            _send_json(
                control,
                {
                    "type": "group_empty",
                    "protocol": _PROTOCOL,
                    "pid": own_pid,
                    "targetPid": None,
                    "token": owner_token,
                    "helperPid": None,
                    "state": "group-empty",
                    "reason": "setup",
                },
            )
        except OSError:
            pass
        return 127
    shell, script, cwd, target_env, control_token = _validated_release(
        release, own_pid, owner_token
    )

    try:
        target = subprocess.Popen(
            [shell, "-c", script],
            cwd=cwd,
            env=target_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            close_fds=True,
        )
    except BaseException as exc:
        _send_json(
            control,
            {
                "type": "startup_error",
                "protocol": _PROTOCOL,
                "pid": own_pid,
                "targetPid": None,
                "token": control_token,
                "state": "setup-empty",
                "message": f"{type(exc).__name__}: {exc}",
            },
        )
        _send_json(
            control,
            {
                "type": "group_empty",
                "protocol": _PROTOCOL,
                "pid": own_pid,
                "targetPid": None,
                "token": control_token,
                "helperPid": None,
                "state": "group-empty",
                "reason": "setup",
            },
        )
        return 127

    stdout = target.stdout
    output_fd = -1
    completion_sent = False
    target_returncode: int | None = None
    selector: selectors.BaseSelector | None = None
    try:
        if stdout is None:
            raise RuntimeError("configured shell has no output channel")
        output_fd = stdout.fileno()
        os.set_blocking(output_fd, False)
        _send_json(
            control,
            {
                "type": "started",
                "protocol": _PROTOCOL,
                "pid": own_pid,
                "targetPid": target.pid,
                "token": control_token,
                "state": "running",
            },
        )
        selector = selectors.DefaultSelector()
        selector.register(control, selectors.EVENT_READ, "control")
        selector.register(output_fd, selectors.EVENT_READ, "output")
        control_buffer = bytearray()
        output_eof = False
        empty_scans = 0

        while True:
            cleanup_reason: str | None = None
            for key, _ in selector.select(_POLL_INTERVAL):
                if key.data == "output":
                    try:
                        output_eof = _drain_output_nonblocking(control, output_fd)
                    except BrokenPipeError:
                        cleanup_reason = "parent-eof"
                    if output_eof:
                        try:
                            selector.unregister(output_fd)
                        except (KeyError, ValueError):
                            pass
                else:
                    try:
                        chunk = control.recv(65536)
                    except (BlockingIOError, InterruptedError):
                        continue
                    if not chunk:
                        cleanup_reason = "parent-eof"
                    else:
                        control_buffer.extend(chunk)
                        for kind, data in _parse_packets(control_buffer):
                            if kind != _PACKET_JSON:
                                raise RuntimeError("host sent a non-control supervisor packet")
                            value = json.loads(data)
                            if not isinstance(value, dict):
                                raise RuntimeError("supervisor control packet must be an object")
                            requested = _validated_signal(
                                value, own_pid, target.pid, control_token
                            )
                            if requested == signal.SIGKILL:
                                cleanup_reason = "signal-kill"
                                break
                            _signal_anchored_group(pgid, requested)
                if cleanup_reason is not None:
                    break

            if cleanup_reason is not None:
                selector.close()
                selector = None
                _cleanup_and_never_return(
                    control,
                    output_fd,
                    pgid,
                    own_pid,
                    target.pid,
                    control_token,
                    cleanup_reason,
                    completion_sent,
                )

            if target_returncode is None:
                target_returncode = target.poll()
            if target_returncode is not None and not completion_sent:
                output_eof = _drain_output_nonblocking(control, output_fd) or output_eof
                _send_json(
                    control,
                    {
                        "type": "target_complete",
                        "protocol": _PROTOCOL,
                        "pid": own_pid,
                        "targetPid": target.pid,
                        "token": control_token,
                        "state": "target-complete",
                        "returncode": target_returncode,
                        "forced": False,
                    },
                )
                completion_sent = True

            if not completion_sent:
                continue

            # Normal background work remains admitted. The trusted leader keeps
            # streaming its bytes until that exact group naturally becomes empty
            # or the host asks it to terminate the group.
            members = _group_members(pgid, own_pid)
            if members is None or members:
                empty_scans = 0
                continue
            empty_scans += 1
            if empty_scans < 3:
                continue
            _send_json(
                control,
                {
                    "type": "group_empty",
                    "protocol": _PROTOCOL,
                    "pid": own_pid,
                    "targetPid": target.pid,
                    "token": control_token,
                    "helperPid": None,
                    "state": "group-empty",
                    "reason": "natural",
                },
            )
            return target_returncode
    except BaseException:
        if selector is not None:
            selector.close()
        _cleanup_and_never_return(
            control,
            output_fd,
            pgid,
            own_pid,
            target.pid,
            control_token,
            "supervisor-error",
            completion_sent,
        )
    finally:
        if selector is not None:
            selector.close()
        if stdout is not None:
            try:
                stdout.close()
            except OSError:
                pass


def main() -> None:
    control_fd = -1
    control: socket.socket | None = None
    exit_code = 127
    try:
        control_fd, owner_token = _parse_args(sys.argv[1:])
        control = socket.socket(fileno=control_fd)
        exit_code = _run(control, owner_token)
    except BaseException as exc:
        try:
            _write_all(2, f"bash supervisor failed: {type(exc).__name__}: {exc}\n".encode())
        except OSError:
            pass
    finally:
        if control is not None:
            try:
                control.close()
            except OSError:
                pass
        elif control_fd >= 0:
            try:
                os.close(control_fd)
            except OSError:
                pass
    _target_exit(exit_code)


if __name__ == "__main__":
    main()
