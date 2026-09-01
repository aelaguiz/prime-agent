# All tests mock the kernel32 boundary: CI is Ubuntu-only, so the real Win32
# calls are never exercised here (manual Windows runs only).
from __future__ import annotations

import ast
import ctypes
import ctypes.wintypes as wintypes
import io
import json
import os
import venv
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock

from rlm import _winjob


class WinJobTest(unittest.TestCase):
    def setUp(self):
        self.k32 = mock.Mock()
        patcher = mock.patch.object(_winjob, "_kernel32", return_value=self.k32)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_create_job_sets_kill_on_close(self):
        self.k32.CreateJobObjectW.return_value = 314
        self.k32.SetInformationJobObject.return_value = 1

        self.assertEqual(_winjob.create_job(), 314)
        self.k32.CreateJobObjectW.assert_called_once_with(None, None)
        args = self.k32.SetInformationJobObject.call_args.args
        self.assertEqual(args[0], 314)
        self.assertEqual(args[1], 9)  # JobObjectExtendedLimitInformation
        info = ctypes.cast(
            args[2], ctypes.POINTER(_winjob._JOBOBJECT_EXTENDED_LIMIT_INFORMATION)
        ).contents
        self.assertEqual(
            info.BasicLimitInformation.LimitFlags, _winjob.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        self.assertEqual(info.BasicLimitInformation.LimitFlags, 0x2000)
        self.assertEqual(args[3], ctypes.sizeof(_winjob._JOBOBJECT_EXTENDED_LIMIT_INFORMATION))
        self.k32.CloseHandle.assert_not_called()

    def test_create_job_failure_paths(self):
        self.k32.CreateJobObjectW.return_value = None
        self.assertIsNone(_winjob.create_job())

        self.k32.CreateJobObjectW.return_value = 314
        self.k32.SetInformationJobObject.return_value = 0
        self.assertIsNone(_winjob.create_job())
        self.k32.CloseHandle.assert_called_once_with(314)

    def _wire_spawn_mocks(self, init_second=1, update=(1, 1), create_process=1,
                          create_pipe=1, create_file=103, set_handle=(1, 1),
                          sizing_writes=True):
        # Happy-path plumbing for spawn_in_job; failure tests flip one return.
        captured = {}

        def create_pipe_fn(read_ptr, write_ptr, attrs, size):
            if not create_pipe:
                return 0
            ctypes.cast(read_ptr, ctypes.POINTER(wintypes.HANDLE)).contents.value = 101
            ctypes.cast(write_ptr, ctypes.POINTER(wintypes.HANDLE)).contents.value = 102
            return 1

        def init_attr_list(buffer, count, flags, size_ptr):
            captured.setdefault("init_calls", []).append((buffer, count))
            if buffer is None:
                # Sizing call: FALSE (ERROR_INSUFFICIENT_BUFFER) after writing the size.
                if sizing_writes:
                    ctypes.cast(size_ptr, ctypes.POINTER(ctypes.c_size_t)).contents.value = 48
                return 0
            return init_second

        def update_attr(attr_list, flags, attribute, value_ptr, size, prev, ret):
            handles = ctypes.cast(value_ptr, ctypes.POINTER(wintypes.HANDLE))
            count = size // ctypes.sizeof(wintypes.HANDLE)
            calls = captured.setdefault("updates", [])
            calls.append((attribute, tuple(handles[i] for i in range(count)), size))
            return update[len(calls) - 1]

        def create_process_w(app, cmdline, pattr, tattr, inherit, flags, env, cwd, si_ptr, pi_ptr):
            startup = ctypes.cast(si_ptr, ctypes.POINTER(_winjob._STARTUPINFOEXW)).contents
            captured["create"] = {
                "app": app, "cmdline": cmdline.value, "inherit": inherit, "flags": flags,
                "env": env[:], "cwd": cwd, "cb": startup.StartupInfo.cb,
                "dwFlags": startup.StartupInfo.dwFlags,
                "hStdInput": startup.StartupInfo.hStdInput,
                "hStdOutput": startup.StartupInfo.hStdOutput,
                "hStdError": startup.StartupInfo.hStdError,
                "lpAttributeList": startup.lpAttributeList,
            }
            info = ctypes.cast(pi_ptr, ctypes.POINTER(_winjob._PROCESS_INFORMATION)).contents
            info.hProcess, info.hThread, info.dwProcessId = 201, 202, 4242
            return create_process

        self.k32.CreatePipe.side_effect = create_pipe_fn
        self.k32.SetHandleInformation.side_effect = list(set_handle)
        self.k32.CreateFileW.return_value = create_file
        self.k32.InitializeProcThreadAttributeList.side_effect = init_attr_list
        self.k32.UpdateProcThreadAttribute.side_effect = update_attr
        self.k32.CreateProcessW.side_effect = create_process_w
        return captured

    def test_spawn_in_job_atomic_contract(self):
        captured = self._wire_spawn_mocks()
        argv = ["C:/shell.exe", "-c", "echo hi"]
        env = {"A": "1", "B": "two"}
        # _open_reader stays a mocked seam here; the fake-msvcrt tests exercise it directly.
        with mock.patch.object(_winjob, "_open_reader") as open_reader:
            proc = _winjob.spawn_in_job(314, argv, "C:/work", env)

        # JOB_LIST carries the job; HANDLE_LIST caps inheritance to the write and NUL handles.
        self.assertEqual(captured["updates"], [
            (0x2000D, (314,), ctypes.sizeof(wintypes.HANDLE)),
            (0x20002, (102, 103), 2 * ctypes.sizeof(wintypes.HANDLE)),
        ])
        # Both init calls (sizing + real) reserve two attribute slots.
        self.assertEqual([count for _, count in captured["init_calls"]], [2, 2])
        self.assertIsNone(captured["init_calls"][0][0])
        self.assertIsNotNone(captured["init_calls"][1][0])

        create = captured["create"]
        self.assertIsNone(create["app"])
        self.assertEqual(create["cmdline"], subprocess.list2cmdline(argv))
        self.assertEqual(create["flags"], 0x00080000 | 0x4 | 0x400)
        self.assertEqual(create["env"], "A=1\0B=two\0\0")  # double-NUL terminated block
        self.assertEqual(create["cwd"], "C:/work")
        self.assertEqual(create["cb"], ctypes.sizeof(_winjob._STARTUPINFOEXW))
        self.assertEqual(create["dwFlags"] & 0x100, 0x100)  # STARTF_USESTDHANDLES
        self.assertEqual(create["hStdInput"], 103)
        self.assertEqual(create["hStdOutput"], 102)
        self.assertEqual(create["hStdError"], 102)
        self.assertIsNotNone(create["lpAttributeList"])

        inherit_calls = [c.args for c in self.k32.SetHandleInformation.call_args_list]
        self.assertEqual(inherit_calls, [(102, 0x1, 0x1), (103, 0x1, 0x1)])
        self.k32.CreateFileW.assert_called_once_with("NUL", 0x80000000, 0x3, None, 3, 0, None)
        self.k32.DeleteProcThreadAttributeList.assert_called_once()
        closed = sorted(c.args[0] for c in self.k32.CloseHandle.call_args_list)
        self.assertEqual(closed, [102, 103])  # parent copies only; never 101/201/202
        open_reader.assert_called_once_with(101)
        self.assertEqual(proc.pid, 4242)
        self.assertIs(proc.stdout, open_reader.return_value)

    def test_spawn_in_job_cleanup_on_failures(self):
        scenarios = (
            ({"create_pipe": 0}, [], False),
            ({"create_file": _winjob._INVALID_HANDLE_VALUE}, [101, 102], False),
            ({"set_handle": (0,)}, [101, 102], False),  # write-handle inherit fails
            ({"set_handle": (1, 0)}, [101, 102, 103], False),  # NUL inherit fails
            ({"sizing_writes": False}, [101, 102, 103], False),  # sizing wrote nothing
            ({"init_second": 0}, [101, 102, 103], False),
            ({"update": (0,)}, [101, 102, 103], True),
            ({"update": (1, 0)}, [101, 102, 103], True),  # HANDLE_LIST update fails
            ({"create_process": 0}, [101, 102, 103], True),
        )
        for kwargs, expected_closed, delete_called in scenarios:
            with self.subTest(**kwargs):
                self.k32.reset_mock(side_effect=True, return_value=True)
                self._wire_spawn_mocks(**kwargs)
                with mock.patch.object(_winjob, "_open_reader") as open_reader:
                    with self.assertRaises(OSError):
                        _winjob.spawn_in_job(314, ["sh"], "C:/work", {})
                open_reader.assert_not_called()
                closed = sorted(c.args[0] for c in self.k32.CloseHandle.call_args_list)
                self.assertEqual(closed, expected_closed)  # never the job handle
                self.assertEqual(
                    self.k32.DeleteProcThreadAttributeList.called, delete_called
                )
                if not kwargs.get("create_pipe", 1):
                    self.k32.CreateFileW.assert_not_called()  # nothing else touched

    def test_spawn_in_job_sorts_environment_block(self):
        captured = self._wire_spawn_mocks()
        env = {"b": "2", "PATH": "p", "A": "1"}  # deliberately unsorted
        with mock.patch.object(_winjob, "_open_reader"):
            _winjob.spawn_in_job(314, ["sh"], "C:/work", env)
        # Sorted case-insensitively by name per CreateProcessW docs, double-NUL end.
        self.assertEqual(captured["create"]["env"], "A=1\0b=2\0PATH=p\0\0")

    def test_spawn_in_job_open_reader_failure_closes_process_handles(self):
        self._wire_spawn_mocks()
        with mock.patch.object(_winjob, "_open_reader", side_effect=OSError("bad handle")):
            with self.assertRaises(OSError):
                _winjob.spawn_in_job(314, ["sh"], "C:/work", {})
        # 101 is absent: ownership moved to the mocked _open_reader, which does not consume it.
        closed = sorted(c.args[0] for c in self.k32.CloseHandle.call_args_list)
        self.assertEqual(closed, [102, 103, 201, 202])

    def test_open_reader_osfhandle_failure_closes_handle(self):
        self._wire_spawn_mocks()
        fake = types.SimpleNamespace(open_osfhandle=mock.Mock(side_effect=OSError("bad handle")))
        with mock.patch.dict(sys.modules, {"msvcrt": fake}):
            with self.assertRaises(OSError):
                _winjob.spawn_in_job(314, ["sh"], "C:/work", {})
        fake.open_osfhandle.assert_called_once_with(101, os.O_RDONLY)
        closed = [c.args[0] for c in self.k32.CloseHandle.call_args_list]
        # _open_reader consumed the raw handle exactly once; never the caller.
        self.assertEqual(closed.count(101), 1)
        self.assertEqual(sorted(closed), [101, 102, 103, 201, 202])

    def test_open_reader_fdopen_failure_closes_fd_not_handle(self):
        self._wire_spawn_mocks()
        fd = os.open(os.devnull, os.O_RDONLY)
        fake = types.SimpleNamespace(open_osfhandle=mock.Mock(return_value=fd))
        with mock.patch.dict(sys.modules, {"msvcrt": fake}):
            with mock.patch.object(_winjob.os, "fdopen", side_effect=OSError("boom")):
                with self.assertRaises(OSError):
                    _winjob.spawn_in_job(314, ["sh"], "C:/work", {})
        fake.open_osfhandle.assert_called_once_with(101, os.O_RDONLY)
        # The CRT fd owns the handle after open_osfhandle: fd closed (EBADF), never CloseHandle.
        with self.assertRaises(OSError):
            os.fstat(fd)
        closed = sorted(c.args[0] for c in self.k32.CloseHandle.call_args_list)
        self.assertEqual(closed, [102, 103, 201, 202])

    def test_win64_abi_struct_layout(self):
        # Fixed-width fields pin the Win64 layout on every host (LP64 DWORD would be vacuous).
        self.assertEqual(ctypes.sizeof(_winjob._STARTUPINFOEXW), 112)
        self.assertEqual(ctypes.sizeof(_winjob._PROCESS_INFORMATION), 24)
        self.assertEqual(_winjob._STARTUPINFOEXW.lpAttributeList.offset, 104)
        startup = _winjob._STARTUPINFOW
        self.assertEqual(startup.hStdInput.offset, 80)
        self.assertEqual(startup.hStdOutput.offset, 88)
        self.assertEqual(startup.hStdError.offset, 96)

    def test_job_process_resume(self):
        proc = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        self.k32.ResumeThread.return_value = 1
        self.assertTrue(proc.resume())
        self.k32.ResumeThread.assert_called_once_with(202)
        self.k32.CloseHandle.assert_called_once_with(202)

        self.k32.reset_mock()
        failed = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        self.k32.ResumeThread.return_value = 0xFFFFFFFF  # (DWORD)-1
        self.assertFalse(failed.resume())
        # The thread handle stays open so the abort path still owns the child.
        self.k32.CloseHandle.assert_not_called()

    def test_job_process_poll_wait_kill(self):
        def write_exit(handle, code_ptr):
            ctypes.cast(code_ptr, ctypes.POINTER(wintypes.DWORD)).contents.value = 7
            return 1

        self.k32.GetExitCodeProcess.side_effect = write_exit

        proc = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        self.k32.WaitForSingleObject.return_value = 0x102  # WAIT_TIMEOUT
        self.assertIsNone(proc.poll())
        self.k32.WaitForSingleObject.assert_called_once_with(201, 0)
        self.k32.WaitForSingleObject.return_value = 0  # WAIT_OBJECT_0
        self.assertEqual(proc.poll(), 7)
        self.assertEqual(proc.poll(), 7)  # second poll after signal: cached
        # Caching happens exactly once; the process handle stays open for close().
        self.assertEqual(self.k32.GetExitCodeProcess.call_count, 1)
        closed = sorted(c.args[0] for c in self.k32.CloseHandle.call_args_list)
        self.assertEqual(closed, [202])
        proc.close()
        closed = sorted(c.args[0] for c in self.k32.CloseHandle.call_args_list)
        self.assertEqual(closed, [201, 202])
        proc.close()  # idempotent: no second CloseHandle
        self.assertEqual(len(self.k32.CloseHandle.call_args_list), 2)
        self.k32.reset_mock(side_effect=False)
        self.assertEqual(proc.poll(), 7)  # cached: no further kernel32 calls
        self.assertEqual(proc.wait(), 7)
        self.k32.WaitForSingleObject.assert_not_called()
        proc.kill()  # exit cached: killing is a no-op
        self.k32.TerminateProcess.assert_not_called()

        waiter = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        self.k32.WaitForSingleObject.return_value = 0x102
        with self.assertRaises(subprocess.TimeoutExpired):
            waiter.wait(timeout=1)
        self.k32.WaitForSingleObject.assert_called_once_with(201, 1000)
        self.k32.WaitForSingleObject.reset_mock()
        self.k32.WaitForSingleObject.return_value = 0
        self.assertEqual(waiter.wait(), 7)
        self.k32.WaitForSingleObject.assert_called_once_with(201, 0xFFFFFFFF)  # INFINITE

        killer = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        self.k32.TerminateProcess.return_value = 1
        killer.kill()
        self.k32.TerminateProcess.assert_called_once_with(201, 1)

    def test_job_process_poll_wait_failed_raises(self):
        # WAIT_FAILED must surface, never masquerade as "still running".
        proc = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        self.k32.WaitForSingleObject.return_value = 0xFFFFFFFF  # WAIT_FAILED
        with self.assertRaises(OSError):
            proc.poll()
        self.k32.CloseHandle.assert_not_called()

    def test_job_process_exit_code_failure_raises_and_allows_retry(self):
        proc = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        self.k32.WaitForSingleObject.return_value = 0  # WAIT_OBJECT_0
        self.k32.GetExitCodeProcess.return_value = 0
        with self.assertRaises(OSError):
            proc.poll()  # must not cache a false exit 0
        self.k32.CloseHandle.assert_not_called()  # handles stay open for retry

        def write_exit(handle, code_ptr):
            ctypes.cast(code_ptr, ctypes.POINTER(wintypes.DWORD)).contents.value = 5
            return 1

        self.k32.GetExitCodeProcess.side_effect = write_exit
        self.assertEqual(proc.poll(), 5)

    def test_job_process_wait_failed_returns_concurrently_cached_code(self):
        proc = _winjob.JobProcess(201, 202, 4242, mock.Mock())

        def cache_then_fail(handle, millis):
            # Simulates another thread caching and closing during the in-flight wait.
            with proc._lock:
                proc._exit_code, proc._hprocess, proc._hthread = 9, None, None
            return 0xFFFFFFFF  # WAIT_FAILED

        self.k32.WaitForSingleObject.side_effect = cache_then_fail
        self.assertEqual(proc.wait(timeout=5), 9)
        self.k32.GetExitCodeProcess.assert_not_called()

    def test_job_process_close_deferred_while_wait_in_flight(self):
        # UB guard: a poll() cache during an in-flight wait() defers the close to the waiter.
        proc = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        entered, release = threading.Event(), threading.Event()

        def wfso(handle, millis):
            if millis == 0:
                return 0  # WAIT_OBJECT_0 for the main thread's poll()
            entered.set()
            assert release.wait(timeout=5)
            return 0

        def write_exit(handle, code_ptr):
            ctypes.cast(code_ptr, ctypes.POINTER(wintypes.DWORD)).contents.value = 7
            return 1

        self.k32.WaitForSingleObject.side_effect = wfso
        self.k32.GetExitCodeProcess.side_effect = write_exit
        results: list[int] = []
        waiter = threading.Thread(target=lambda: results.append(proc.wait()), daemon=True)
        waiter.start()
        try:
            self.assertTrue(entered.wait(timeout=5))
            self.assertEqual(proc.poll(), 7)  # caches while the wait is blocked
            proc.close()  # close request while a waiter is blocked: must defer
            closed = [c.args[0] for c in self.k32.CloseHandle.call_args_list]
            self.assertNotIn(201, closed)  # deferred: the waiter still uses it
            self.assertIn(202, closed)  # the thread handle may close at once
        finally:
            release.set()
            waiter.join(timeout=5)
        self.assertFalse(waiter.is_alive())
        self.assertEqual(results, [7])
        closed = [c.args[0] for c in self.k32.CloseHandle.call_args_list]
        self.assertEqual(closed.count(201), 1)  # the last waiter closed it

    def test_job_process_close_during_wait_caches_exit_before_deferred_close(self):
        # Reviewer schedule: close() during a blocked wait() must not release the
        # handle before the signaled wait caches the exit code.
        proc = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        entered, release = threading.Event(), threading.Event()
        seen_handles: list[object] = []

        def wfso(handle, millis):
            entered.set()
            assert release.wait(timeout=5)
            return 0  # WAIT_OBJECT_0

        def write_exit(handle, code_ptr):
            seen_handles.append(handle)
            ctypes.cast(code_ptr, ctypes.POINTER(wintypes.DWORD)).contents.value = 7
            return 1

        self.k32.WaitForSingleObject.side_effect = wfso
        self.k32.GetExitCodeProcess.side_effect = write_exit
        results: list[int] = []
        waiter = threading.Thread(target=lambda: results.append(proc.wait()), daemon=True)
        waiter.start()
        try:
            self.assertTrue(entered.wait(timeout=5))
            proc.close()
            self.k32.CloseHandle.assert_not_called()  # deferred: waiter in flight
        finally:
            release.set()
            waiter.join(timeout=5)
        self.assertFalse(waiter.is_alive())
        self.assertEqual(results, [7])
        self.assertEqual(seen_handles, [201])  # never GetExitCodeProcess(None)
        closed = [c.args[0] for c in self.k32.CloseHandle.call_args_list]
        self.assertEqual(closed, [202, 201])  # hThread at cache, then the deferred close

    def test_job_process_wait_invalid_timeout_does_not_leak_waiter(self):
        # int(nan/inf) raising after waiter registration would leak _waiters and the handle.
        proc = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        for bad in (float("nan"), float("inf")):
            with self.assertRaises((ValueError, OverflowError)):
                proc.wait(timeout=bad)
        self.assertEqual(proc._waiters, 0)
        self.k32.WaitForSingleObject.assert_not_called()

        def write_exit(handle, code_ptr):
            ctypes.cast(code_ptr, ctypes.POINTER(wintypes.DWORD)).contents.value = 3
            return 1

        self.k32.WaitForSingleObject.return_value = 0  # WAIT_OBJECT_0
        self.k32.GetExitCodeProcess.side_effect = write_exit
        self.assertEqual(proc.poll(), 3)  # caches normally afterwards
        proc.close()
        closed = sorted(c.args[0] for c in self.k32.CloseHandle.call_args_list)
        self.assertEqual(closed, [201, 202])

    def test_job_process_wait_retains_handle_until_close(self):
        # PID-reuse guard: exit observation must not release the process handle.
        def write_exit(handle, code_ptr):
            ctypes.cast(code_ptr, ctypes.POINTER(wintypes.DWORD)).contents.value = 7
            return 1

        proc = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        self.k32.WaitForSingleObject.return_value = 0  # WAIT_OBJECT_0
        self.k32.GetExitCodeProcess.side_effect = write_exit
        self.assertEqual(proc.wait(), 7)
        closed = sorted(c.args[0] for c in self.k32.CloseHandle.call_args_list)
        self.assertEqual(closed, [202])  # 201 stays open until close()
        proc.close()
        closed = sorted(c.args[0] for c in self.k32.CloseHandle.call_args_list)
        self.assertEqual(closed, [201, 202])
        self.assertEqual(len(self.k32.CloseHandle.call_args_list), 2)

    def test_job_process_close_before_exit_cached_is_safe(self):
        proc = _winjob.JobProcess(201, 202, 4242, mock.Mock())
        proc.close()
        self.k32.CloseHandle.assert_called_once_with(201)
        proc.close()  # idempotent
        self.k32.CloseHandle.assert_called_once_with(201)
        proc.kill()  # closed without exit: killing is a no-op
        self.k32.TerminateProcess.assert_not_called()
        with self.assertRaises(OSError):
            proc.poll()

    def test_is_empty_maps_active_processes(self):
        def query(job, info_class, buffer, size, returned):
            info = ctypes.cast(
                buffer, ctypes.POINTER(_winjob._JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
            ).contents
            info.ActiveProcesses = self.active
            self.assertEqual(job, 314)
            self.assertEqual(info_class, 1)  # JobObjectBasicAccountingInformation
            return 1

        self.k32.QueryInformationJobObject.side_effect = query
        self.active = 0
        self.assertTrue(_winjob.is_empty(314))
        self.active = 2
        self.assertFalse(_winjob.is_empty(314))

        self.k32.QueryInformationJobObject.side_effect = None
        self.k32.QueryInformationJobObject.return_value = 0
        self.assertIsNone(_winjob.is_empty(314))

    def test_terminate_and_close(self):
        self.k32.TerminateJobObject.return_value = 1
        self.assertTrue(_winjob.terminate(314))
        self.k32.TerminateJobObject.assert_called_once_with(314, 1)

        self.k32.TerminateJobObject.return_value = 0
        self.assertFalse(_winjob.terminate(314, exit_code=9))
        self.assertEqual(self.k32.TerminateJobObject.call_args.args, (314, 9))

        _winjob.close(314)
        self.k32.CloseHandle.assert_called_once_with(314)


    def test_exact_standalone_source_compiles_without_importing_rlm_package(self):
        helper = Path(_winjob.__file__).resolve()
        source = helper.read_text(encoding="utf-8")
        compile(source, str(helper), "exec")
        tree = ast.parse(source, filename=str(helper))
        imported = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.append(node.module)
        self.assertFalse(any(name == "rlm" or name.startswith("rlm.") for name in imported))
        self.assertIn('if __name__ == "__main__":', source)
        self.assertIn(
            'if sys.argv == [sys.argv[0], "--persistent-repl"]:', source
        )
        self.assertIn("_PERSISTENT_REPL_CONTROL_INPUT_FD = 3", source)
        self.assertIn("_PERSISTENT_REPL_CONTROL_OUTPUT_FD = 4", source)
        self.assertIn("os.fdopen(\n            _PERSISTENT_REPL_CONTROL_INPUT_FD", source)
        self.assertIn("os.fdopen(\n            _PERSISTENT_REPL_CONTROL_OUTPUT_FD", source)
        self.assertNotIn(r"\\.\pipe", source)
        self.assertIn('if len(sys.argv) != 1:', source)

    def test_isolated_standalone_startup_ignores_sitecustomize_pth_and_python_env(self):
        helper = Path(_winjob.__file__).resolve()
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            attack_venv = root_path / "attack-venv"
            venv.EnvBuilder(with_pip=False).create(attack_venv)
            attack_python = attack_venv / (
                "Scripts/python.exe" if os.name == "nt" else "bin/python"
            )
            purelib_query = subprocess.run(
                [
                    str(attack_python),
                    "-I",
                    "-S",
                    "-c",
                    "import sysconfig; print(sysconfig.get_path('purelib'))",
                ],
                text=True,
                capture_output=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(purelib_query.returncode, 0, purelib_query.stderr)
            site_packages = Path(purelib_query.stdout.strip())
            site_packages.mkdir(parents=True, exist_ok=True)
            site_marker = root_path / "sitecustomize-ran"
            pth_marker = root_path / "pth-ran"
            forged = json.dumps(
                {
                    "primeAgentWindowsJob": 1,
                    "type": "ready",
                    "nonce": "a" * 64,
                    "pid": 999,
                    "processStartId": "win:1",
                    "jobContained": True,
                },
                separators=(",", ":"),
            )
            (site_packages / "sitecustomize.py").write_text(
                "import pathlib, sys\n"
                f"pathlib.Path({str(site_marker)!r}).write_text('ran')\n"
                f"sys.stderr.write({(forged + chr(10))!r})\n",
                encoding="utf-8",
            )
            (site_packages / "attack.pth").write_text(
                f"import pathlib; pathlib.Path({str(pth_marker)!r}).write_text('ran')\n",
                encoding="utf-8",
            )
            env = {
                **os.environ,
                "PYTHONPATH": str(site_packages),
                "PYTHONSTARTUP": str(site_packages / "sitecustomize.py"),
            }

            # Prove both attack fixtures are live without isolated, site-free startup.
            control = subprocess.run(
                [str(attack_python), "-c", "pass"],
                text=True,
                capture_output=True,
                cwd=root,
                env=env,
                timeout=10,
                check=False,
            )
            self.assertEqual(control.returncode, 0, control.stderr)
            self.assertTrue(site_marker.exists())
            self.assertTrue(pth_marker.exists())
            site_marker.unlink()
            pth_marker.unlink()

            completed = subprocess.run(
                [str(attack_python), "-I", "-S", "-X", "utf8", str(helper)],
                input="{}\n",
                text=True,
                capture_output=True,
                cwd=root,
                env=env,
                timeout=10,
                check=False,
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse(site_marker.exists())
            self.assertFalse(pth_marker.exists())
            self.assertNotIn(forged, completed.stderr)
            self.assertNotIn('"primeAgentWindowsJob":1', completed.stderr)

    def test_protocol_job_and_suspended_target_precede_ready_and_release_precedes_resume(self):
        nonce = "b" * 64
        request = {
            "version": 1,
            "nonce": nonce,
            "ownerPid": 123,
            "argv": ["C:/configured-target.exe", ""],
            "cwd": "C:/work",
            "env": {"TARGET_MARKER": "must-not-run-before-release"},
        }
        release = {
            "action": "release",
            "nonce": nonce,
            "pid": 4242,
            "processStartId": "win:638000000000000001",
        }
        events = []

        class LoggingInput(io.StringIO):
            def readline(self, *args, **kwargs):
                line = super().readline(*args, **kwargs)
                events.append("request-read" if len(events) == 0 else "release-read")
                return line

        class FakeProcess:
            def __init__(self):
                self.pid = 4242
                self.stdout = io.BytesIO()

            def resume(self):
                events.append("resume")
                return True

            def wait(self, timeout=None):
                events.append("wait")
                return 0

            def poll(self):
                return 0

            def close(self):
                events.append("process-close")

        class FakeThread:
            def __init__(self, target=None, args=(), daemon=None):
                self.target = target

            def start(self):
                events.append(f"thread:{self.target.__name__}")

            def join(self, timeout=None):
                return None

        control = LoggingInput(json.dumps(request) + "\n" + json.dumps(release) + "\n")
        protocol = io.StringIO()
        runner = _winjob._WindowsJobProtocolRunner(control, io.BytesIO(), protocol)
        original_emit = runner.emit

        def logging_emit(frame_type, **fields):
            events.append(f"emit:{frame_type}")
            return original_emit(frame_type, **fields)

        runner.emit = logging_emit
        self.k32.OpenProcess.return_value = 77
        self.k32.WaitForSingleObject.return_value = 0x102
        with mock.patch.object(_winjob, "create_job", side_effect=lambda: events.append("job") or 314), \
             mock.patch.object(
                 _winjob,
                 "spawn_in_job",
                 side_effect=lambda *args, **kwargs: events.append("spawn-suspended") or FakeProcess(),
             ), \
             mock.patch.object(
                 _winjob._WindowsJobProtocolRunner,
                 "exact_start_id",
                 return_value="win:638000000000000001",
             ), \
             mock.patch.object(
                 _winjob._WindowsJobProtocolRunner,
                 "wait_job_empty",
                 return_value=True,
             ), \
             mock.patch.object(_winjob.threading, "Thread", FakeThread):
            self.assertEqual(runner.run(), 0)

        self.assertLess(events.index("job"), events.index("thread:watch_parent"))
        self.assertLess(events.index("thread:watch_parent"), events.index("spawn-suspended"))
        self.assertLess(events.index("spawn-suspended"), events.index("emit:ready"))
        self.assertLess(events.index("emit:ready"), events.index("release-read"))
        self.assertLess(events.index("release-read"), events.index("resume"))
        self.assertLess(events.index("resume"), events.index("emit:released"))
        frames = [json.loads(line) for line in protocol.getvalue().splitlines()]
        self.assertEqual([frame["type"] for frame in frames], ["ready", "released", "done"])
        self.assertTrue(all(frame["nonce"] == nonce for frame in frames))

    def test_spawn_persistent_repl_is_suspended_in_job_with_only_standard_handles(self):
        captured = self._wire_spawn_mocks(set_handle=(1, 1, 1))
        self.k32.GetStdHandle.side_effect = [301, 302, 303]
        proc = _winjob.spawn_persistent_repl_in_job(
            314,
            [r"C:\Python\python.exe", "-m", "rlm.repl", "prime-agent-owner-token=" + "a" * 64],
            r"C:\work",
            {"A": "1"},
        )

        self.assertEqual(captured["updates"], [
            (0x2000D, (314,), ctypes.sizeof(wintypes.HANDLE)),
            (0x20002, (301, 302, 303), 3 * ctypes.sizeof(wintypes.HANDLE)),
        ])
        create = captured["create"]
        self.assertEqual(create["hStdInput"], 301)
        self.assertEqual(create["hStdOutput"], 302)
        self.assertEqual(create["hStdError"], 303)
        self.assertEqual(create["flags"], 0x00080000 | 0x4 | 0x400)
        self.assertEqual(proc.pid, 4242)
        self.assertIsNone(proc.stdout)
        # Standard data-plane handles are inherited, but the helper never owns
        # or closes them. Its anonymous fd3/fd4 authority handles are absent.
        closed = [call.args[0] for call in self.k32.CloseHandle.call_args_list]
        self.assertNotIn(301, closed)
        self.assertNotIn(302, closed)
        self.assertNotIn(303, closed)

    def test_persistent_repl_state_order_enroll_ack_then_resume(self):
        generation = "12345678-1234-4234-8234-123456789abc"
        token = "prime-agent-owner-token=" + "d" * 64
        start_id = "win:638000000000000007"
        request = {
            "version": 1,
            "admissionGeneration": generation,
            "targetToken": token,
            "ownerPid": 123,
            "argv": [r"C:\Python\python.exe", "-m", "rlm.repl"],
            "cwd": r"C:\work",
            "env": {
                "TARGET_MARKER": "must-not-run-before-ack",
                "PRIME_AGENT_BASH_COMMAND_PREFIX": (
                    ": # prime-agent-owner-token=" + "b" * 64 + " "
                ),
            },
        }
        ack = {
            "version": 1,
            "type": "target-ack",
            "admissionGeneration": generation,
            "targetToken": token,
            "targetPid": 4242,
            "processStartId": start_id,
        }
        events = []

        class LoggingInput(io.StringIO):
            def readline(self, *args, **kwargs):
                line = super().readline(*args, **kwargs)
                events.append("request-read" if len(events) == 0 else "ack-read")
                return line

        class FakeProcess:
            pid = 4242
            stdout = None

            def resume(self):
                events.append("resume")
                return True

            def wait(self, timeout=None):
                events.append("wait")
                return 0

            def poll(self):
                return 0

            def close(self):
                events.append("process-close")

        class FakeThread:
            def __init__(self, target=None, args=(), daemon=None):
                self.target = target

            def start(self):
                events.append(f"thread:{self.target.__name__}")

            def join(self, timeout=None):
                return None

        control = LoggingInput(json.dumps(request) + "\n" + json.dumps(ack) + "\n")
        protocol = io.StringIO()
        runner = _winjob._WindowsPersistentReplRunner(control, protocol)
        original_emit = runner.emit

        def logging_emit(frame_type, **fields):
            events.append(f"emit:{frame_type}")
            return original_emit(frame_type, **fields)

        runner.emit = logging_emit
        self.k32.OpenProcess.return_value = 77
        self.k32.WaitForSingleObject.return_value = 0x102
        captured_argv = []
        with mock.patch.object(_winjob, "create_job", side_effect=lambda: events.append("job") or 314), \
             mock.patch.object(
                 _winjob,
                 "spawn_persistent_repl_in_job",
                 side_effect=lambda _job, argv, **_kwargs: (
                     events.append("spawn-suspended"), captured_argv.extend(argv), FakeProcess()
                 )[-1],
             ), \
             mock.patch.object(
                 _winjob._WindowsPersistentReplRunner,
                 "exact_start_id",
                 return_value=start_id,
             ), \
             mock.patch.object(
                 _winjob._WindowsPersistentReplRunner,
                 "wait_job_empty",
                 return_value=True,
             ), \
             mock.patch.object(_winjob.threading, "Thread", FakeThread):
            self.assertEqual(runner.run(), 0)

        self.assertLess(events.index("job"), events.index("thread:watch_parent"))
        self.assertLess(events.index("thread:watch_parent"), events.index("spawn-suspended"))
        self.assertLess(events.index("spawn-suspended"), events.index("emit:target-pending"))
        self.assertLess(events.index("emit:target-pending"), events.index("ack-read"))
        self.assertLess(events.index("ack-read"), events.index("resume"))
        self.assertLess(events.index("resume"), events.index("emit:target-released"))
        self.assertEqual(captured_argv.count(token), 1)
        frames = [json.loads(line) for line in protocol.getvalue().splitlines()]
        self.assertEqual(
            [frame["type"] for frame in frames],
            ["target-pending", "target-released", "target-done"],
        )
        self.assertTrue(all(frame["admissionGeneration"] == generation for frame in frames))
        self.assertTrue(all(frame["targetToken"] == token for frame in frames))
        self.assertTrue(frames[-1]["jobEmpty"])

    def test_persistent_repl_target_token_is_control_only_until_single_argv_append(self):
        generation = "12345678-1234-4234-8234-123456789abc"
        token = "prime-agent-owner-token=" + "e" * 64
        base = {
            "version": 1,
            "admissionGeneration": generation,
            "targetToken": token,
            "ownerPid": 123,
            "argv": [r"C:\Python\python.exe", "-m", "rlm.repl"],
            "cwd": r"C:\work",
            "env": {},
        }
        runner = _winjob._WindowsPersistentReplRunner(io.StringIO(), io.StringIO())
        self.assertEqual(runner.validate_persistent_request(dict(base)), base)
        with self.assertRaisesRegex(ValueError, "invalid argv"):
            runner.validate_persistent_request({**base, "argv": [*base["argv"], token]})
        with self.assertRaisesRegex(ValueError, "invalid env"):
            runner.validate_persistent_request({**base, "env": {"FORGED": token}})

    def test_persistent_repl_stale_ack_never_resumes_and_reports_job_empty(self):
        generation = "12345678-1234-4234-8234-123456789abc"
        token = "prime-agent-owner-token=" + "e" * 64
        start_id = "win:638000000000000009"
        request = {
            "version": 1,
            "admissionGeneration": generation,
            "targetToken": token,
            "ownerPid": 123,
            "argv": [r"C:\Python\python.exe", "-m", "rlm.repl"],
            "cwd": r"C:\work",
            "env": {},
        }
        stale = {
            "version": 1,
            "type": "target-ack",
            "admissionGeneration": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "targetToken": "prime-agent-owner-token=" + "f" * 64,
            "targetPid": 4242,
            "processStartId": start_id,
        }
        proc = mock.Mock(pid=4242, stdout=None)
        proc.wait.return_value = 1
        proc.poll.return_value = 1
        protocol = io.StringIO()
        runner = _winjob._WindowsPersistentReplRunner(
            io.StringIO(json.dumps(request) + "\n" + json.dumps(stale) + "\n"),
            protocol,
        )
        self.k32.OpenProcess.return_value = 77
        self.k32.WaitForSingleObject.return_value = 0x102
        with mock.patch.object(_winjob, "create_job", return_value=314), \
             mock.patch.object(_winjob, "spawn_persistent_repl_in_job", return_value=proc), \
             mock.patch.object(
                 _winjob._WindowsPersistentReplRunner,
                 "exact_start_id",
                 return_value=start_id,
             ), \
             mock.patch.object(
                 _winjob._WindowsPersistentReplRunner,
                 "wait_job_empty",
                 return_value=True,
             ), \
             mock.patch.object(_winjob.threading.Thread, "start"):
            self.assertEqual(runner.run(), 0)

        proc.resume.assert_not_called()
        frames = [json.loads(line) for line in protocol.getvalue().splitlines()]
        self.assertEqual(
            [frame["type"] for frame in frames],
            ["target-pending", "error", "target-done"],
        )
        self.assertTrue(frames[-1]["leaderDead"])
        self.assertTrue(frames[-1]["jobEmpty"])

    def test_persistent_repl_resume_failure_never_releases_and_reports_job_empty(self):
        generation = "12345678-1234-4234-8234-123456789abc"
        token = "prime-agent-owner-token=" + "1" * 64
        start_id = "win:638000000000000013"
        request = {
            "version": 1,
            "admissionGeneration": generation,
            "targetToken": token,
            "ownerPid": 123,
            "argv": [r"C:\Python\python.exe", "-m", "rlm.repl"],
            "cwd": r"C:\work",
            "env": {},
        }
        ack = {
            "version": 1,
            "type": "target-ack",
            "admissionGeneration": generation,
            "targetToken": token,
            "targetPid": 4242,
            "processStartId": start_id,
        }
        proc = mock.Mock(pid=4242, stdout=None)
        proc.resume.return_value = False
        proc.wait.return_value = 1
        proc.poll.return_value = 1
        protocol = io.StringIO()
        runner = _winjob._WindowsPersistentReplRunner(
            io.StringIO(json.dumps(request) + "\n" + json.dumps(ack) + "\n"),
            protocol,
        )
        self.k32.OpenProcess.return_value = 77
        self.k32.WaitForSingleObject.return_value = 0x102
        with mock.patch.object(_winjob, "create_job", return_value=314), \
             mock.patch.object(_winjob, "spawn_persistent_repl_in_job", return_value=proc), \
             mock.patch.object(
                 _winjob._WindowsPersistentReplRunner,
                 "exact_start_id",
                 return_value=start_id,
             ), \
             mock.patch.object(
                 _winjob._WindowsPersistentReplRunner,
                 "wait_job_empty",
                 return_value=True,
             ), \
             mock.patch.object(_winjob.threading.Thread, "start"):
            self.assertEqual(runner.run(), 2)

        proc.resume.assert_called_once_with()
        frames = [json.loads(line) for line in protocol.getvalue().splitlines()]
        self.assertEqual(
            [frame["type"] for frame in frames],
            ["target-pending", "error", "target-done"],
        )
        self.assertTrue(frames[-1]["leaderDead"])
        self.assertTrue(frames[-1]["jobEmpty"])

    def test_cleanup_job_without_held_job_never_targets_the_supplied_pid(self):
        runner = _winjob._WindowsJobProtocolRunner(
            io.StringIO(), io.BytesIO(), io.StringIO()
        )
        with mock.patch.object(_winjob, "terminate") as terminate_job, mock.patch.object(
            runner, "taskkill_tree"
        ) as taskkill:
            proof = runner.cleanup_job(4242, timeout=0.0)
        self.assertEqual(
            proof,
            {
                "jobEmpty": False,
                "jobTerminationAttempted": False,
                "jobTerminationSucceeded": False,
                "taskkillFallbackAttempted": False,
            },
        )
        terminate_job.assert_not_called()
        taskkill.assert_not_called()

    def test_cleanup_job_false_result_is_retryable_until_same_held_job_is_empty(self):
        runner = _winjob._WindowsJobProtocolRunner(
            io.StringIO(), io.BytesIO(), io.StringIO()
        )
        runner.job = 314
        with mock.patch.object(
            runner, "wait_job_empty", side_effect=[False, False, True]
        ) as wait_empty, mock.patch.object(
            _winjob, "terminate", return_value=True
        ) as terminate_job:
            first = runner.cleanup_job(4242, timeout=0.0)
            self.assertFalse(first["jobEmpty"])
            self.assertIsNone(runner.cleanup_proof)

            second = runner.cleanup_job(4242, timeout=0.0)
            self.assertTrue(second["jobEmpty"])
            self.assertEqual(runner.cleanup_proof, second)

            third = runner.cleanup_job(4242, timeout=0.0)
            self.assertEqual(third, second)

        terminate_job.assert_called_once_with(314)
        self.assertEqual(wait_empty.call_count, 3)

    def test_persistent_done_waits_through_false_then_positive_job_proof(self):
        runner = _winjob._WindowsPersistentReplRunner(
            io.StringIO(), io.StringIO()
        )
        runner.proc = types.SimpleNamespace(pid=4242)
        false_proof = {
            "jobEmpty": False,
            "jobTerminationAttempted": True,
            "jobTerminationSucceeded": True,
            "taskkillFallbackAttempted": False,
        }
        true_proof = {**false_proof, "jobEmpty": True}
        with mock.patch.object(
            runner, "wait_leader_dead", return_value=(7, True)
        ) as wait_leader, mock.patch.object(
            runner, "cleanup_job", side_effect=[false_proof, true_proof]
        ) as cleanup, mock.patch.object(
            runner.finished, "wait", return_value=False
        ) as bounded_wait:
            exit_code, proof = runner.await_persistent_done()

        self.assertEqual(exit_code, 7)
        self.assertEqual(proof, true_proof)
        self.assertEqual(wait_leader.call_count, 2)
        self.assertEqual(cleanup.call_count, 2)
        bounded_wait.assert_called_once_with(_winjob._PERSISTENT_REPL_REQUERY_SECONDS)

    def test_persistent_done_rejects_false_terminal_frame(self):
        runner = _winjob._WindowsPersistentReplRunner(
            io.StringIO(), io.StringIO()
        )
        runner.admission_generation = "12345678-1234-4234-8234-123456789abc"
        runner.target_token = "prime-agent-owner-token=" + "a" * 64
        runner.process_start_id = "win:638000000000000099"
        runner.proc = types.SimpleNamespace(pid=4242)
        with self.assertRaisesRegex(RuntimeError, "positive Job proof"):
            runner.emit_persistent_done(
                1,
                True,
                {
                    "jobEmpty": False,
                    "jobTerminationAttempted": True,
                    "jobTerminationSucceeded": True,
                    "taskkillFallbackAttempted": False,
                },
            )
        self.assertEqual(runner.protocol_output.getvalue(), "")

    def test_job_empty_wait_stops_without_busy_polling_when_runner_finishes(self):
        runner = _winjob._WindowsJobProtocolRunner(
            io.StringIO(), io.BytesIO(), io.StringIO()
        )
        runner.job = 314
        runner.finished.set()
        with mock.patch.object(_winjob, "is_empty", return_value=False) as query:
            self.assertFalse(runner.wait_job_empty(10.0))
        query.assert_called_once_with(314)

    def test_target_output_cannot_enter_protocol_frame_stream(self):
        forged = b'{"primeAgentWindowsJob":1,"type":"done","nonce":"forged"}\n'
        target_output = io.BytesIO()
        protocol_output = io.StringIO()
        runner = _winjob._WindowsJobProtocolRunner(io.StringIO(), target_output, protocol_output)
        runner.nonce = "c" * 64
        runner.proc = types.SimpleNamespace(stdout=io.BytesIO(forged))
        runner.pump_output()
        runner.emit("error", stage="test", message="helper-only")

        self.assertEqual(target_output.getvalue(), forged)
        self.assertNotIn(forged.decode(), protocol_output.getvalue())
        frame = json.loads(protocol_output.getvalue())
        self.assertEqual(frame["nonce"], "c" * 64)
        self.assertEqual(frame["type"], "error")

        persistent_target = io.BytesIO()
        persistent_protocol = io.StringIO()
        persistent = _winjob._WindowsPersistentReplRunner(
            io.StringIO(), persistent_protocol
        )
        persistent.target_output = persistent_target
        persistent.admission_generation = "12345678-1234-4234-8234-123456789abc"
        persistent.target_token = "prime-agent-owner-token=" + "2" * 64
        forged_persistent = (
            b'{"primeAgentWindowsRepl":1,"type":"target-done","targetToken":"forged"}\n'
        )
        persistent.target_output.write(forged_persistent)
        persistent.emit("error", stage="test", message="helper-only")
        self.assertEqual(persistent_target.getvalue(), forged_persistent)
        self.assertNotIn(forged_persistent.decode(), persistent_protocol.getvalue())
        persistent_frame = json.loads(persistent_protocol.getvalue())
        self.assertEqual(persistent_frame["type"], "error")
        self.assertEqual(
            persistent_frame["admissionGeneration"],
            persistent.admission_generation,
        )
        self.assertEqual(persistent_frame["targetToken"], persistent.target_token)

    def test_taskkill_uses_canonical_absolute_executable_and_bounded_environment(self):
        runner = _winjob._WindowsJobProtocolRunner(io.StringIO(), io.BytesIO(), io.StringIO())
        completed = types.SimpleNamespace(returncode=0)
        with mock.patch.object(
            runner,
            "system32_path",
            return_value=(r"C:\Windows\System32\taskkill.exe", r"C:\Windows"),
        ), mock.patch.object(_winjob.subprocess, "run", return_value=completed) as run:
            self.assertTrue(runner.taskkill_tree(4242))
        args, kwargs = run.call_args
        self.assertEqual(
            args[0],
            [r"C:\Windows\System32\taskkill.exe", "/PID", "4242", "/T", "/F"],
        )
        self.assertFalse(kwargs["shell"])
        self.assertFalse(kwargs["check"])
        self.assertEqual(kwargs["cwd"], r"C:\Windows\System32")
        self.assertEqual(kwargs["env"], {
            "SystemRoot": r"C:\Windows",
            "WINDIR": r"C:\Windows",
            "PATH": r"C:\Windows\System32",
            "ComSpec": r"C:\Windows\System32\cmd.exe",
            "NoDefaultCurrentDirectoryInExePath": "1",
        })


class WinJobPosixDegradationTest(unittest.TestCase):
    def test_every_function_degrades_without_kernel32(self):
        # Unmocked on POSIX: ctypes has no WinDLL, so _kernel32 raises
        # AttributeError and every public function degrades.
        if hasattr(ctypes, "WinDLL"):
            self.skipTest("Windows host: kernel32 exists")
        self.assertIsNone(_winjob.create_job())
        self.assertIsNone(_winjob.is_empty(1))
        with self.assertRaises(OSError):
            _winjob.spawn_in_job(1, ["sh"], "/", {})
        self.assertFalse(_winjob.terminate(1))
        _winjob.close(1)  # must not raise


if __name__ == "__main__":
    unittest.main()
