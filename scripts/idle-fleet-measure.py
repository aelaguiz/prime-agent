#!/usr/bin/env python3
"""Isolated Prime fleet measurement: supervisor + N real workers resuming copies of real
transcripts, each with an attached TUI (pane 0 = agents view), idle for 60 s.

usage: python3 scripts/idle-fleet-measure.py <checkout-dir> <label>
env: N (workers, default 5), IDLE_FLEET_SESSIONS (comma-separated uuids), IDLE_FLEET_OUT (sample dir), PRIME_WIRE (path to aimgr prime-daemon-wire.mjs)
Requires the herdr CLI inside a Herdr session (creates a temporary workspace) and the aimgr wire script for teardown.
Prints RESULT lines; tears the fleet down via the daemon shutdown wire command; never
touches processes outside the isolated registry/descriptors/panes it created.
"""
import glob, json, os, re, subprocess, sys, tempfile, time, shutil

REPO, LABEL = sys.argv[1], sys.argv[2]
N = int(os.environ.get("N", "5"))
S = os.environ.get("IDLE_FLEET_OUT", tempfile.gettempdir())  # where sample files go
TMP = subprocess.run(["getconf", "DARWIN_USER_TEMP_DIR"], capture_output=True, text=True).stdout.strip()
ROOT = tempfile.mkdtemp(prefix=f"prime-idle-{LABEL}-", dir=TMP)
ROOT = os.path.realpath(ROOT)
SOCK = f"{ROOT}/daemon.sock"
HOME = os.path.expanduser("~")
# session uuids to copy from ~/.prime/agent/sessions (IDLE_FLEET_SESSIONS=a,b,c overrides)
TRANSCRIPTS = (os.environ.get("IDLE_FLEET_SESSIONS") or ",".join([
    "01a05ec9-1baf-7703-ac74-48387edfafe6", "01a05f55-2408-773c-8980-85faf2471008",
    "01a061fd-f476-758f-b258-2a7a82ba8106", "01a05ed0-21c2-7329-8f94-0c15e48bdf0b",
    "01a061ee-b7fa-7343-80de-80ca74b13f0c",
])).split(",")[:N]

for d in ("agent/sessions", "supervisor-owners", "project"):
    os.makedirs(f"{ROOT}/{d}", exist_ok=True)
if os.path.exists(f"{HOME}/.prime/agent/auth.json"):
    shutil.copy(f"{HOME}/.prime/agent/auth.json", f"{ROOT}/agent/auth.json")
for sid in TRANSCRIPTS:
    shutil.copy(f"{HOME}/.prime/agent/sessions/{sid}.jsonl", f"{ROOT}/agent/sessions/{sid}.jsonl")

ENV = (f"PRIME_AGENT_CODING_AGENT_DIR={ROOT}/agent "
       f"PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR={ROOT}/supervisor-owners "
       f"PI_OFFLINE=1 TSX_TSCONFIG_PATH={REPO}/tsconfig.json")
NODE = (f"node --require {REPO}/node_modules/tsx/dist/preflight.cjs --import file://{REPO}/node_modules/tsx/dist/loader.mjs "
        f"{REPO}/packages/coding-agent/src/cli.ts --daemon-socket {SOCK} --offline")
print(f"root={ROOT}\nsock={SOCK}\nrepo={REPO}", flush=True)

def herdr(*args):
    p = subprocess.run(["herdr", *args], capture_output=True, text=True, timeout=90)
    return p.stdout or p.stderr

def jherdr(*args):
    return json.loads(herdr(*args))["result"]

ws = jherdr("workspace", "create", "--cwd", f"{ROOT}/project", "--label", f"prime-idle-{LABEL}", "--no-focus")
panes = [ws["root_pane"]["pane_id"]]
for i in range(N):
    r = jherdr("pane", "split", panes[-1], "--direction", "down", "--cwd", f"{ROOT}/project", "--no-focus")
    panes.append(r["pane"]["pane_id"])
print("panes:", panes, flush=True)
time.sleep(1)
herdr("pane", "run", panes[0], f"env {ENV} {NODE} agents")
time.sleep(15)
for i, sid in enumerate(TRANSCRIPTS, start=1):
    herdr("pane", "run", panes[i], f"env {ENV} {NODE} --resume {ROOT}/agent/sessions/{sid}.jsonl")
    time.sleep(4)
print("waiting 45 s for workers to settle", flush=True)
time.sleep(45)

def fleet_pids():
    ps = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True).stdout
    children = {}
    for line in ps.splitlines():
        a = line.split()
        if len(a) == 2:
            children.setdefault(int(a[1]), []).append(int(a[0]))
    seed = set()
    for f in glob.glob(f"{ROOT}/supervisor-owners/*.owner/owner.json"):
        try: seed.add(json.load(open(f))["pid"])
        except Exception: pass
    for f in glob.glob(f"{ROOT}/agent/daemon-workers/*/*.json"):
        try: seed.add(json.load(open(f))["pid"])
        except Exception: pass
    for pane in panes:
        try:
            for pr in jherdr("pane", "process-info", "--pane", pane)["process_info"]["foreground_processes"]:
                if pr.get("name") != "zsh":
                    seed.add(pr["pid"])
        except Exception: pass
    out = set()
    def walk(p):
        if p in out: return
        out.add(p)
        for c in children.get(p, []): walk(c)
    for p in seed: walk(p)
    alive = []
    for p in sorted(out):
        try: os.kill(p, 0); alive.append(p)
        except Exception: pass
    return alive

