from __future__ import annotations

import importlib
import json
import os
import secrets
import signal
import subprocess
import sys
import time
import uuid


def main() -> int:
    path, generation, count_text, ready_path = sys.argv[1:5]
    os.environ["PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL"] = path
    os.environ["PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL_GENERATION"] = generation
    os.environ["PRIME_AGENT_INTERNAL_KERNEL_ADMISSION_PROTOCOL"] = "2"
    os.environ["PRIME_AGENT_INTERNAL_KERNEL_ADMISSION_GENERATION"] = str(uuid.uuid4())
    os.environ["PRIME_AGENT_INTERNAL_KERNEL_LINEAGE"] = secrets.token_hex(32)
    os.environ["PRIME_AGENT_INTERNAL_KERNEL_PID"] = str(os.getpid())
    os.environ["PRIME_AGENT_KERNEL_OWNER_PID"] = str(os.getpid())
    bash_module = importlib.import_module("rlm.bash")
    kernel_start_id = bash_module._process_start_id(os.getpid())
    if not bash_module._is_exact_process_identity(kernel_start_id):
        return 3
    os.environ["PRIME_AGENT_INTERNAL_KERNEL_PROCESS_START_ID"] = kernel_start_id
    children: list[subprocess.Popen[bytes]] = []
    pids: list[int] = []
    try:
        for index in range(int(count_text)):
            child_identity = f"prime-agent-owner-token={secrets.token_hex(32)}"
            child = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(30)", child_identity],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            children.append(child)
            pids.append(child.pid)
            if not bash_module._record_journal_transition(child.pid, "enrolled"):
                return 2
            if index == 0 and ready_path != "-":
                with open(ready_path, "x") as ready:
                    ready.write("ready\n")
            time.sleep(0.01)
        print(json.dumps({"pids": pids}), flush=True)
        return 0
    finally:
        for child in children:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
