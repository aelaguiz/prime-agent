from __future__ import annotations

import asyncio
import io
import json
import os
import resource
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from unittest import mock

from rlm import bash
from rlm import _bash_supervisor as supervisor_module

# The package re-exports the bash() function under the same name, so reach the
# module through sys.modules for internals.
bash_module = sys.modules["rlm.bash"]

_LINUX_BOOT_ID = "11111111-2222-3333-4444-555555555555"
_EXACT_PROC_10 = f"proc:{_LINUX_BOOT_ID}:10"
_EXACT_PROC_11 = f"proc:{_LINUX_BOOT_ID}:11"


def _win_spawn(procs=None, resume=True):
    # POSIX stand-in for _winjob.spawn_in_job: a real Popen plus a resume() mock (Ubuntu CI).
    def spawn_in_job(job, argv, cwd, env):
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
        proc.resume = mock.Mock(return_value=resume)
        proc.close = mock.Mock()
        proc.spawn_job = job
        proc.spawn_argv = argv
        if procs is not None:
            procs.append(proc)
        return proc

    return spawn_in_job


def _initialized_journal_env(path: str, owner: str | None = None) -> dict[str, str]:
    generation = "test-generation"
    with open(path, "x") as journal:
        journal.write(
            json.dumps(
                {
                    "version": 2,
                    "type": "authority",
                    "generation": generation,
                    "sequence": 0,
                    "createdAt": "2026-01-01T00:00:00+00:00",
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        journal.flush()
        os.fsync(journal.fileno())
    return {
        bash_module._JOURNAL_PATH_ENV: path,
        bash_module._JOURNAL_GENERATION_ENV: generation,
        bash_module._KERNEL_ADMISSION_PROTOCOL_ENV: bash_module._KERNEL_ADMISSION_PROTOCOL_VERSION,
        bash_module._KERNEL_ADMISSION_GENERATION_ENV: "12345678-1234-4234-8234-123456789abc",
        bash_module._KERNEL_LINEAGE_ENV: "a" * 64,
        bash_module._KERNEL_PID_ENV: str(os.getpid()),
        bash_module._KERNEL_PROCESS_START_ID_ENV: "token:" + "b" * 64,
        "PRIME_AGENT_KERNEL_OWNER_PID": owner or str(os.getpid()),
    }


def _valid_lock_record(**overrides):
    expired = datetime.fromtimestamp(time.time() - 60, timezone.utc).isoformat()
    return {
        "version": 1,
        "ownerPid": 2_000_000_000,
        "processStartId": "proc:1",
        "token": "a" * 64,
        "createdAt": expired,
        "expiresAt": expired,
        **overrides,
    }


class BashTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._saved_internal_env = {
            key: os.environ.get(key)
            for key in (
                bash_module._JOURNAL_PATH_ENV,
                bash_module._JOURNAL_GENERATION_ENV,
                bash_module._KERNEL_ADMISSION_PROTOCOL_ENV,
                bash_module._KERNEL_ADMISSION_GENERATION_ENV,
                bash_module._KERNEL_LINEAGE_ENV,
                bash_module._KERNEL_PID_ENV,
                bash_module._KERNEL_PROCESS_START_ID_ENV,
                "PRIME_AGENT_KERNEL_OWNER_PID",
            )
        }
        for key in self._saved_internal_env:
            os.environ.pop(key, None)
        with bash_module._journal_lock:
            bash_module._journal_enrollments.clear()

    def tearDown(self):
        for key, value in self._saved_internal_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        with bash_module._journal_lock:
            bash_module._journal_enrollments.clear()

    async def test_await_returns_result(self):
        first = bash("echo hi")
        result = await first
        self.assertEqual(result.exit_code, 0)
        self.assertIn("hi", result.output)
        self.assertGreaterEqual(result.duration, 0)
        await _poll_handle_reaped(first)

        handle = bash("echo again")
        awaited = await handle
        self.assertEqual(handle.poll(), awaited)
        await _poll_handle_reaped(handle)


    async def test_private_multiplex_survives_high_fds_and_strict_posix_shell(self):
        # Regression: dash rejects multi-digit fds in redirections at parse
        # time, so the script must never reference the raw status-pipe fd.
        dummies = [os.open(os.devnull, os.O_RDONLY) for _ in range(30)]
        self.addCleanup(lambda: [os.close(fd) for fd in dummies])
        if os.path.exists("/bin/dash"):
            with mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/dash"}):
                result = await bash("echo ok")
            self.assertEqual(result.exit_code, 0)
            self.assertIn("ok", result.output)
        result = await bash("echo ok-default")
        self.assertEqual(result.exit_code, 0)
        self.assertIn("ok-default", result.output)

    async def test_backgrounded_tail_and_kill(self):
        handle = bash("echo start; sleep 30")
        self.assertIsNone(handle.poll())
        for _ in range(100):
            if "start" in handle.tail():
                break
            await asyncio.sleep(0.05)
        self.assertIn("start", handle.tail())
        self.assertTrue(handle.running)
        handle.kill(grace=0.2)
        result = await asyncio.wait_for(handle, timeout=5)
        self.assertNotEqual(result.exit_code, 0)

    async def test_kill_escalates_to_sigkill(self):
        handle = bash("trap '' TERM; echo up; sleep 30")
        for _ in range(100):
            if "up" in handle.output():
                break
            await asyncio.sleep(0.05)
        handle.kill(grace=0.2)
        result = await asyncio.wait_for(handle, timeout=10)
        self.assertEqual(result.exit_code, -9)

    async def test_buffer_cap_keeps_head_and_tail(self):
        result = await bash("seq 1 400000")
        self.assertLessEqual(len(result.output), 2 * 1024 * 1024 + 256)
        self.assertTrue(result.output.startswith("1\n"))
        self.assertIn("400000", result.output)
        self.assertIn("bytes dropped", result.output)

    async def test_env_prefix_and_journal(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(
                os.environ,
                {**_initialized_journal_env(journal), "PRIME_AGENT_BASH_COMMAND_PREFIX": "echo prefixed"},
            ):
                handle = bash('echo "$NO_COLOR $TERM"')
                result = await handle
                # The inactive record lands slightly after finalize, once the group exits.
                records = await _poll_journal(journal, count=2)
            self.assertEqual(result.exit_code, 0)
            lines = result.output.splitlines()
            self.assertEqual(lines[0], "prefixed")
            self.assertIn("1 dumb", lines[1])

            self.assertEqual([r["active"] for r in records], [True, False])
            self.assertEqual([r["sequence"] for r in records], [1, 2])
            for record in records:
                self.assertEqual(record["pid"], handle.pid)
                self.assertEqual(record["ownerPid"], os.getpid())
                self.assertEqual(record["kernelPid"], os.getpid())
            self.assertTrue(
                bash_module._is_exact_process_identity(records[0].get("authorityProcessStartId"))
            )
            self.assertNotIn("processStartId", records[0])

    async def test_await_returns_when_shell_backgrounds_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                handle = bash("echo fg; sleep 30 &")
                result = await asyncio.wait_for(handle, timeout=5)
                self.assertEqual(result.exit_code, 0)
                self.assertIn("fg", result.output)
                # The persistent supervisor stays group leader while the target waits.
                os.killpg(handle.pid, 0)
                records = await _poll_journal(journal, count=1)
                self.assertTrue(records[-1]["active"])
                handle.kill(signal.SIGKILL)
                records = await _poll_journal(journal, count=2)
            self.assertFalse(records[-1]["active"])

    async def test_shell_exit_returns_while_admitted_background_group_stays_owned(self):
        handle = bash("sleep 30 & exit 7")
        result = await asyncio.wait_for(handle, timeout=5)
        self.assertEqual(result.exit_code, 7)
        os.killpg(handle.pid, 0)
        handle.kill(signal.SIGKILL)
        await _poll_group_dead(handle.pid)
        await _poll_handle_reaped(handle)

    async def test_term_ignoring_child_is_escalated(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                handle = bash("sh -c 'trap \"\" TERM; echo ready; sleep 30' &")
                await asyncio.wait_for(handle, timeout=5)
                for _ in range(100):
                    if "ready" in handle.output():
                        break
                    await asyncio.sleep(0.05)
                handle.kill(signal.SIGTERM)
                records = await _poll_journal(journal, count=2, timeout=10)
            self.assertFalse(records[-1]["active"])
            await _poll_group_dead(handle.pid)
            await _poll_handle_reaped(handle)

    async def test_stdout_lines_cannot_forge_target_status(self):
        result = await asyncio.wait_for(
            bash("printf '0\n-9\n'; exit 37"), timeout=5
        )
        self.assertEqual(result.exit_code, 37)
        self.assertEqual(result.output, "0\n-9\n")

    async def test_target_signal_status_is_supervisor_derived(self):
        result = await asyncio.wait_for(
            bash("printf before-signal; kill -KILL $$"), timeout=5
        )
        self.assertEqual(result.exit_code, -signal.SIGKILL)
        self.assertEqual(result.output, "before-signal")

    async def test_private_stream_freezes_foreground_snapshot_before_late_group_output(self):
        handle = bash("printf foreground; (sleep 0.2; printf background) &")
        result = await asyncio.wait_for(handle, timeout=5)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.output, "foreground")
        for _ in range(100):
            if "background" in handle.output():
                break
            await asyncio.sleep(0.02)
        self.assertEqual(handle.output(), "foregroundbackground")
        await _poll_handle_reaped(handle)

    async def test_private_multiplex_survives_fds_above_fd_setsize(self):
        # select.select() rejects fds >= FD_SETSIZE (1024); the delivered status
        # must still win when the status/wake pipes land above that boundary.
        limits = resource.getrlimit(resource.RLIMIT_NOFILE)
        if limits[0] < 1100:
            try:
                resource.setrlimit(resource.RLIMIT_NOFILE, (1100, limits[1]))
            except (ValueError, OSError):
                self.skipTest("cannot raise RLIMIT_NOFILE above FD_SETSIZE")
            self.addCleanup(resource.setrlimit, resource.RLIMIT_NOFILE, limits)
        held: list[int] = []
        self.addCleanup(lambda: [os.close(fd) for fd in held])
        while True:
            fd = os.open(os.devnull, os.O_RDONLY)
            held.append(fd)
            if fd >= 1024:
                break
        handle = bash("echo hi; sleep 30 & true")
        try:
            result = await asyncio.wait_for(handle, timeout=5)
            self.assertEqual(result.exit_code, 0)
            self.assertIn("hi", result.output)
        finally:
            handle.kill(signal.SIGKILL)
            await _poll_handle_reaped(handle)

    async def test_awaits_do_not_hold_executor_threads(self):
        loop = asyncio.get_running_loop()
        executor = ThreadPoolExecutor(max_workers=1)
        loop.set_default_executor(executor)
        tasks = [asyncio.ensure_future(bash("sleep 0.5")._wait()) for _ in range(3)]
        await asyncio.sleep(0.1)
        # Old executor-parked waits would deadlock this 1-thread pool.
        value = await asyncio.wait_for(loop.run_in_executor(None, lambda: 42), timeout=0.3)
        self.assertEqual(value, 42)
        results = await asyncio.gather(*tasks)
        self.assertTrue(all(r.exit_code == 0 for r in results))

    def test_buffer_tail_retention_is_exact(self):
        buffer = bash_module._BoundedBuffer()
        buffer.write(b"x" * bash_module._HEAD_CAP)
        buffer.write(b"a" * bash_module._TAIL_CAP)
        buffer.write(b"b" * 1000)
        self.assertEqual(buffer._tail_size, bash_module._TAIL_CAP)
        text = buffer.text()
        self.assertTrue(text.endswith("b" * 1000))
        self.assertIn("a" * 1000 + "b" * 1000, text)

    async def test_running_reflects_group_liveness(self):
        handle = bash("echo fg; sleep 30 &")
        result = await asyncio.wait_for(handle, timeout=5)
        self.assertEqual(result.exit_code, 0)
        # The foreground result is in, but the group still anchors `sleep 30 &`.
        self.assertIsNotNone(handle.poll())
        self.assertTrue(handle.running)
        handle.kill(signal.SIGKILL)
        for _ in range(100):
            if not handle.running:
                break
            await asyncio.sleep(0.05)
        self.assertFalse(handle.running)

    async def test_windows_kill_terminates_tree(self):
        # Pins the taskkill fallback when TerminateJobObject failed or raced.
        handle = bash("sleep 30")
        try:
            handle._job = None
            completed = mock.Mock(returncode=0)
            with mock.patch.object(bash_module, "_IS_POSIX", False):
                with mock.patch.object(handle._proc, "kill") as proc_kill:
                    patched_run = mock.patch.object(
                        bash_module.subprocess, "run", return_value=completed
                    )
                    with mock.patch.dict(os.environ, {"SystemRoot": r"C:\WinTest"}):
                        with patched_run as run:
                            handle.kill()
                    taskkill = r"C:\Windows\System32\taskkill.exe"
                    self.assertEqual(
                        run.call_args.args[0], [taskkill, "/PID", str(handle.pid), "/T", "/F"]
                    )
                    self.assertEqual(
                        run.call_args.kwargs["env"],
                        {
                            "SystemRoot": r"C:\Windows",
                            "WINDIR": r"C:\Windows",
                            "NoDefaultCurrentDirectoryInExePath": "1",
                        },
                    )
                    self.assertEqual(run.call_args.kwargs["timeout"], 2)
                    proc_kill.assert_not_called()
                    # Missing ambient SystemRoot uses the same canonical binary.
                    with mock.patch.dict(os.environ):
                        os.environ.pop("SystemRoot", None)
                        with patched_run as run:
                            handle.kill()
                    self.assertTrue(run.call_args.args[0][0].startswith(r"C:\Windows"))
                    # taskkill unavailable or failing must fall back to Popen.kill().
                    with mock.patch.object(bash_module.subprocess, "run", side_effect=OSError):
                        handle.kill()
                    proc_kill.assert_called_once()
        finally:
            handle.kill(signal.SIGKILL)
            await asyncio.wait_for(handle, timeout=5)

    async def test_target_gets_no_supervisor_authority_fd(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX-only authority descriptors")
        probe = (
            "import os\n"
            "for fd in range(3, 256):\n"
            '    try: os.write(fd, b"forged-authority-packet")\n'
            "    except OSError: pass\n"
            'print("target-output", end="")\n'
        )
        # Any inherited supervisor fd would accept these bytes and corrupt the
        # private protocol. Only target stdout is inherited intentionally.
        encoded = probe.encode().hex()
        command = f"""python3 -c 'exec(bytes.fromhex("{encoded}"))'; exit 29"""
        result = await asyncio.wait_for(bash(command), timeout=5)
        self.assertEqual(result.exit_code, 29)
        self.assertEqual(result.output, "target-output")

    async def test_support_thread_start_failure_never_releases_posix_command(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX-only admission")
        real_start = threading.Thread.start
        for fail_at in (1, 2):
            with self.subTest(fail_at=fail_at):
                with tempfile.TemporaryDirectory() as tmp:
                    marker = os.path.join(tmp, "ran")
                    journal = os.path.join(tmp, "journal.jsonl")
                    starts = 0
                    started: list[threading.Thread] = []

                    def fail_support_start(thread):
                        nonlocal starts
                        starts += 1
                        if starts == fail_at:
                            raise RuntimeError(f"thread-start-{fail_at}")
                        real_start(thread)
                        started.append(thread)

                    with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                        with mock.patch.object(threading.Thread, "start", fail_support_start):
                            with self.assertRaisesRegex(RuntimeError, f"thread-start-{fail_at}"):
                                bash(f"touch {marker}")
                    await asyncio.sleep(0.1)
                    self.assertFalse(os.path.exists(marker))
                    self.assertTrue(all(not thread.is_alive() for thread in started))
                    records = await _poll_journal(journal, count=2)
                    self.assertEqual([record["active"] for record in records], [True, False])
                    with bash_module._live_lock:
                        self.assertFalse(
                            any(handle.command == f"touch {marker}" for handle in bash_module._live_handles)
                        )

    def test_supervisor_post_spawn_output_setup_failure_enters_group_cleanup(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")

        class CleanupEntered(BaseException):
            pass

        own_pid = 4242
        target_pid = 4243
        owner_token = "a" * 64
        control_token = "b" * 64
        control = mock.Mock()
        stdout = mock.Mock()
        stdout.fileno.return_value = 91
        target = mock.Mock(pid=target_pid, stdout=stdout)
        release = {
            "type": "release",
            "protocol": supervisor_module._PROTOCOL,
            "pid": own_pid,
            "ownerToken": owner_token,
            "controlToken": control_token,
            "shell": "/bin/sh",
            "script": "sleep 30",
            "cwd": "/",
            "env": {},
        }
        with (
            mock.patch.object(supervisor_module, "_install_signal_handlers"),
            mock.patch.object(supervisor_module.os, "getpid", return_value=own_pid),
            mock.patch.object(supervisor_module.os, "setsid"),
            mock.patch.object(supervisor_module.os, "getpgrp", return_value=own_pid),
            mock.patch.object(supervisor_module.os, "getsid", return_value=own_pid),
            mock.patch.object(supervisor_module, "_send_json"),
            mock.patch.object(supervisor_module, "_recv_json", return_value=release),
            mock.patch.object(supervisor_module.subprocess, "Popen", return_value=target),
            mock.patch.object(
                supervisor_module.os,
                "set_blocking",
                side_effect=OSError("output setup failed"),
            ),
            mock.patch.object(
                supervisor_module,
                "_cleanup_and_never_return",
                side_effect=CleanupEntered,
            ) as cleanup,
        ):
            with self.assertRaises(CleanupEntered):
                supervisor_module._run(control, owner_token)
        cleanup.assert_called_once_with(
            control,
            91,
            own_pid,
            own_pid,
            target_pid,
            control_token,
            "supervisor-error",
            False,
        )
        stdout.close.assert_called_once_with()

    async def test_post_spawn_output_setup_failure_kills_target_group(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "late-side-effect")
            injector = os.path.join(tmp, "failing-output-supervisor.py")
            supervisor_path = os.path.abspath(supervisor_module.__file__)
            with open(injector, "w") as injector_file:
                injector_file.write(
                    f"""import importlib.util
spec = importlib.util.spec_from_file_location("failing_supervisor", {supervisor_path!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def fail_output_setup(fd, blocking):
    raise OSError("injected output setup failure")
module.os.set_blocking = fail_output_setup
module.main()
"""
                )

            supervisor_pids: list[int] = []
            real_popen = subprocess.Popen

            def capture_supervisor(*args, **kwargs):
                proc = real_popen(*args, **kwargs)
                argv = args[0] if args else kwargs.get("args")
                if isinstance(argv, (list, tuple)) and injector in argv:
                    supervisor_pids.append(proc.pid)
                return proc

            with mock.patch.object(bash_module, "_supervisor_path", return_value=injector):
                with mock.patch.object(bash_module.subprocess, "Popen", capture_supervisor):
                    with self.assertRaisesRegex(RuntimeError, "trusted supervisor"):
                        bash(f"sleep 1; touch {marker}")
            self.assertEqual(len(supervisor_pids), 1)
            await _poll_group_dead(supervisor_pids[0])
            await asyncio.sleep(1.1)
            self.assertFalse(os.path.exists(marker))

    def test_cleanup_helper_setup_failure_uses_anchored_group_kill(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")

        class GroupKillEntered(BaseException):
            pass

        control = mock.Mock()
        with mock.patch.object(supervisor_module.os, "pipe", side_effect=OSError("no descriptors")):
            with mock.patch.object(
                supervisor_module,
                "_signal_anchored_group",
                side_effect=GroupKillEntered,
            ) as signal_group:
                with self.assertRaises(GroupKillEntered):
                    supervisor_module._cleanup_and_never_return(
                        control,
                        91,
                        4242,
                        4242,
                        4243,
                        "b" * 64,
                        "supervisor-error",
                        False,
                    )
        signal_group.assert_called_once_with(4242, signal.SIGKILL)

    async def test_bash_env_runs_only_after_journal_enrollment_release(self):
        if not bash_module._IS_POSIX or os.path.basename(bash_module._shell()) != "bash":
            self.skipTest("BASH_ENV is a bash startup contract")
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "bash-env-ran")
            startup = os.path.join(tmp, "startup.sh")
            journal = os.path.join(tmp, "journal.jsonl")
            with open(startup, "w") as startup_file:
                startup_file.write(
                    f"printf post-release > {marker!r}\n"
                    "printf 'bash-env-output\n0\n\036prime-agent-complete:legacy\037\n'\n"
                )
            enrolled = threading.Event()
            real_enroll = bash_module._enroll_journal
            real_send = bash_module._send_control_frame

            def enroll(pid, **kwargs):
                self.assertFalse(os.path.exists(marker))
                result = real_enroll(pid, **kwargs)
                if result:
                    enrolled.set()
                return result

            def send(control, payload):
                if payload.get("type") == "release":
                    self.assertTrue(enrolled.is_set())
                    self.assertFalse(os.path.exists(marker))
                return real_send(control, payload)

            with mock.patch.dict(
                os.environ,
                {**_initialized_journal_env(journal), "BASH_ENV": startup},
            ):
                with mock.patch.object(bash_module, "_enroll_journal", side_effect=enroll):
                    with mock.patch.object(
                        bash_module, "_send_control_frame", side_effect=send
                    ):
                        handle = bash("echo admitted")
                        result = await handle
                        records = await _poll_journal(journal, count=2)
                        await _poll_handle_reaped(handle)
            self.assertEqual(result.exit_code, 0)
            self.assertIn("bash-env-output\n0\n", result.output)
            self.assertIn("\x1eprime-agent-complete:legacy\x1f", result.output)
            with open(marker) as marker_file:
                self.assertEqual(marker_file.read(), "post-release")
            self.assertEqual([record["state"] for record in records], ["enrolled", "retired"])

    async def test_custom_shell_runs_after_release_and_bootstrap_env_is_scrubbed(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")
        dangerous = {
            "PYTHONPATH": "/attacker/pythonpath",
            "PYTHONHOME": "/attacker/pythonhome",
            "PYTHONSTARTUP": "/attacker/startup.py",
            "BASH_ENV": "/attacker/bash-env",
            "ENV": "/attacker/sh-env",
            "SHELLOPTS": "xtrace",
            "LD_PRELOAD": "/attacker/loader.so",
            "LD_AUDIT": "/attacker/audit.so",
            "DYLD_INSERT_LIBRARIES": "/attacker/loader.dylib",
            bash_module._JOURNAL_PATH_ENV: "/attacker/journal",
            bash_module._JOURNAL_GENERATION_ENV: "attacker-generation",
            bash_module._KERNEL_ADMISSION_PROTOCOL_ENV: bash_module._KERNEL_ADMISSION_PROTOCOL_VERSION,
            bash_module._KERNEL_ADMISSION_GENERATION_ENV: "12345678-1234-4234-8234-123456789abc",
            bash_module._KERNEL_LINEAGE_ENV: "a" * 64,
            bash_module._KERNEL_PID_ENV: "999",
            bash_module._KERNEL_PROCESS_START_ID_ENV: "proc:1",
            "PRIME_AGENT_KERNEL_OWNER_PID": "999",
        }
        with mock.patch.dict(os.environ, dangerous):
            bootstrap_env = bash_module._bootstrap_env()
            target_env = bash_module._child_env()
        self.assertFalse(any(key.startswith("PYTHON") for key in bootstrap_env))
        self.assertFalse(any(key.startswith("LD_") for key in bootstrap_env))
        self.assertFalse(any(key.startswith("DYLD_") for key in bootstrap_env))
        for key in ("BASH_ENV", "ENV", "SHELLOPTS"):
            self.assertNotIn(key, bootstrap_env)
        for key in dangerous:
            if key not in {
                bash_module._JOURNAL_PATH_ENV,
                bash_module._JOURNAL_GENERATION_ENV,
                bash_module._KERNEL_ADMISSION_PROTOCOL_ENV,
                bash_module._KERNEL_ADMISSION_GENERATION_ENV,
                bash_module._KERNEL_LINEAGE_ENV,
                bash_module._KERNEL_PID_ENV,
                bash_module._KERNEL_PROCESS_START_ID_ENV,
                "PRIME_AGENT_KERNEL_OWNER_PID",
            }:
                self.assertEqual(target_env[key], dangerous[key])
        for key in (
            bash_module._JOURNAL_PATH_ENV,
            bash_module._JOURNAL_GENERATION_ENV,
            bash_module._KERNEL_ADMISSION_PROTOCOL_ENV,
            bash_module._KERNEL_ADMISSION_GENERATION_ENV,
            bash_module._KERNEL_LINEAGE_ENV,
            bash_module._KERNEL_PID_ENV,
            bash_module._KERNEL_PROCESS_START_ID_ENV,
            "PRIME_AGENT_KERNEL_OWNER_PID",
        ):
            self.assertNotIn(key, target_env)

        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "custom-shell-ran")
            wrapper = os.path.join(tmp, "custom-shell")
            with open(wrapper, "w") as wrapper_file:
                wrapper_file.write(
                    "#!/bin/sh\n"
                    f"printf post-release > {marker!r}\n"
                    "printf 'configured-shell-startup\n0\n'\n"
                    "exec /bin/sh \"$@\"\n"
                )
            os.chmod(wrapper, 0o700)
            real_send = bash_module._send_control_frame

            def send(control, payload):
                if payload.get("type") == "release":
                    self.assertFalse(os.path.exists(marker))
                return real_send(control, payload)

            with mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": wrapper}):
                with mock.patch.object(
                    bash_module, "_send_control_frame", side_effect=send
                ):
                    handle = bash("echo custom-ok")
                    result = await handle
                    await _poll_handle_reaped(handle)
            self.assertEqual(result.exit_code, 0)
            self.assertIn("configured-shell-startup\n0\n", result.output)
            self.assertIn("custom-ok", result.output)
            with open(marker) as marker_file:
                self.assertEqual(marker_file.read(), "post-release")

    async def test_configured_shell_start_failure_retires_clean_group(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            missing = os.path.join(tmp, "missing-shell")
            with mock.patch.dict(
                os.environ,
                {**_initialized_journal_env(journal), "PRIME_AGENT_BASH_SHELL": missing},
            ):
                with self.assertRaisesRegex(RuntimeError, "configured shell failed to start"):
                    bash("echo never")
                records = await _poll_journal(journal, count=2)
            self.assertEqual([record["state"] for record in records], ["enrolled", "retired"])

    async def test_concurrent_handles_have_distinct_noninherited_owner_tokens(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")
        first = bash("sleep 0.4")
        second = bash("sleep 0.4")
        try:
            self.assertRegex(first._owner_token or "", r"^[0-9a-f]{64}$")
            self.assertRegex(second._owner_token or "", r"^[0-9a-f]{64}$")
            self.assertNotEqual(first._owner_token, second._owner_token)
            self.assertRegex(first._control_token or "", r"^[0-9a-f]{64}$")
            self.assertRegex(second._control_token or "", r"^[0-9a-f]{64}$")
            self.assertNotEqual(first._control_token, second._control_token)
            for handle in (first, second):
                argv = [str(value) for value in handle._proc.args]
                self.assertEqual(argv[1:3], ["-I", "-S"])
                self.assertEqual(argv[3], bash_module._supervisor_path())
                self.assertEqual(
                    sum(value.count(bash_module._PROCESS_IDENTITY_OWNER_TOKEN_PREFIX) for value in argv),
                    1,
                )
                self.assertEqual(
                    sum(value.count(handle._owner_token or "") for value in argv), 1
                )
                self.assertNotIn(handle._owner_token, bash_module._child_env().values())
                self.assertFalse(any((handle._control_token or "") in value for value in argv))
                self.assertNotIn(handle._control_token, bash_module._child_env().values())
            await asyncio.gather(first, second)
            await asyncio.gather(
                _poll_handle_reaped(first), _poll_handle_reaped(second)
            )
        finally:
            first.kill(signal.SIGKILL)
            second.kill(signal.SIGKILL)

    async def test_explicit_exec_replaces_target_but_not_supervisor_leader(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")
        handle = bash("exec sh -c 'echo exec-target=$$; sleep 0.5; exit 6'")
        for _ in range(100):
            if "exec-target=" in handle.output():
                break
            await asyncio.sleep(0.01)
        self.assertIsNone(handle._proc.poll())
        self.assertEqual(os.getpgid(handle.pid), handle.pid)
        self.assertNotEqual(handle._target_pid, handle.pid)
        result = await asyncio.wait_for(handle, timeout=5)
        self.assertEqual(result.exit_code, 6)
        self.assertIn("exec-target=", result.output)
        await _poll_handle_reaped(handle)
        self.assertTrue(handle._group_empty_proven)

    async def test_target_is_child_of_persistent_supervisor_group_leader(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")
        handle = bash("printf '%s %s\\n' \"$$\" \"$PPID\"; sleep 0.4")
        for _ in range(100):
            if handle.output().strip():
                break
            await asyncio.sleep(0.01)
        target_pid, parent_pid = map(int, handle.output().splitlines()[0].split())
        self.assertEqual(target_pid, handle._target_pid)
        self.assertEqual(parent_pid, handle.pid)
        self.assertEqual(os.getpgid(target_pid), handle.pid)
        self.assertEqual(os.getpgid(handle.pid), handle.pid)
        await asyncio.wait_for(handle, timeout=5)
        await _poll_handle_reaped(handle)

    async def test_reap_serializes_escalation_without_signaling_reused_pgid(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            entered = threading.Event()
            release = threading.Event()
            real_retire = bash_module._retire_journal
            handle_box = []

            def held_retire(*args, **kwargs):
                if handle_box and args[0] == handle_box[0].pid:
                    entered.set()
                    if not release.wait(10):
                        raise AssertionError("retirement release timed out")
                return real_retire(*args, **kwargs)

            with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                with mock.patch.object(
                    bash_module, "_retire_journal", side_effect=held_retire
                ):
                    handle = bash("sleep 0.2")
                    handle_box.append(handle)
                    await asyncio.wait_for(handle, timeout=5)
                    self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                    try:
                        with mock.patch.object(bash_module.os, "killpg") as killpg:
                            with mock.patch.object(
                                bash_module, "_send_control_frame"
                            ) as send:
                                escalation = asyncio.get_running_loop().run_in_executor(
                                    None, handle._force_kill
                                )
                                await asyncio.sleep(0.1)
                                self.assertFalse(escalation.done())
                                release.set()
                                await asyncio.wait_for(escalation, timeout=5)
                            send.assert_not_called()
                        killpg.assert_not_called()
                    finally:
                        release.set()
                    await _poll_handle_reaped(handle)
            self.assertEqual(handle._lifecycle_state, "reaped")

    def test_reused_numeric_member_is_never_signaled_individually(self):
        reused_member = 2_000_000_000
        with mock.patch.object(
            supervisor_module, "_group_members", return_value={reused_member}
        ):
            with mock.patch.object(supervisor_module.os, "killpg") as killpg:
                with mock.patch.object(supervisor_module.os, "kill") as kill_pid:
                    supervisor_module._signal_anchored_group(4242, signal.SIGTERM)
        killpg.assert_called_once_with(4242, signal.SIGTERM)
        kill_pid.assert_not_called()

    async def test_group_proof_rejects_wrong_token_pid_and_state(self):
        handle = bash("sleep 30 &")
        await asyncio.wait_for(handle, timeout=5)
        base = {
            "type": "group_empty",
            "protocol": bash_module._SUPERVISOR_PROTOCOL,
            "pid": handle.pid,
            "targetPid": handle._target_pid,
            "token": handle._control_token,
            "helperPid": None,
            "state": "group-empty",
            "reason": "natural",
        }
        try:
            for forged in (
                {**base, "token": "f" * 64},
                {**base, "pid": handle.pid + 1},
                {**base, "state": "claimed-empty"},
            ):
                with self.assertRaisesRegex(RuntimeError, "group proof"):
                    handle._accept_supervisor_frame(forged)
            self.assertFalse(handle._group_empty_proven)
        finally:
            handle.kill(signal.SIGKILL)
            await _poll_group_dead(handle.pid)
            await _poll_handle_reaped(handle)

    async def test_isolated_bootstrap_failure_cannot_run_site_or_shell_startup(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")
        with tempfile.TemporaryDirectory() as tmp:
            site_marker = os.path.join(tmp, "site-ran")
            shell_marker = os.path.join(tmp, "shell-ran")
            sitecustomize = os.path.join(tmp, "sitecustomize.py")
            bash_env = os.path.join(tmp, "bash-env.sh")
            with open(sitecustomize, "w") as site_file:
                site_file.write(f"open({site_marker!r}, 'w').write('bad')\n")
            with open(bash_env, "w") as startup_file:
                startup_file.write(f"printf bad > {shell_marker!r}\n")
            missing = os.path.join(tmp, "missing-supervisor.py")
            with mock.patch.dict(
                os.environ, {"PYTHONPATH": tmp, "BASH_ENV": bash_env}
            ):
                with mock.patch.object(
                    bash_module, "_supervisor_path", return_value=missing
                ):
                    with self.assertRaisesRegex(RuntimeError, "supervisor"):
                        bash("echo never")
            self.assertFalse(os.path.exists(site_marker))
            self.assertFalse(os.path.exists(shell_marker))

    def test_darwin_supervisor_identity_is_exact_token_only(self):
        token = "a" * 64
        coarse = "ps:lstart:Mon Jan 1 00:00:00 2026"
        with mock.patch.object(bash_module.sys, "platform", "darwin"):
            with mock.patch.object(bash_module, "_process_start_id", return_value=coarse):
                self.assertIsNone(bash_module._supervisor_process_start_id(1234, token))
            with mock.patch.object(
                bash_module, "_process_start_id", return_value=f"token:{'b' * 64}"
            ):
                self.assertIsNone(bash_module._supervisor_process_start_id(1234, token))
            with mock.patch.object(
                bash_module, "_process_start_id", return_value=f"token:{token}"
            ):
                self.assertEqual(
                    bash_module._supervisor_process_start_id(1234, token),
                    f"token:{token}",
                )
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                with mock.patch.object(
                    bash_module, "_process_start_id", return_value=coarse
                ):
                    self.assertFalse(
                        bash_module._enroll_journal(
                            os.getpid(), expected_start_id=coarse
                        )
                    )

    async def test_post_release_protocol_error_enters_group_cleanup(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "late-side-effect")
            handle = bash(f"sleep 1; touch {marker}")
            control = handle._control_sock
            self.assertIsNotNone(control)
            with handle._control_send_lock:
                bash_module._send_control_frame(control, {"type": "invalid-after-release"})
            result = await asyncio.wait_for(handle, timeout=5)
            self.assertEqual(result.exit_code, -signal.SIGKILL)
            await _poll_handle_reaped(handle)
            await asyncio.sleep(1.1)
            self.assertFalse(os.path.exists(marker))

    async def test_parent_process_death_closes_control_and_kills_target(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor contract")
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "late-side-effect")
            runtime_src = os.path.join(os.path.dirname(__file__), "..", "src")
            code = (
                "import os,sys\n"
                f"sys.path.insert(0, {os.path.abspath(runtime_src)!r})\n"
                "from rlm import bash\n"
                f"h=bash({'sleep 1; touch ' + marker!r})\n"
                "print(h.pid, flush=True)\n"
                "os._exit(0)\n"
            )
            env = dict(os.environ)
            for key in (
                bash_module._JOURNAL_PATH_ENV,
                bash_module._JOURNAL_GENERATION_ENV,
                bash_module._KERNEL_ADMISSION_PROTOCOL_ENV,
                bash_module._KERNEL_ADMISSION_GENERATION_ENV,
                bash_module._KERNEL_LINEAGE_ENV,
                bash_module._KERNEL_PID_ENV,
                bash_module._KERNEL_PROCESS_START_ID_ENV,
                "PRIME_AGENT_KERNEL_OWNER_PID",
            ):
                env.pop(key, None)
            parent = subprocess.Popen(
                [sys.executable, "-I", "-S", "-c", code],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            stdout, stderr = parent.communicate(timeout=10)
            self.assertEqual(parent.returncode, 0, stderr)
            supervisor_pid = int(stdout.strip())
            for _ in range(200):
                try:
                    os.kill(supervisor_pid, 0)
                except ProcessLookupError:
                    break
                await asyncio.sleep(0.02)
            else:
                self.fail("supervisor survived parent control EOF")
            await asyncio.sleep(1.2)
            self.assertFalse(os.path.exists(marker))

    def test_journal_lock_unlinks_only_after_matching_fds_are_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            _initialized_journal_env(journal)
            real_unlink = os.unlink
            denied: list[str] = []

            def deny_delete_sharing(path):
                try:
                    target = os.stat(path, follow_symlinks=False)
                except OSError:
                    return real_unlink(path)
                for fd in range(3, 256):
                    try:
                        opened = os.fstat(fd)
                    except OSError:
                        continue
                    if (opened.st_dev, opened.st_ino) == (
                        target.st_dev,
                        target.st_ino,
                    ):
                        denied.append(os.fspath(path))
                        raise PermissionError("simulated Windows share-delete denial")
                return real_unlink(path)

            with mock.patch.object(
                bash_module.os, "unlink", side_effect=deny_delete_sharing
            ):
                lock = bash_module._acquire_journal_write_lock(journal)
                self.assertIsNotNone(lock)
                bash_module._release_journal_write_lock(lock)
            self.assertEqual(denied, [])
            self.assertFalse(
                os.path.exists(f"{journal}{bash_module._JOURNAL_WRITE_LOCK_SUFFIX}")
            )

    def test_control_socket_fds_close_when_supervisor_spawn_fails(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX-only fds")
        acquired: list[int] = []
        real_socketpair = socket.socketpair

        def capturing_socketpair(*args, **kwargs):
            pair = real_socketpair(*args, **kwargs)
            acquired.extend((pair[0].fileno(), pair[1].fileno()))
            return pair

        with mock.patch.object(bash_module.socket, "socketpair", capturing_socketpair):
            with mock.patch.object(
                bash_module.subprocess, "Popen", side_effect=OSError("spawn failed")
            ):
                with self.assertRaisesRegex(OSError, "spawn failed"):
                    bash("echo never")
        self.assertEqual(len(acquired), 2)
        for fd in acquired:
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_windows_process_start_id(self):
        completed = mock.Mock(stdout="638000000000000000\n")
        with mock.patch.dict(os.environ, {"SystemRoot": r"C:\WinTest"}):
            with mock.patch.object(bash_module.os, "name", "nt"):
                with mock.patch.object(
                    bash_module.subprocess, "run", return_value=completed
                ) as run:
                    self.assertEqual(bash_module._process_start_id(1234), "win:638000000000000000")
        argv = run.call_args.args[0]
        self.assertEqual(
            argv[0],
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        )
        self.assertEqual(
            run.call_args.kwargs["env"],
            {
                "SystemRoot": r"C:\Windows",
                "WINDIR": r"C:\Windows",
                "NoDefaultCurrentDirectoryInExePath": "1",
            },
        )
        self.assertIn("GetProcessById(1234)", argv[-1])
        invalid_outputs = (
            "not a number\n",
            "１２３\n",
            "1" * 33 + "\n",
            "",
            " \t\r\n",
        )
        with mock.patch.object(bash_module.os, "name", "nt"):
            for output in invalid_outputs:
                with self.subTest(output=repr(output)):
                    with mock.patch.object(
                        bash_module.subprocess, "run", return_value=mock.Mock(stdout=output)
                    ):
                        self.assertIsNone(bash_module._process_start_id(1234))

    def test_windows_taskkill_uses_canonical_binary_minimal_env_and_short_timeout(self):
        completed = mock.Mock(returncode=0)
        with mock.patch.dict(
            os.environ,
            {"SystemRoot": r"C:\Attacker", "PATH": r"C:\Attacker"},
        ):
            with mock.patch.object(bash_module.subprocess, "run", return_value=completed) as run:
                self.assertTrue(bash_module._taskkill_tree(1234))
        self.assertEqual(run.call_args.args[0][0], r"C:\Windows\System32\taskkill.exe")
        self.assertEqual(run.call_args.kwargs["timeout"], 2)
        self.assertEqual(
            run.call_args.kwargs["env"],
            {
                "SystemRoot": r"C:\Windows",
                "WINDIR": r"C:\Windows",
                "NoDefaultCurrentDirectoryInExePath": "1",
            },
        )

    async def test_cancelled_direct_await_kills_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "marker")
            pids: list[int] = []
            original_init = bash_module.BashHandle.__init__

            def capturing_init(handle_self, command):
                original_init(handle_self, command)
                pids.append(handle_self._pid)

            async def run_oneshot():
                await bash(f"sleep 1.0 && touch {marker}")

            with mock.patch.object(bash_module.BashHandle, "__init__", capturing_init):
                task = asyncio.ensure_future(run_oneshot())
                await asyncio.sleep(0.3)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            # The cancel path awaits confirmed group death before propagating.
            if bash_module._IS_POSIX:
                with self.assertRaises(ProcessLookupError):
                    os.killpg(pids[0], 0)
            await asyncio.sleep(1.0)
            self.assertFalse(os.path.exists(marker))

    async def test_cancelled_direct_await_escalates_past_term_trap(self):
        # A TERM-trapping command must be group-KILLed before the cancel
        # resolves, so its later side effects never land.
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "marker")
            pids: list[int] = []
            original_init = bash_module.BashHandle.__init__

            def capturing_init(handle_self, command):
                original_init(handle_self, command)
                pids.append(handle_self._pid)

            async def run_oneshot():
                await bash(f"trap '' TERM; sleep 1.0; touch {marker}; sleep 30")

            with mock.patch.object(bash_module, "_CANCEL_TERM_GRACE", 0.2):
                with mock.patch.object(bash_module.BashHandle, "__init__", capturing_init):
                    task = asyncio.ensure_future(run_oneshot())
                    await asyncio.sleep(0.2)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
            if bash_module._IS_POSIX:
                with self.assertRaises(ProcessLookupError):
                    os.killpg(pids[0], 0)
            await asyncio.sleep(1.2)
            self.assertFalse(os.path.exists(marker))

    async def test_background_handle_survives_cancel_of_creating_context(self):
        handles: list[bash_module.BashHandle] = []

        async def run_background():
            h = bash("sleep 30")
            handles.append(h)
            h.pid  # released as a deliberate background handle
            await asyncio.sleep(10)

        task = asyncio.ensure_future(run_background())
        await asyncio.sleep(0.3)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        handle = handles[0]
        try:
            os.killpg(handle._pid, 0)  # still alive
        finally:
            handle.kill(signal.SIGKILL)
        await asyncio.wait_for(handle, timeout=5)

    async def test_cancelling_await_on_released_handle_does_not_kill(self):
        handle = bash("sleep 30")
        self.assertTrue(handle.running)  # release as background handle

        async def wait_for_it():
            await handle

        task = asyncio.ensure_future(wait_for_it())
        await asyncio.sleep(0.3)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        try:
            os.killpg(handle._pid, 0)  # still alive
        finally:
            handle.kill(signal.SIGKILL)
        await asyncio.wait_for(handle, timeout=5)

    async def test_second_await_after_cancelled_oneshot_only_waits(self):
        handle = bash("echo done")
        # First await consumes the one-shot ownership; later awaits only wait.
        result = await handle
        self.assertEqual(result.exit_code, 0)
        self.assertTrue(handle._released)
        again = await handle
        self.assertEqual(again, result)

    async def test_second_cancel_during_cleanup_still_confirms_group_death(self):
        # Python 3.11: an await inside an except-CancelledError block of a
        # cancelled task is re-cancelled immediately; the shielded confirm task
        # must survive repeated cancels and the group must be dead on return.
        pids: list[int] = []
        original_init = bash_module.BashHandle.__init__

        def capturing_init(handle_self, command):
            original_init(handle_self, command)
            pids.append(handle_self._pid)

        async def run_oneshot():
            await bash("trap '' TERM; sleep 30")

        with mock.patch.object(bash_module, "_CANCEL_TERM_GRACE", 0.2):
            with mock.patch.object(bash_module.BashHandle, "__init__", capturing_init):
                task = asyncio.ensure_future(run_oneshot())
                await asyncio.sleep(0.2)
                task.cancel()
                await asyncio.sleep(0.05)
                task.cancel()  # lands inside the cleanup awaits
                await asyncio.sleep(0.05)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
        with self.assertRaises(ProcessLookupError):
            os.killpg(pids[0], 0)

    async def test_windows_without_bash_raises_teaching_error(self):
        # Windows must raise without consulting PATH: a which() hit would be
        # the same repo-controlled-PATH hole the host-side resolution closed.
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(
                bash_module.shutil, "which", return_value=r"C:\evil\bash.exe"
            ) as which:
                with self.assertRaisesRegex(RuntimeError, "PRIME_AGENT_BASH_SHELL"):
                    bash_module._shell()
                which.assert_not_called()

    async def test_pump_delayed_past_old_quiescence_bound_captures_all_output(self):
        # The ordered sentinel must wait through a pump delay beyond the old 500 ms bound.
        original_write = bash_module._BoundedBuffer.write
        delayed_once = threading.Event()

        def delayed_write(buffer_self, chunk):
            if not delayed_once.is_set():
                delayed_once.set()
                time.sleep(0.7)
            original_write(buffer_self, chunk)

        with mock.patch.object(bash_module._BoundedBuffer, "write", delayed_write):
            result = await asyncio.wait_for(bash("printf delayed-output-complete"), timeout=5)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.output, "delayed-output-complete")

    async def test_framed_output_split_across_small_reads_is_exact(self):
        with mock.patch.object(bash_module, "_READ_CHUNK", 7):
            result = await asyncio.wait_for(bash("printf exact-pre-fence-output"), timeout=5)
        self.assertEqual(result.output, "exact-pre-fence-output")

    async def test_slow_pump_does_not_lose_foreground_output(self):
        # Finalization waits for the pump to parse the ordered sentinel.
        original_pump = bash_module.BashHandle._pump

        def slow_pump(handle_self):
            time.sleep(0.3)
            original_pump(handle_self)

        with mock.patch.object(bash_module.BashHandle, "_pump", slow_pump):
            result = await asyncio.wait_for(bash("printf slow-pump-x"), timeout=5)
        self.assertEqual(result.exit_code, 0)
        self.assertIn("slow-pump-x", result.output)

    async def test_old_markers_execution_string_and_cmdline_cannot_forge_completion(self):
        raw_lookalike = "\x1eprime-agent-complete:not-this-invocation\x1f"
        command = (
            "printf '\036prime-agent-complete:not-this-invocation\037'\n"
            'printf \'\nexecution=%s\n\' "$BASH_EXECUTION_STRING"\n'
            "if [ -r /proc/$PPID/cmdline ]; then cat /proc/$PPID/cmdline; fi\n"
            "printf '\nafter-marker\n'\n"
            "exit 41"
        )
        handle = bash(command)
        result = await asyncio.wait_for(handle, timeout=5)
        self.assertEqual(result.exit_code, 41)
        self.assertIn(raw_lookalike, result.output)
        self.assertIn("execution=", result.output)
        self.assertIn("after-marker", result.output)
        self.assertNotIn(handle._control_token or "<missing>", result.output)

    async def test_user_alias_cannot_replace_completion_emitter(self):
        if os.path.basename(bash_module._shell()) != "bash":
            self.skipTest("bash alias expansion semantics")
        handle = bash(
            "shopt -s expand_aliases; alias command='printf alias-expanded'; sleep 30 &"
        )
        try:
            result = await asyncio.wait_for(handle, timeout=5)
            self.assertEqual(result.exit_code, 0)
            self.assertNotIn("alias-expanded", result.output)
        finally:
            handle.kill(signal.SIGKILL)
            await _poll_group_dead(handle.pid)
            await _poll_handle_reaped(handle)

    async def test_user_function_cannot_replace_completion_emitter(self):
        # The backslash in `\command` defeats alias expansion only: a shell
        # function named `command` would otherwise swallow both fence frames
        # and wedge the await behind the background job until shell death.
        handle = bash("command() { printf function-expanded; }; sleep 30 &")
        try:
            result = await asyncio.wait_for(handle, timeout=5)
            self.assertEqual(result.exit_code, 0)
            self.assertNotIn("function-expanded", result.output)
        finally:
            handle.kill(signal.SIGKILL)
            await _poll_group_dead(handle.pid)
            await _poll_handle_reaped(handle)

    async def test_shell_killed_before_normal_exit_reports_signal(self):
        result = await asyncio.wait_for(
            bash("printf output-before-shell-kill; kill -KILL $$"), timeout=5
        )
        self.assertEqual(result.exit_code, -signal.SIGKILL)
        self.assertIn("output-before-shell-kill", result.output)

    async def test_relative_bash_shell_override_rejected(self):
        with mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "bash"}):
            with self.assertRaises(ValueError):
                bash("echo hi")

    async def test_windows_journal_writes_only_enriched_record(self):
        # No pid-only pre-record on Windows: the kill-on-close job replaces it
        # (a kernel death reaps the tree via handle closure, so a bare-pid
        # anchor would only ever justify killing a reused pid).
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(
                os.environ,
                {**_initialized_journal_env(journal), "PRIME_AGENT_BASH_SHELL": "/bin/sh"},
            ):
                with mock.patch.object(bash_module, "_IS_POSIX", False):
                    with mock.patch.object(bash_module._winjob, "spawn_in_job", _win_spawn()):
                        with mock.patch.object(bash_module._winjob, "create_job", return_value=7):
                            with mock.patch.object(
                                bash_module._winjob, "terminate", return_value=True
                            ):
                                with mock.patch.object(bash_module._winjob, "close"):
                                    with mock.patch.object(
                                        bash_module, "_process_start_id", return_value="win:638000000000000011"
                                    ):
                                        handle = bash("echo hi")
                                        await asyncio.wait_for(handle, timeout=5)
                                    for _ in range(100):
                                        if handle._reaped:
                                            break
                                        await asyncio.sleep(0.05)
            active = [r for r in await _poll_journal(journal, count=1) if r["active"]]
            self.assertEqual(len(active), 1)
            self.assertIn("processStartId", active[0])

    async def test_windows_spawn_creates_child_inside_job(self):
        sentinel = 4242
        spawned = []
        order = []
        real_journal = bash_module._record_journal_transition
        base_spawn = _win_spawn(spawned)

        def journal(pid, state, **kwargs):
            order.append("journal")
            return real_journal(pid, state, **kwargs)

        def spawn(job, argv, cwd, env):
            order.append("spawn")
            proc = base_spawn(job, argv, cwd, env)
            proc.resume = mock.Mock(side_effect=lambda: order.append("resume") or True)
            return proc

        real_thread_start = threading.Thread.start

        def start_support_thread(thread):
            order.append(thread.name.split("-")[1])
            real_thread_start(thread)

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", spawn):
                with mock.patch.object(bash_module, "_record_journal_transition", journal):
                    with mock.patch.object(threading.Thread, "start", start_support_thread):
                        with mock.patch.object(
                            bash_module._winjob,
                            "create_job",
                            side_effect=lambda: order.append("create_job") or sentinel,
                        ):
                            handle = bash("sleep 30")
                try:
                    # All observers start while the child is still suspended;
                    # resume is the final setup commit.
                    self.assertEqual(spawned[-1].spawn_job, sentinel)
                    self.assertEqual(
                        spawned[-1].spawn_argv,
                        ["/bin/sh", "-c", bash_module._with_prefix("sleep 30")],
                    )
                    spawned[-1].resume.assert_called_once_with()
                    self.assertEqual(
                        order,
                        ["create_job", "spawn", "journal", "pump", "report", "watch", "resume"],
                    )
                    self.assertEqual(handle._job, sentinel)
                finally:
                    handle._job = None
                    handle.kill(signal.SIGKILL)
                    await asyncio.wait_for(handle, timeout=5)

    async def test_windows_support_thread_failure_kills_before_resume(self):
        sentinel = 4243
        spawned = []
        started: list[threading.Thread] = []
        real_thread_start = threading.Thread.start
        starts = 0

        def fail_third_start(thread):
            nonlocal starts
            starts += 1
            if starts == 3:
                raise RuntimeError("watch thread failed")
            real_thread_start(thread)
            started.append(thread)

        def terminate(job):
            spawned[0].kill()
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", _win_spawn(spawned)):
                with mock.patch.object(bash_module._winjob, "create_job", return_value=sentinel):
                    with mock.patch.object(bash_module._winjob, "terminate", side_effect=terminate):
                        with mock.patch.object(bash_module._winjob, "is_empty", return_value=True):
                            with mock.patch.object(bash_module._winjob, "close"):
                                with mock.patch.object(threading.Thread, "start", fail_third_start):
                                    with self.assertRaisesRegex(RuntimeError, "watch thread failed"):
                                        bash("sleep 30")
        spawned[0].resume.assert_not_called()
        self.assertIsNotNone(spawned[0].poll())
        self.assertTrue(all(not thread.is_alive() for thread in started))
        spawned[0].close.assert_called_once()

    async def test_windows_create_job_failure_fails_closed(self):
        journal_calls = []

        def journal(pid, state, **kwargs):
            active = state == "enrolled"
            journal_calls.append((pid, active))
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job") as spawn:
                with mock.patch.object(bash_module, "_record_journal_transition", journal):
                    with mock.patch.object(bash_module._winjob, "create_job", return_value=None):
                        with self.assertRaisesRegex(RuntimeError, "job containment"):
                            bash("sleep 30")
        # A create_job failure aborts before spawn_in_job: nothing spawned, nothing journaled.
        spawn.assert_not_called()
        self.assertEqual(journal_calls, [])

    async def test_windows_resume_failure_fails_closed(self):
        sentinel = 4343
        spawned = []
        journal_calls = []

        def journal(pid, state, **kwargs):
            active = state == "enrolled"
            journal_calls.append((pid, active))
            return True

        def terminate(job):
            # The abort kills the suspended, job-contained child via the job.
            spawned[0].kill()
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(
                bash_module._winjob, "spawn_in_job", _win_spawn(spawned, resume=False)
            ):
                with mock.patch.object(bash_module, "_record_journal_transition", journal):
                    with mock.patch.object(
                        bash_module._winjob, "create_job", return_value=sentinel
                    ):
                        with mock.patch.object(
                            bash_module._winjob, "terminate", side_effect=terminate
                        ) as term:
                            with mock.patch.object(bash_module._winjob, "close") as close:
                                with self.assertRaisesRegex(RuntimeError, "job containment"):
                                    bash("sleep 30")
        term.assert_called_once_with(sentinel)
        close.assert_called_once_with(sentinel)
        self.assertIsNotNone(spawned[0].poll())
        spawned[0].close.assert_called_once()
        self.assertEqual(journal_calls, [(spawned[0].pid, True)])

    async def test_windows_journal_enrollment_failure_kills_suspended_leader(self):
        # A journal failure must kill the suspended, job-contained leader and retire the record.
        sentinel = 4545
        spawned = []
        journal_calls = []

        def journal(pid, state, **kwargs):
            active = state == "enrolled"
            journal_calls.append((pid, active))
            return not active  # enrollment fails; the retirement write succeeds

        def terminate(job):
            spawned[0].kill()
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", _win_spawn(spawned)):
                with mock.patch.object(bash_module, "_record_journal_transition", journal):
                    with mock.patch.object(
                        bash_module._winjob, "create_job", return_value=sentinel
                    ):
                        with mock.patch.object(
                            bash_module._winjob, "terminate", side_effect=terminate
                        ) as term:
                            with mock.patch.object(bash_module._winjob, "close") as close:
                                with self.assertRaisesRegex(RuntimeError, "journal enrollment"):
                                    bash("sleep 30")
        term.assert_called_once_with(sentinel)
        close.assert_called_once_with(sentinel)
        spawned[0].resume.assert_not_called()
        self.assertIsNotNone(spawned[0].poll())
        self.assertEqual(journal_calls, [(spawned[0].pid, True)])

    async def test_windows_spawn_failure_closes_precreated_job(self):
        # A spawn_in_job failure must close the pre-created job and never touch the journal.
        sentinel = 4646
        journal_calls = []

        def journal(pid, state, **kwargs):
            active = state == "enrolled"
            journal_calls.append((pid, active))
            return True

        def spawn(job, argv, cwd, env):
            raise OSError("spawn failed")

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", spawn):
                with mock.patch.object(bash_module, "_record_journal_transition", journal):
                    with mock.patch.object(
                        bash_module._winjob, "create_job", return_value=sentinel
                    ):
                        with mock.patch.object(bash_module._winjob, "close") as close:
                            with self.assertRaises(OSError):
                                bash("sleep 30")
        close.assert_called_once_with(sentinel)
        self.assertEqual(journal_calls, [])

    async def test_windows_watch_taskkill_fallback_runs_before_process_handle_close(self):
        # PID-reuse guard: every taskkill-by-pid must run before the handle closes.
        order = []
        spawned = []
        handle_box = []
        ready, closed_done = threading.Event(), threading.Event()

        def spawn(job, argv, cwd, env):
            proc = _win_spawn(spawned)(job, argv, cwd, env)

            def record_close():
                order.append(("proc-close", handle_box[0]._reaped))
                closed_done.set()

            proc.close = mock.Mock(side_effect=record_close)
            return proc

        def terminate(job):
            assert ready.wait(timeout=5)  # gate: handle_box is filled first
            order.append("terminate")
            return False

        def taskkill(pid):
            order.append(("taskkill", spawned[0].close.called))
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", spawn):
                with mock.patch.object(bash_module._winjob, "create_job", return_value=777):
                    with mock.patch.object(bash_module._winjob, "terminate", terminate):
                        with mock.patch.object(
                            bash_module._winjob, "close",
                            side_effect=lambda job: order.append("job-close"),
                        ):
                            with mock.patch.object(bash_module, "_taskkill_tree", taskkill):
                                handle = bash("echo hi")
                                handle_box.append(handle)
                                ready.set()
                                await asyncio.wait_for(handle, timeout=5)
                                self.assertTrue(await asyncio.to_thread(closed_done.wait, 5))
        self.assertEqual(
            order, ["terminate", ("taskkill", False), "job-close", ("proc-close", True)]
        )

    async def test_windows_kill_blocked_during_watch_reap_never_taskkills_after_close(self):
        # kill() blocked on the reap lock must become a no-op, never a raw-pid taskkill.
        spawned = []
        entered, release = threading.Event(), threading.Event()

        def spawn(job, argv, cwd, env):
            return _win_spawn(spawned)(job, argv, cwd, env)

        def terminate(job):
            entered.set()
            assert release.wait(timeout=10)
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", spawn):
                with mock.patch.object(bash_module._winjob, "create_job", return_value=778):
                    with mock.patch.object(
                        bash_module._winjob, "terminate", side_effect=terminate
                    ) as term:
                        with mock.patch.object(bash_module._winjob, "close"):
                            with mock.patch.object(bash_module, "_taskkill_tree") as taskkill:
                                handle = bash("echo hi")
                                await asyncio.wait_for(handle, timeout=5)
                                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                                fut = asyncio.get_running_loop().run_in_executor(
                                    None, handle.kill
                                )
                                await asyncio.sleep(0.2)
                                self.assertFalse(fut.done())  # blocked on the reap lock
                                taskkill.assert_not_called()
                                release.set()
                                await asyncio.wait_for(fut, timeout=5)
                                for _ in range(100):
                                    if handle._reaped:
                                        break
                                    await asyncio.sleep(0.05)
        taskkill.assert_not_called()
        term.assert_called_once()
        spawned[0].close.assert_called_once()
        self.assertTrue(handle._reaped)

    async def test_kill_live_handles_skips_reaped_windows_handle(self):
        stale = mock.Mock(
            _spawned_posix=False,
            _lifecycle_lock=threading.RLock(),
            _lifecycle_state="reaped",
            _reaped=True,
            _job=5,
            _pid=999,
        )
        with mock.patch.object(bash_module, "_live_handles", {stale}):
            with mock.patch.object(bash_module, "_IS_POSIX", False):
                with mock.patch.object(bash_module._winjob, "terminate") as term:
                    with mock.patch.object(bash_module, "_taskkill_tree") as taskkill:
                        with mock.patch.object(bash_module, "_record_journal_transition") as journal:
                            bash_module._kill_live_handles()
        term.assert_not_called()
        taskkill.assert_not_called()
        stale._proc.kill.assert_not_called()
        journal.assert_not_called()


    async def test_kill_live_handles_blocked_on_abort_never_taskkills_after_close(self):
        # PID-reuse guard on the abort path: abort's reaped+close section must block
        # on _lifecycle_lock while a raw-pid taskkill is in flight, so the handle can
        # never close mid-taskkill.
        order = []
        spawned = []
        journal_calls = []
        entered, release_term = threading.Event(), threading.Event()
        stdout_entered, stdout_release = threading.Event(), threading.Event()
        tk_entered, tk_release = threading.Event(), threading.Event()

        def spawn(job, argv, cwd, env):
            proc = _win_spawn(spawned)(job, argv, cwd, env)
            proc.kill = mock.Mock()
            proc.close = mock.Mock(side_effect=lambda: order.append("proc-close"))
            real_stdout = proc.stdout

            def gated_close():
                # Parks abort between its two locked sections (lock released).
                stdout_entered.set()
                assert stdout_release.wait(timeout=10)
                real_stdout.close()

            proc.stdout = mock.Mock(close=mock.Mock(side_effect=gated_close))
            return proc

        def journal(pid, state, **kwargs):
            active = state == "enrolled"
            journal_calls.append((pid, active))
            return not active  # enrollment fails -> _abort_spawn; retirement succeeds

        def terminate(job):
            order.append("abort-terminate")
            entered.set()
            assert release_term.wait(timeout=10)
            return True

        def taskkill(pid):
            # Blocks INSIDE the killer's locked section: abort must wait on the lock.
            order.append(("killer-taskkill", spawned[0].close.called))
            tk_entered.set()
            assert tk_release.wait(timeout=10)
            return True

        self.enterContext(mock.patch.dict(os.environ, {"PRIME_AGENT_BASH_SHELL": "/bin/sh"}))
        loop = asyncio.get_running_loop()
        with mock.patch.object(bash_module, "_IS_POSIX", False):
            with mock.patch.object(bash_module._winjob, "spawn_in_job", spawn):
                with mock.patch.object(bash_module._winjob, "create_job", return_value=900):
                    with mock.patch.object(
                        bash_module._winjob, "terminate", side_effect=terminate
                    ) as term:
                        with mock.patch.object(
                            bash_module._winjob, "close",
                            side_effect=lambda job: order.append("abort-jobclose"),
                        ):
                            with mock.patch.object(bash_module._winjob, "is_empty", return_value=True):
                                with mock.patch.object(bash_module, "_record_journal_transition", journal):
                                    with mock.patch.object(
                                        bash_module, "_taskkill_tree", side_effect=taskkill
                                    ):
                                        ctor = loop.run_in_executor(
                                            None, lambda: bash("echo hi")
                                        )
                                        self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                                        with bash_module._live_lock:
                                            subject = next(
                                                handle
                                                for handle in bash_module._live_handles
                                                if handle._pid == spawned[0].pid
                                            )
                                        try:
                                            with mock.patch.object(
                                                bash_module, "_live_handles", {subject}
                                            ):
                                                # Phase 1: abort holds _lifecycle_lock -> the killer blocks.
                                                killer = loop.run_in_executor(
                                                    None, bash_module._kill_live_handles
                                                )
                                                await asyncio.sleep(0.2)
                                                self.assertFalse(killer.done())
                                                self.assertFalse(tk_entered.is_set())
                                                # Phase 2: abort parks at stdout; the killer takes the
                                                # lock and blocks inside taskkill while holding it.
                                                release_term.set()
                                                self.assertTrue(
                                                    await asyncio.to_thread(tk_entered.wait, 5)
                                                )
                                                stdout_release.set()
                                                # Abort finishes stdout/wait but must block on the
                                                # lock: close cannot run while taskkill is in flight.
                                                await asyncio.sleep(0.3)
                                                self.assertFalse(ctor.done())
                                                self.assertFalse(spawned[0].close.called)
                                                # Phase 3: taskkill returns, killer releases the lock,
                                                # abort's reaped+close section finally runs.
                                                tk_release.set()
                                                with self.assertRaisesRegex(RuntimeError, "journal"):
                                                    await asyncio.wait_for(ctor, timeout=10)
                                                await asyncio.wait_for(killer, timeout=10)
                                        finally:
                                            with bash_module._live_lock:
                                                bash_module._live_handles.discard(subject)
        self.assertEqual(
            order,
            ["abort-terminate", "abort-jobclose", ("killer-taskkill", False), "proc-close"],
        )
        self.assertEqual(spawned[0].close.call_count, 1)  # once, only after taskkill returned
        term.assert_called_once()  # the killer saw _job None; no second terminate
        spawned[0].kill.assert_not_called()
        pid = spawned[0].pid
        self.assertEqual([call for call in journal_calls if call[0] == pid], [(pid, True)])

    async def test_windows_job_reap_and_kill(self):
        handle = bash("sleep 30")
        job = 777
        handle._job = job
        try:
            with mock.patch.object(bash_module, "_IS_POSIX", False):
                with mock.patch.object(bash_module, "_taskkill_tree") as taskkill:
                    with mock.patch.object(bash_module._winjob, "terminate", return_value=True) as term:
                        with mock.patch.object(bash_module._winjob, "close") as close:
                            with mock.patch.object(bash_module._winjob, "is_empty", return_value=False):
                                self.assertTrue(handle._group_alive())
                            with mock.patch.object(bash_module._winjob, "is_empty", return_value=True):
                                self.assertFalse(handle._group_alive())
                            handle.kill()
                            term.assert_called_once_with(job)
                            term.reset_mock()
                            # Reap retires only after job accounting observes no live process.
                            with mock.patch.object(bash_module._winjob, "is_empty", return_value=True):
                                self.assertTrue(handle._reap_group())
                            term.assert_called_once_with(job)
                            close.assert_called_once_with(job)
                            self.assertIsNone(handle._job)
                            handle._reaped = True
                            handle.kill()  # job-reaped: no taskkill second chance
                    taskkill.assert_not_called()
        finally:
            handle._reaped = False
            handle._job = None
            handle.kill(signal.SIGKILL)
            await asyncio.wait_for(handle, timeout=5)

    async def test_windows_failed_job_terminate_falls_back_to_taskkill(self):
        handle = bash("sleep 30")
        job = 888
        handle._job = job
        try:
            with mock.patch.object(bash_module, "_IS_POSIX", False):
                with mock.patch.object(bash_module._winjob, "terminate", return_value=False):
                    with mock.patch.object(bash_module._winjob, "close") as close:
                        with mock.patch.object(
                            bash_module, "_taskkill_tree", return_value=True
                        ) as taskkill:
                            handle.kill()  # failed terminate must not strand the tree
                            taskkill.assert_called_once_with(handle._pid)
                            taskkill.reset_mock()
                            # Taskkill delivery is not enough; job accounting supplies exact death.
                            with mock.patch.object(bash_module._winjob, "is_empty", return_value=True):
                                self.assertTrue(handle._reap_group())
                            close.assert_called_once_with(job)
                            taskkill.assert_called_once_with(handle._pid)
                            self.assertIsNone(handle._job)
        finally:
            handle._reaped = False
            handle._job = None
            handle.kill(signal.SIGKILL)
            await asyncio.wait_for(handle, timeout=5)

    async def test_windows_failed_terminate_and_taskkill_leaves_record_active(self):
        # Failed terminate + failed taskkill on an exited leader: nothing
        # proved the tree died, so the record stays active for the host reaper.
        handle = bash("echo hi")
        await asyncio.wait_for(handle, timeout=5)
        for _ in range(100):
            if handle._proc.poll() is not None:
                break
            await asyncio.sleep(0.05)
        self.assertIsNotNone(handle._proc.poll())
        handle._job = 999
        try:
            with mock.patch.object(bash_module, "_IS_POSIX", False):
                with mock.patch.object(bash_module._winjob, "terminate", return_value=False):
                    with mock.patch.object(bash_module._winjob, "close"):
                        with mock.patch.object(
                            bash_module, "_taskkill_tree", return_value=False
                        ):
                            self.assertFalse(handle._reap_group())
                            self.assertIsNone(handle._job)
        finally:
            handle._job = None

    def test_darwin_start_id_uses_absolute_ps(self):
        completed = mock.Mock(stdout="Mon Jan  1 00:00:00 2026\n")
        with mock.patch.object(bash_module.sys, "platform", "darwin"):
            with mock.patch("builtins.open", side_effect=OSError):
                with mock.patch.object(bash_module.subprocess, "run", return_value=completed) as run:
                    self.assertEqual(
                        bash_module._process_start_id(1234), "ps:lstart:Mon Jan 1 00:00:00 2026"
                    )
        self.assertEqual(run.call_args.args[0][0], "/bin/ps")

    def test_portable_identity_hint_parser_requires_canonical_utf8_payload(self):
        canonical = "ps:lstart:Mon Sep 1 03:00:00 2026"
        self.assertEqual(bash_module._normalize_portable_process_identity_hint(canonical), canonical)
        self.assertEqual(
            len(bash_module._normalize_portable_process_identity_hint("ps:lstart:" + "a" * 1024)),
            len("ps:lstart:") + 1024,
        )
        invalid = (
            "ps:Mon Sep 1 03:00:00 2026",
            "ps:lstart: Mon Sep 1 03:00:00 2026",
            "ps:lstart:Mon  Sep 1 03:00:00 2026",
            "ps:lstart:Mon\tSep 1 03:00:00 2026",
            "ps:lstart:Mon\nSep 1 03:00:00 2026",
            "ps:lstart:Mon\rSep 1 03:00:00 2026",
            "ps:lstart:Mon\x00Sep 1 03:00:00 2026",
            "ps:lstart:Mon\x07Sep 1 03:00:00 2026",
            "ps:lstart:Mon\u0085Sep 1 03:00:00 2026",
            "ps:lstart:" + "\ud800",
            "ps:lstart:é",
            "ps:lstart:\ufffd",
            "ps:lstart:" + "é" * 513,
            "ps:lstart:" + "a" * 1025,
        )
        for value in invalid:
            with self.subTest(value=repr(value[:40])):
                self.assertIsNone(bash_module._normalize_portable_process_identity_hint(value))
                self.assertFalse(bash_module._is_coarse_process_identity(value))

        retained = ("ps:historical-value", canonical, "ps:" + "é" * 512)
        rejected = (
            "ps:",
            "ps:tab\tvalue",
            "ps:c1\u0085value",
            "ps:line\nvalue",
            "ps:nul\x00value",
            "ps:" + "é" * 513,
            "ps:" + "a" * 1025,
            "ps:" + "\ud800",
        )
        for value in retained:
            self.assertTrue(bash_module._is_retained_coarse_process_identity(value))
            lock = _valid_lock_record(processIdentityHint=value, processStartId=None)
            self.assertIsNotNone(bash_module._journal_write_lock_record(json.dumps(lock).encode()))
        for value in rejected:
            self.assertFalse(bash_module._is_retained_coarse_process_identity(value))
            lock = _valid_lock_record(processIdentityHint=value, processStartId=None)
            self.assertIsNone(bash_module._journal_write_lock_record(json.dumps(lock).encode()))

    def test_darwin_process_identity_fails_closed_on_invalid_ps_bytes(self):
        decode_error = UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")
        with mock.patch.object(bash_module.sys, "platform", "darwin"):
            with mock.patch("builtins.open", side_effect=OSError):
                with mock.patch.object(bash_module.subprocess, "run", side_effect=decode_error):
                    self.assertIsNone(bash_module._process_start_id(1234))

    def test_darwin_lstart_rejects_control_and_oversize_outputs(self):
        invalid_outputs = (
            "Mon Jan 1 00:00:00 2026\nother\n",
            "Mon Jan 1 00:00:00 2026\x00",
            "Mon Jan 1 00:00:00 2026\r\n",
            "é" * 513,
            "a" * 1025,
        )
        with mock.patch.object(bash_module.sys, "platform", "darwin"):
            with mock.patch("builtins.open", side_effect=OSError):
                for output in invalid_outputs:
                    with self.subTest(output=repr(output[:40])):
                        command = mock.Mock(stdout="python gate.py\n")
                        lstart = mock.Mock(stdout=output)
                        with mock.patch.object(
                            bash_module.subprocess, "run", side_effect=[command, lstart]
                        ):
                            self.assertIsNone(bash_module._process_start_id(1234))

    def test_darwin_start_id_resolves_delimiter_bounded_owner_token_exactly(self):
        token = "a" * 64
        completed = mock.Mock(stdout=f"python prime-agent-owner-token={token}\n")
        with mock.patch.object(bash_module.sys, "platform", "darwin"):
            with mock.patch("builtins.open", side_effect=OSError):
                with mock.patch.object(bash_module.subprocess, "run", return_value=completed):
                    self.assertEqual(bash_module._process_start_id(1234), f"token:{token}")
        self.assertTrue(bash_module._is_exact_process_identity(f"token:{token}"))

    async def test_undelivered_supervisor_signal_leaves_journal_record_active(self):
        if not bash_module._IS_POSIX:
            self.skipTest("POSIX supervisor semantics")
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                handle = bash("sleep 30")
                try:
                    records = await _poll_journal(journal, count=1)
                    self.assertTrue(records[-1]["active"])
                    with mock.patch.object(
                        handle, "_send_supervisor_signal_locked", return_value=False
                    ):
                        with mock.patch.object(bash_module, "_live_handles", {handle}):
                            bash_module._kill_live_handles()
                    await asyncio.sleep(0.2)
                    records = await _poll_journal(journal, count=1)
                    self.assertEqual(len(records), 1)
                    self.assertTrue(records[-1]["active"])
                finally:
                    handle.kill(signal.SIGKILL)
                    await asyncio.wait_for(handle, timeout=5)



    async def test_journal_configured_but_unwritable_kills_child_and_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "marker")
            pids: list[int] = []
            real_popen = subprocess.Popen

            def capturing_popen(*args, **kwargs):
                proc = real_popen(*args, **kwargs)
                pids.append(proc.pid)
                return proc

            with mock.patch.dict(
                os.environ,
                {
                    bash_module._JOURNAL_PATH_ENV: tmp,  # a directory: open fails
                    bash_module._JOURNAL_GENERATION_ENV: "test-generation",
                    bash_module._KERNEL_ADMISSION_PROTOCOL_ENV: bash_module._KERNEL_ADMISSION_PROTOCOL_VERSION,
                    bash_module._KERNEL_ADMISSION_GENERATION_ENV: "12345678-1234-4234-8234-123456789abc",
                    bash_module._KERNEL_LINEAGE_ENV: "a" * 64,
                    bash_module._KERNEL_PID_ENV: str(os.getpid()),
                    bash_module._KERNEL_PROCESS_START_ID_ENV: "token:" + "b" * 64,
                    "PRIME_AGENT_KERNEL_OWNER_PID": str(os.getpid()),
                },
            ):
                with mock.patch.object(bash_module.subprocess, "Popen", capturing_popen):
                    with self.assertRaises(RuntimeError):
                        bash(f"touch {marker}")
            await _poll_group_dead(pids[0])
            await asyncio.sleep(0.2)
            self.assertFalse(os.path.exists(marker))
            with bash_module._live_lock:
                self.assertFalse(any(handle._pid in pids for handle in bash_module._live_handles))

    async def test_journal_bad_owner_pid_rejects(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(os.environ, _initialized_journal_env(journal, "notanint")):
                with self.assertRaises(RuntimeError):
                    bash("echo hi")

    async def test_missing_start_id_rejects_when_configured(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                with mock.patch.object(bash_module, "_process_start_id", return_value=None):
                    with self.assertRaises(RuntimeError):
                        bash("sleep 30")

    async def test_journal_lock_reclaims_only_expired_exact_dead_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            env = _initialized_journal_env(journal)
            lock_path = f"{journal}{bash_module._JOURNAL_WRITE_LOCK_SUFFIX}"
            current_start_id = bash_module._process_start_id(os.getpid())
            self.assertIsNotNone(current_start_id)
            expired = datetime.now(timezone.utc).timestamp() - 60

            def write_lock(owner_pid, owner_start_id, token):
                record = {
                    "version": 1,
                    "ownerPid": owner_pid,
                    "processStartId": owner_start_id,
                    "token": token,
                    "createdAt": datetime.fromtimestamp(expired, timezone.utc).isoformat(),
                    "expiresAt": datetime.fromtimestamp(expired, timezone.utc).isoformat(),
                }
                with open(lock_path, "w") as lock_file:
                    json.dump(record, lock_file)
                    lock_file.write("\n")

            with mock.patch.dict(os.environ, env):
                write_lock(os.getpid(), current_start_id, "b" * 64)
                with mock.patch.object(bash_module, "_JOURNAL_WRITE_LOCK_TIMEOUT", 0.02):
                    self.assertFalse(bash_module._enroll_journal(os.getpid()))
                with open(lock_path) as lock_file:
                    self.assertEqual(json.load(lock_file)["token"], "b" * 64)

                write_lock(2_000_000_000, "proc:1", "123e4567-e89b-42d3-a456-426614174000")
                with mock.patch.object(bash_module, "_process_start_id", return_value=_EXACT_PROC_10):
                    self.assertTrue(bash_module._enroll_journal(os.getpid()))
                self.assertFalse(os.path.exists(lock_path))

    async def test_journal_lock_full_record_replacement_and_release_reclaimer_race(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            env = _initialized_journal_env(journal)
            lock_path = f"{journal}{bash_module._JOURNAL_WRITE_LOCK_SUFFIX}"
            with mock.patch.dict(os.environ, env):
                first = bash_module._acquire_journal_write_lock(journal)
                self.assertIsNotNone(first)
                replacement = _valid_lock_record(token="c" * 64)
                replacement_path = f"{lock_path}.replacement"
                with open(replacement_path, "w") as lock_file:
                    json.dump(replacement, lock_file)
                    lock_file.write("\n")
                os.replace(replacement_path, lock_path)
                bash_module._release_journal_write_lock(first)
                with open(lock_path) as lock_file:
                    self.assertEqual(json.load(lock_file), replacement)

                second = bash_module._acquire_journal_write_lock(journal)
                self.assertIsNotNone(second)
                with open(lock_path) as lock_file:
                    held = json.load(lock_file)
                stale = dict(held)
                expired = datetime.fromtimestamp(time.time() - 60, timezone.utc).isoformat()
                stale.update(ownerPid=2_000_000_000, createdAt=expired, expiresAt=expired)
                with open(lock_path, "w") as lock_file:
                    json.dump(stale, lock_file)
                    lock_file.write("\n")
                bash_module._release_journal_write_lock(second)
                with open(lock_path) as lock_file:
                    self.assertEqual(json.load(lock_file), stale)
                third = bash_module._acquire_journal_write_lock(journal)
                self.assertIsNotNone(third)
                bash_module._release_journal_write_lock(third)
                self.assertFalse(os.path.exists(lock_path))

    async def test_journal_lock_rejects_malformed_and_unsafe_or_abandoned_claims(self):
        scenarios = (
            "malformed",
            "overlong",
            "uppercase",
            "unknown-live",
            "claims-symlink",
            "claims-mode",
            "marker-symlink",
            "abandoned",
        )
        for scenario in scenarios:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as tmp:
                journal = os.path.join(tmp, "journal.jsonl")
                _initialized_journal_env(journal)
                lock_path = f"{journal}{bash_module._JOURNAL_WRITE_LOCK_SUFFIX}"
                token = {
                    "malformed": "../escape",
                    "overlong": "d" * 65,
                    "uppercase": "D" * 64,
                }.get(scenario, "d" * 64)
                record = _valid_lock_record(token=token)
                if scenario == "unknown-live":
                    record["ownerPid"] = os.getpid()
                    record.pop("processStartId")
                with open(lock_path, "w") as lock_file:
                    json.dump(record, lock_file)
                    lock_file.write("\n")
                claims_path = f"{lock_path}{bash_module._JOURNAL_WRITE_LOCK_CLAIMS_SUFFIX}"
                if scenario == "claims-symlink":
                    target = os.path.join(tmp, "claims-target")
                    os.mkdir(target, 0o700)
                    os.symlink(target, claims_path)
                elif scenario == "claims-mode":
                    os.mkdir(claims_path, 0o755)
                    os.chmod(claims_path, 0o755)
                elif scenario in {"marker-symlink", "abandoned"}:
                    os.mkdir(claims_path, 0o700)
                    os.chmod(claims_path, 0o700)
                    marker = os.path.join(claims_path, token)
                    if scenario == "marker-symlink":
                        target = os.path.join(tmp, "marker-target")
                        with open(target, "w") as target_file:
                            target_file.write("target\n")
                        os.symlink(target, marker)
                    else:
                        with open(marker, "w") as marker_file:
                            marker_file.write("abandoned\n")
                with mock.patch.object(bash_module, "_JOURNAL_WRITE_LOCK_TIMEOUT", 0.02):
                    self.assertIsNone(bash_module._acquire_journal_write_lock(journal))
                self.assertTrue(os.path.exists(lock_path))

    async def test_journal_lock_removes_only_its_own_claim_inode(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = os.path.join(tmp, "journal.append.lock")
            record = _valid_lock_record(token="e" * 64)
            claim = bash_module._claim_journal_write_lock_removal(lock_path, record)
            self.assertIsNotNone(claim)
            marker_path = claim.path
            with open(marker_path) as marker_file:
                marker = json.load(marker_file)
            self.assertEqual(marker["lockRecord"], record)
            self.assertEqual(marker["claimer"]["ownerPid"], os.getpid())
            self.assertRegex(marker["claimer"]["token"], r"^[0-9a-f]{64}$")
            os.unlink(marker_path)
            with open(marker_path, "w") as replacement:
                replacement.write("replacement\n")
            bash_module._release_journal_write_lock_removal_claim(claim)
            with open(marker_path) as replacement:
                self.assertEqual(replacement.read(), "replacement\n")

    async def test_journal_candidate_artifact_never_authorizes_deletion(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            _initialized_journal_env(journal)
            lock_path = f"{journal}{bash_module._JOURNAL_WRITE_LOCK_SUFFIX}"
            artifact = f"{lock_path}.candidate-1-{'f' * 64}"
            with open(artifact, "w") as artifact_file:
                json.dump(_valid_lock_record(token="f" * 64), artifact_file)
                artifact_file.write("\n")
            lock = bash_module._acquire_journal_write_lock(journal)
            self.assertIsNotNone(lock)
            bash_module._release_journal_write_lock(lock)
            self.assertTrue(os.path.exists(artifact))
            self.assertFalse(os.path.exists(lock_path))

    async def test_linux_exact_identity_matches_typescript_boot_qualified_format(self):
        fields = ["S", *[str(index) for index in range(1, 19)], "987654321"]
        process_stat = f"42 (worker) {' '.join(fields)}\n".encode("ascii")

        def identity_for_boot(boot_id: str | OSError):
            order: list[str] = []

            def fake_read(path, max_bytes=bash_module._JOURNAL_WRITE_LOCK_MAX_BYTES):
                order.append(path)
                if path == "/proc/sys/kernel/random/boot_id":
                    if isinstance(boot_id, OSError):
                        raise boot_id
                    return (boot_id + "\n").encode("ascii")
                if path == "/proc/42/stat":
                    return process_stat
                raise FileNotFoundError(path)

            with mock.patch.object(bash_module.sys, "platform", "linux"):
                with mock.patch.object(bash_module, "_cached_linux_boot_id", None):
                    with mock.patch.object(
                        bash_module, "_read_linux_identity_file", side_effect=fake_read
                    ):
                        identity = bash_module._process_start_id(42)
            self.assertEqual(
                order,
                ["/proc/sys/kernel/random/boot_id", "/proc/42/stat"]
                if identity is not None
                else ["/proc/sys/kernel/random/boot_id"],
            )
            return identity

        identity = identity_for_boot(_LINUX_BOOT_ID)
        self.assertEqual(identity, f"proc:{_LINUX_BOOT_ID}:987654321")
        self.assertTrue(bash_module._is_exact_process_identity(identity))
        self.assertEqual(bash_module._project_legacy_process_identity(identity), "proc:987654321")
        self.assertEqual(
            bash_module._journal_identity_record_fields(identity, "processStartId", "authorityProcessStartId"),
            {"authorityProcessStartId": identity},
        )
        self.assertEqual(bash_module._project_legacy_process_identity("win:42"), "win:42")
        self.assertTrue(bash_module._is_exact_process_identity("win:" + "1" * 32))
        self.assertFalse(bash_module._is_exact_process_identity("win:" + "1" * 33))
        self.assertFalse(bash_module._is_exact_process_identity("win:１２３"))
        self.assertFalse(bash_module._is_exact_process_identity("win:000123"))
        self.assertTrue(bash_module._is_exact_process_identity(f"proc:{_LINUX_BOOT_ID}:0"))
        self.assertFalse(bash_module._is_exact_process_identity(f"proc:{_LINUX_BOOT_ID}:00123"))
        self.assertTrue(
            bash_module._is_exact_process_identity(
                f"proc:{_LINUX_BOOT_ID}:18446744073709551615"
            )
        )
        self.assertFalse(
            bash_module._is_exact_process_identity(
                f"proc:{_LINUX_BOOT_ID}:18446744073709551616"
            )
        )
        self.assertFalse(bash_module._is_legacy_process_identity("proc:00123"))
        self.assertFalse(
            bash_module._is_legacy_process_identity("proc:18446744073709551616")
        )
        self.assertIsNone(bash_module._project_legacy_process_identity(f"token:{'a' * 64}"))
        self.assertIsNone(identity_for_boot("AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee"))
        self.assertIsNone(identity_for_boot(OSError("boot id unavailable")))

    async def test_linux_identity_byte_contract_rejects_adversarial_inputs(self):
        fields = ["S", *[str(index) for index in range(1, 19)], "987"]
        valid_stat = f"42 (worker with ) delimiter) {' '.join(fields)}\n".encode("ascii")
        self.assertEqual(bash_module._parse_linux_boot_id(_LINUX_BOOT_ID.encode()), _LINUX_BOOT_ID)
        self.assertEqual(bash_module._parse_linux_boot_id((_LINUX_BOOT_ID + "\n").encode()), _LINUX_BOOT_ID)
        self.assertEqual(bash_module._parse_linux_process_start_ticks(42, valid_stat), "987")

        letter_boot_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        invalid_boot_ids = [
            f" {letter_boot_id}".encode(),
            f"{letter_boot_id} ".encode(),
            f"{letter_boot_id}\t".encode(),
            f"{letter_boot_id}\r\n".encode(),
            f"{letter_boot_id}\n\n".encode(),
            letter_boot_id.upper().encode(),
            b"\xff",
            b"a" * (16 * 1024 + 1),
        ]
        for data in invalid_boot_ids:
            self.assertIsNone(bash_module._parse_linux_boot_id(data))

        simple_stat = f"42 (worker) {' '.join(fields)}\n".encode("ascii")
        last_delimiter = simple_stat.rfind(b") ")
        invalid_stats = [
            valid_stat.replace(b"42 ", b"43 ", 1),
            simple_stat[:last_delimiter] + b")X" + simple_stat[last_delimiter + 2 :],
            valid_stat.replace(b"987", b" 987"),
            valid_stat.replace(b"987", "９８７".encode()),
            valid_stat.replace(b"987", b"00123"),
            valid_stat.replace(b"987", b"18446744073709551616"),
            valid_stat.replace(b" S ", b"\tS "),
            b"\xff",
            b"a" * (16 * 1024 + 1),
        ]
        for data in invalid_stats:
            self.assertIsNone(bash_module._parse_linux_process_start_ticks(42, data))

        opaque_comm = b"42 (worker-\xff) " + b" ".join(field.encode("ascii") for field in fields) + b"\n"
        self.assertEqual(bash_module._parse_linux_process_start_ticks(42, opaque_comm), "987")

        suffix = valid_stat[valid_stat.rfind(b") ") :]
        exact_limit = b"42 (" + b"a" * (16 * 1024 - len(b"42 (") - len(suffix)) + suffix
        self.assertEqual(len(exact_limit), 16 * 1024)
        self.assertEqual(bash_module._parse_linux_process_start_ticks(42, exact_limit), "987")

        with tempfile.TemporaryDirectory() as tmp:
            regular = os.path.join(tmp, "identity")
            link = os.path.join(tmp, "identity-link")
            with open(regular, "wb") as file:
                file.write(_LINUX_BOOT_ID.encode())
            os.symlink(regular, link)
            self.assertEqual(bash_module._read_linux_identity_file(regular), _LINUX_BOOT_ID.encode())
            with self.assertRaises(OSError):
                bash_module._read_linux_identity_file(link)
            with open(regular, "wb") as file:
                file.write(b"a" * (16 * 1024))
            self.assertEqual(len(bash_module._read_linux_identity_file(regular)), 16 * 1024)
            with open(regular, "ab") as file:
                file.write(b"a")
            with self.assertRaises(OSError):
                bash_module._read_linux_identity_file(regular)

    async def test_linux_identity_failure_reprobes_presence_with_shared_taxonomy(self):
        cases = [
            ([True, False], ("absent", None)),
            ([True, True], ("present-unknown", None)),
            ([True, None], ("probe-uncertain", None)),
            ([None], ("probe-uncertain", None)),
        ]
        for presence, expected in cases:
            with mock.patch.object(bash_module, "_pid_exists", side_effect=presence):
                with mock.patch.object(bash_module, "_process_start_id", return_value=None):
                    self.assertEqual(bash_module._process_identity_observation(42), expected)

    async def test_old_bare_proc_kernel_env_fails_before_spawning_user_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            marker = os.path.join(tmp, "user-code-ran")
            environment = _initialized_journal_env(journal)
            environment[bash_module._KERNEL_PROCESS_START_ID_ENV] = "proc:123"
            with mock.patch.dict(os.environ, environment, clear=False):
                with mock.patch.object(bash_module.subprocess, "Popen") as popen:
                    with self.assertRaisesRegex(
                        RuntimeError,
                        "kernel admission protocol/version or exact identity mismatch",
                    ):
                        bash(f"echo ran > {marker}")
            popen.assert_not_called()
            self.assertFalse(os.path.exists(marker))

    async def test_journal_enrollment_rejects_coarse_child_identity(self):
        # Every admitted bash enrollment requires an exact child identity.
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                with mock.patch.object(
                    bash_module, "_process_start_id", return_value="ps:lstart:Mon Jan 1 00:00:00 2026"
                ):
                    self.assertFalse(bash_module._enroll_journal(os.getpid()))
            with open(journal) as journal_file:
                records = [json.loads(line) for line in journal_file if line.strip()]
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["type"], "authority")

    async def test_python_reducer_keeps_bare_anchor_and_uses_tri_state_proof(self):
        bare = (101, None)
        coarse = (101, "ps:lstart:hint")
        legacy = (101, "proc:10")
        absent = lambda _pid: ("absent", None)
        present = lambda _pid: ("present-unknown", None)
        exact_same = lambda _pid: ("present-exact", _EXACT_PROC_10)
        exact_other = lambda _pid: ("present-exact", _EXACT_PROC_11)

        for candidate in (bare, coarse, legacy):
            self.assertFalse(
                bash_module._journal_candidate_signal_authorized(
                    *candidate, caller_has_authority=True, identity_probe=exact_same
                )
            )
            self.assertFalse(
                bash_module._journal_candidate_cleanup_proven(
                    *candidate,
                    platform="linux",
                    identity_probe=present,
                    group_probe=lambda _pid: "absent",
                )
            )
            self.assertTrue(
                bash_module._journal_candidate_cleanup_proven(
                    *candidate,
                    platform="linux",
                    identity_probe=absent,
                    group_probe=lambda _pid: "absent",
                )
            )
            self.assertFalse(
                bash_module._journal_candidate_cleanup_proven(
                    *candidate,
                    platform="linux",
                    identity_probe=absent,
                    group_probe=lambda _pid: "present",
                )
            )
            self.assertFalse(
                bash_module._journal_candidate_cleanup_proven(
                    *candidate,
                    platform="win32",
                    identity_probe=absent,
                    group_probe=lambda _pid: "unsupported",
                )
            )
            self.assertTrue(
                bash_module._journal_candidate_cleanup_proven(
                    *candidate,
                    platform="win32",
                    identity_probe=absent,
                    group_probe=lambda _pid: "unsupported",
                    windows_tree_empty_proven=True,
                )
            )

        exact = (101, _EXACT_PROC_10)
        self.assertTrue(
            bash_module._journal_candidate_signal_authorized(
                *exact, caller_has_authority=True, identity_probe=exact_same
            )
        )
        self.assertFalse(
            bash_module._journal_candidate_signal_authorized(
                *exact, caller_has_authority=False, identity_probe=exact_same
            )
        )
        self.assertFalse(
            bash_module._journal_candidate_cleanup_proven(
                *exact,
                platform="win32",
                identity_probe=absent,
                group_probe=lambda _pid: "unsupported",
            )
        )
        self.assertTrue(
            bash_module._journal_candidate_cleanup_proven(
                *exact,
                platform="win32",
                identity_probe=absent,
                group_probe=lambda _pid: "unsupported",
                windows_tree_empty_proven=True,
            )
        )
        self.assertTrue(
            bash_module._journal_candidate_cleanup_proven(
                *exact,
                platform="linux",
                identity_probe=exact_other,
                group_probe=lambda _pid: "absent",
            )
        )
        for group_state in ("present", "uncertain"):
            self.assertFalse(
                bash_module._journal_candidate_cleanup_proven(
                    *exact,
                    platform="linux",
                    identity_probe=exact_other,
                    group_probe=lambda _pid, state=group_state: state,
                )
            )

    async def test_python_record_reducer_keeps_bare_after_enrichment_and_inactive_hint(self):
        now = datetime.now(timezone.utc).isoformat()
        records = [
            {"version": 1, "pid": 101, "ownerPid": 202, "active": True, "recordedAt": now},
            {
                "version": 1,
                "pid": 101,
                "ownerPid": 202,
                "processStartId": "proc:10",
                "active": True,
                "recordedAt": now,
            },
            {"version": 1, "pid": 101, "ownerPid": 202, "active": False, "recordedAt": now},
            {
                "version": 2,
                "type": "authority",
                "generation": "g",
                "sequence": 0,
                "createdAt": now,
            },
        ]
        data = ("\n".join(json.dumps(record) for record in records) + "\n").encode()
        state = bash_module._strict_authority_state("journal", data, include_candidates=True)
        self.assertIsNotNone(state)
        self.assertEqual(
            state[2],
            frozenset(
                {
                    (202, 101, None, None, None, None, None),
                    (202, 101, "proc:10", None, None, None, None),
                }
            ),
        )

    async def test_python_reducer_round_trips_optional_and_exact_lineage_fields(self):
        now = "2026-01-01T00:00:00+00:00"
        generation = "g"
        old_process = {
            "version": 2,
            "type": "process",
            "generation": generation,
            "sequence": 1,
            "pid": 101,
            "ownerPid": 202,
            "processStartId": "proc:10",
            "state": "enrolled",
            "recordedAt": now,
        }
        new_process = {
            "version": 2,
            "type": "process",
            "generation": generation,
            "sequence": 2,
            "pid": 102,
            "ownerPid": 202,
            "kernelPid": 303,
            "kernelProcessStartId": "proc:10",
            "kernelAuthorityProcessStartId": _EXACT_PROC_10,
            "admissionGeneration": "12345678-1234-4234-8234-123456789abc",
            "kernelLineage": "c" * 64,
            "processStartId": "proc:11",
            "authorityProcessStartId": _EXACT_PROC_11,
            "state": "enrolled",
            "recordedAt": now,
        }
        records = [
            {
                "version": 2,
                "type": "authority",
                "generation": generation,
                "sequence": 0,
                "createdAt": now,
            },
            old_process,
            new_process,
            {**new_process, "sequence": 3, "state": "retired"},
        ]
        data = ("\n".join(json.dumps(record) for record in records) + "\n").encode()
        state = bash_module._strict_authority_state("journal", data, include_candidates=True)
        self.assertEqual(
            state,
            (
                generation,
                3,
                frozenset({(202, 101, "proc:10", None, None, None, None)}),
            ),
        )
        for legacy_field in ("processStartId", "kernelProcessStartId"):
            conflicting = {**new_process, "sequence": 1, legacy_field: "proc:999"}
            conflicting_data = (
                json.dumps(records[0]) + "\n" + json.dumps(conflicting) + "\n"
            ).encode()
            self.assertIsNone(
                bash_module._strict_authority_state(
                    "journal", conflicting_data, include_candidates=True
                )
            )

    async def test_invalid_utf8_journal_has_no_snapshot_or_transition(self):
        header = {
            "version": 2,
            "type": "authority",
            "generation": "g",
            "sequence": 0,
            "createdAt": "2026-01-01T00:00:00+00:00",
        }
        data = json.dumps(header).encode() + b"\n\xff\n"
        self.assertIsNone(
            bash_module._strict_authority_state("journal", data, include_candidates=True)
        )

    async def test_invalid_utf8_append_lock_is_pinned_without_append_or_unlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            environment = _initialized_journal_env(journal)
            with open(journal, "rb") as journal_file:
                before = journal_file.read()
            lock_path = journal + ".append.lock"
            invalid = b"{\xff}"
            with open(lock_path, "wb") as lock_file:
                lock_file.write(invalid)
            with mock.patch.dict(os.environ, environment):
                with mock.patch.object(
                    bash_module,
                    "_process_start_id",
                    return_value="token:" + "b" * 64,
                ):
                    self.assertFalse(bash_module._enroll_journal(os.getpid()))
            with open(journal, "rb") as journal_file:
                self.assertEqual(journal_file.read(), before)
            with open(lock_path, "rb") as lock_file:
                self.assertEqual(lock_file.read(), invalid)

    async def test_journal_short_write_rejects_when_configured(self):
        # A partial os.write would leave a truncated JSON line the host
        # discards; enrollment must treat it as failure.
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")

            def short_write(fd, data):
                return 0  # no progress

            with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                with mock.patch.object(bash_module.os, "write", short_write):
                    self.assertFalse(bash_module._enroll_journal(os.getpid()))

    async def test_journal_enrollment_requires_complete_kernel_lineage(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            env = _initialized_journal_env(journal)
            env.pop(bash_module._KERNEL_LINEAGE_ENV)
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertFalse(bash_module._enroll_journal(os.getpid()))
            with open(journal) as journal_file:
                records = [json.loads(line) for line in journal_file if line.strip()]
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["type"], "authority")

    async def test_journal_partial_writes_complete_the_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            real_write = os.write

            def partial_write(fd, data):
                # One byte at a time: the loop must still write the full record.
                return real_write(fd, bytes(data)[:1])

            with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                with mock.patch.object(bash_module, "_process_start_id", return_value=_EXACT_PROC_10):
                    with mock.patch.object(bash_module.os, "write", partial_write):
                        self.assertTrue(bash_module._enroll_journal(os.getpid()))
            with open(journal) as f:
                records = [json.loads(line) for line in f if line.strip()]
            record = records[-1]
            self.assertEqual(record["pid"], os.getpid())
            self.assertEqual(record["state"], "enrolled")
            self.assertEqual(record["kernelPid"], os.getpid())
            self.assertNotIn("kernelProcessStartId", record)
            self.assertEqual(record["kernelAuthorityProcessStartId"], "token:" + "b" * 64)
            self.assertNotIn("processStartId", record)
            self.assertEqual(record["authorityProcessStartId"], _EXACT_PROC_10)
            self.assertEqual(
                record["admissionGeneration"],
                "12345678-1234-4234-8234-123456789abc",
            )
            self.assertEqual(record["kernelLineage"], "a" * 64)

    async def test_retirement_requires_matching_enrollment_and_explicit_death_proof(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                with mock.patch.object(bash_module, "_process_start_id", return_value=_EXACT_PROC_10):
                    self.assertTrue(bash_module._enroll_journal(os.getpid()))
                start_id = bash_module._journal_enrollment_start_id(os.getpid())
                self.assertIsNotNone(start_id)
                self.assertFalse(
                    bash_module._retire_journal(
                        os.getpid(),
                        start_id,
                        exact_death_proven=False,
                    )
                )
                self.assertFalse(
                    bash_module._retire_journal(
                        os.getpid(),
                        "wrong-start-id",
                        exact_death_proven=True,
                    )
                )
            with open(journal) as f:
                records = [json.loads(line) for line in f if line.strip()]
            self.assertEqual(records[-1]["state"], "enrolled")

    async def test_windows_retirement_requires_same_operation_held_job_empty_proof(self):
        with tempfile.TemporaryDirectory() as tmp:
            journal = os.path.join(tmp, "journal.jsonl")
            with mock.patch.dict(os.environ, _initialized_journal_env(journal)):
                with mock.patch.object(bash_module, "_process_start_id", return_value=_EXACT_PROC_10):
                    self.assertTrue(bash_module._enroll_journal(os.getpid()))
                start_id = bash_module._journal_enrollment_start_id(os.getpid())
                self.assertIsNotNone(start_id)
                with mock.patch.object(bash_module, "_IS_POSIX", False):
                    self.assertFalse(
                        bash_module._retire_journal(
                            os.getpid(),
                            start_id,
                            exact_death_proven=True,
                        )
                    )
                    self.assertTrue(
                        bash_module._retire_journal(
                            os.getpid(),
                            start_id,
                            exact_death_proven=True,
                            windows_tree_empty_proven=True,
                        )
                    )
            with open(journal) as journal_file:
                records = [json.loads(line) for line in journal_file if line.strip()]
            self.assertEqual(records[-1]["state"], "retired")

    async def test_unsupported_platform_fails_before_spawn(self):
        with mock.patch.object(bash_module.sys, "platform", "freebsd14"):
            with mock.patch.object(bash_module.os, "name", "posix"):
                with mock.patch.object(bash_module.subprocess, "Popen") as popen:
                    with self.assertRaisesRegex(RuntimeError, "unsupported platform freebsd14"):
                        bash("echo never")
        popen.assert_not_called()

    async def test_unconfigured_journal_still_requires_exact_supervisor_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "ran")
            with mock.patch.dict(
                os.environ, {"PRIME_AGENT_KERNEL_OWNER_PID": str(os.getpid())}
            ):
                with mock.patch.object(bash_module, "_process_start_id", return_value=None):
                    with self.assertRaisesRegex(RuntimeError, "exact-identity probe unavailable"):
                        bash(f"touch {marker}")
            self.assertFalse(os.path.exists(marker))


async def _poll_handle_reaped(handle, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while handle.running and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.02)
    if handle.running:
        raise AssertionError(f"bash supervisor {handle.pid} did not reap")


async def _poll_group_dead(pgid: int, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            pass  # transient teardown state on macOS
        await asyncio.sleep(0.05)
    raise AssertionError(f"process group {pgid} still alive after {timeout}s")


async def _poll_journal(path: str, count: int, timeout: float = 2.0) -> list[dict]:
    deadline = asyncio.get_running_loop().time() + timeout
    records: list[dict] = []
    while asyncio.get_running_loop().time() < deadline:
        with open(path) as f:
            records = [
                record
                for line in f
                if line.strip()
                for record in [json.loads(line)]
                if record.get("version") == 1 or record.get("type") == "process"
            ]
        for record in records:
            if record.get("version") == 2:
                record["active"] = record.get("state") == "enrolled"
        if len(records) >= count:
            return records
        await asyncio.sleep(0.05)
    return records


if __name__ == "__main__":
    unittest.main()