def count(pattern, files):
    n = 0
    for f in files:
        try: n += open(f, errors="replace").read().count(pattern)
        except Exception: pass
    return n

def cpu_sum(pids):
    if not pids: return 0.0
    out = subprocess.run(["ps", "-o", "%cpu=", "-p", ",".join(map(str, pids))], capture_output=True, text=True).stdout
    return sum(float(x) for x in out.split())

descs = glob.glob(f"{ROOT}/agent/daemon-workers/*/*.json")
print(f"descriptors: {len(descs)}", flush=True)
pids = fleet_pids()
print(f"fleet pids ({len(pids)}): {pids}", flush=True)
sess = glob.glob(f"{ROOT}/agent/sessions/*.jsonl")
logs = lambda: glob.glob(f"{ROOT}/agent/logs/worker-*.log")
c0 = count('"type":"agent_status"', sess); h0 = count("type=heartbeats_list", logs()); t0 = time.time()
print(f"=== 60 s idle window starts {time.strftime('%H:%M:%S')} ===", flush=True)
samples = []
for _ in range(12):
    time.sleep(5)
    samples.append(round(cpu_sum(fleet_pids()), 1))
c1 = count('"type":"agent_status"', sess); h1 = count("type=heartbeats_list", logs()); t1 = time.time()
el = int(t1 - t0)
# direct probes over 20 s: live /bin/ps children of fleet pids, settings.json.lock occupancy, lifecycle heartbeat writes
fleet = set(fleet_pids()); ps_hits = 0; ps_samples = 0; lock_hits = 0; lock_samples = 0
hb0 = count('"event":"process_heartbeat"', glob.glob(f"{ROOT}/agent/logs/processes/*.jsonl"))
lock_path = f"{ROOT}/agent/settings.json.lock"
probe_end = time.time() + 20
while time.time() < probe_end:
    out = subprocess.run(["ps", "-axo", "ppid=,command="], capture_output=True, text=True).stdout
    ps_samples += 1
    for line in out.splitlines():
        a = line.split(None, 1)
        if len(a) == 2 and a[1].startswith("/bin/ps") and int(a[0]) in fleet:
            ps_hits += 1
    for _ in range(10):
        lock_samples += 1
        if os.path.exists(lock_path): lock_hits += 1
        time.sleep(0.005)
hb1 = count('"event":"process_heartbeat"', glob.glob(f"{ROOT}/agent/logs/processes/*.jsonl"))
print(f"RESULT {LABEL} /bin/ps children of the fleet seen in {ps_samples} ps snapshots over 20 s: {ps_hits}")
print(f"RESULT {LABEL} settings.json.lock present in {lock_hits} of {lock_samples} 5 ms probes")
print(f"RESULT {LABEL} process_heartbeat lifecycle records written during the window: {hb1-hb0}")
print(f"RESULT {LABEL} agent_status appends in {el} s: {c1-c0} (across {len(sess)} transcripts)")
print(f"RESULT {LABEL} heartbeats_list admissions in {el} s: {h1-h0} (across {len(logs())} worker logs)")
print(f"RESULT {LABEL} fleet cpu % (sum over {len(pids)} procs) samples: {samples} avg={sum(samples)/len(samples):.1f}")

sup = [json.load(open(f))["pid"] for f in glob.glob(f"{ROOT}/supervisor-owners/*.owner/owner.json")]
wrk = [json.load(open(f))["pid"] for f in glob.glob(f"{ROOT}/agent/daemon-workers/*/*.json")]
tui = []
try:
    tui = [pr["pid"] for pr in jherdr("pane", "process-info", "--pane", panes[0])["process_info"]["foreground_processes"] if pr.get("name") != "zsh"]
except Exception: pass
for who, plist in (("supervisor", sup), ("worker", wrk), ("agentsview-tui", tui)):
    if not plist: print(f"RESULT {LABEL} sample {who}: no pid"); continue
    p = plist[0]; out = f"{S}/sample-{LABEL}-{who}.txt"
    subprocess.run(["sample", str(p), "2", "-file", out], capture_output=True)
    txt = open(out, errors="replace").read() if os.path.exists(out) else ""
    tail = txt.split("Sort by top of stack", 1)[-1]
    def leaf(pat):
        m = re.search(pat + r"[^\n]*?(\d+)\s*$", tail, re.M)
        return int(m.group(1)) if m else 0
    total = 0
    m = re.search(r"Call graph:\s*\n\s*(\d+) Thread", txt)
    if m: total = int(m.group(1))
    print(f"RESULT {LABEL} sample {who} pid={p} main-thread-samples={total} lstat-leaf={leaf(r'^\s+lstat ')} cvwait-leaf={leaf(r'__psynch_cvwait')} spawn-leaf={leaf(r'__posix_spawn')}")

print("=== teardown ===", flush=True)
r = subprocess.run(["node", os.environ.get("PRIME_WIRE", f"{HOME}/workspace/aimgr/scripts/prime-daemon-wire.mjs"), "shutdown", "--force", "--socket", SOCK], capture_output=True, text=True, timeout=60)
print((r.stdout or r.stderr).strip().splitlines()[-1] if (r.stdout or r.stderr).strip() else "shutdown: no output")
time.sleep(6)
for p in panes:
    herdr("pane", "close", p)
time.sleep(2)
left = fleet_pids()
print(f"processes left: {len(left)}")
for p in left:
    try: os.kill(p, 9)
    except Exception: pass
print(f"done; root kept at {ROOT}")
