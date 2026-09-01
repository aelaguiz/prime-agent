/**
 * Fleet load reproduction for the daemon. Spawns one isolated supervisor (own
 * socket, agent dir, registry dir, offline), creates N resident root sessions
 * one at a time, probes a worker-relayed command in a loop, samples fleet CPU,
 * then reads the daemon's own instrumentation and prints a report.
 *
 *   node_modules/.bin/tsx --tsconfig tsconfig.json scripts/bench-daemon-fleet.ts \
 *     --workers 15 --duration 20 [--probe-interval 250] [--keep]
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ENV_AGENT_DIR } from "../packages/coding-agent/src/config.js";
import { createProcessIdentityOwnerToken } from "../packages/coding-agent/src/core/session-lease.js";
import { DaemonClient } from "../packages/coding-agent/src/modes/daemon/daemon-client.js";

const repoRoot = resolve(new URL(".", import.meta.url).pathname, "..");
const cliPath = join(repoRoot, "packages/coding-agent/src/cli.ts");
const tsxPreflightPath = join(repoRoot, "node_modules/tsx/dist/preflight.cjs");
const tsxLoaderUrl = pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;
const REGISTRY_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

function arg(name: string, fallback: number): number {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : Number(process.argv[index + 1]) || fallback;
}
const workers = arg("--workers", 15);
const durationS = arg("--duration", 20);
const probeIntervalMs = arg("--probe-interval", 250);
const keep = process.argv.includes("--keep");

const root = mkdtempSync(join(tmpdir(), "prime-fleet-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
const sessionDir = join(agentDir, "sessions");
const registryDir = join(root, "supervisor-owners");
const socketPath = join(tmpdir(), `prime-fleet-${process.pid}.sock`);
mkdirSync(projectDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

const q = (values: number[], p: number): number => {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};
const stat = (values: number[]) =>
	`n=${values.length} p50=${q(values, 0.5)} p90=${q(values, 0.9)} p99=${q(values, 0.99)} max=${values.length ? Math.max(...values) : Number.NaN}`;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnSupervisor(): ChildProcess {
	const owner = createProcessIdentityOwnerToken();
	const out = createWriteStream(join(root, "supervisor.out"));
	const child = spawn(
		process.execPath,
		["--require", tsxPreflightPath, "--import", tsxLoaderUrl, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
		{
			argv0: owner.argument,
			cwd: projectDir,
			env: {
				...process.env,
				[REGISTRY_ENV]: registryDir,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: join(repoRoot, "tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child.stdout?.pipe(out);
	child.stderr?.pipe(out);
	return child;
}

async function connectEventually(child: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Supervisor exited early (code ${child.exitCode}); see ${root}/supervisor.out`);
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			return client;
		} catch {
			client.close();
			await delay(100);
		}
	}
	throw new Error("Supervisor never became ready");
}

interface Session { activeSessionId: string; workerPid: number; sessionFile: string }

function sampleCpu(pids: number[]): number {
	if (pids.length === 0) return 0;
	try {
		const out = execFileSync("/bin/ps", ["-o", "%cpu=", "-p", pids.join(",")], { encoding: "utf8" });
		return out.split("\n").map((l) => Number(l.trim())).filter(Number.isFinite).reduce((a, b) => a + b, 0);
	} catch {
		return Number.NaN;
	}
}

function readLogs(): string {
	const dir = join(agentDir, "logs");
	let text = "";
	try {
		for (const name of readdirSync(dir)) if (name.endsWith(".log")) text += readFileSync(join(dir, name), "utf8");
	} catch {}
	return text;
}

function readLifecycle(): Array<Record<string, unknown> & { role?: string }> {
	const dir = join(agentDir, "logs", "processes");
	const rows: Array<Record<string, unknown> & { role?: string }> = [];
	try {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".jsonl")) continue;
			let role: string | undefined;
			for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
				if (!line) continue;
				let row: Record<string, unknown>;
				try { row = JSON.parse(line); } catch { continue; }
				const context = row.context as Record<string, unknown> | undefined;
				if (context && typeof context.role === "string") role = context.role;
				rows.push({ ...row, role });
			}
		}
	} catch {}
	return rows;
}

function phaseTable(text: string, prefix: string): Array<[string, number, number, number]> {
	const pattern = new RegExp(`${prefix} trace=(\\S+) phase=(\\S+) elapsedMs=(\\d+) sincePreviousMs=(\\d+)`, "g");
	const byPhase = new Map<string, number[]>();
	for (const match of text.matchAll(pattern)) {
		const list = byPhase.get(match[2]!) ?? [];
		list.push(Number(match[4]));
		byPhase.set(match[2]!, list);
	}
	return [...byPhase.entries()]
		.map(([phase, values]) => [phase, q(values, 0.5), Math.max(...values), values.length] as [string, number, number, number])
		.sort((a, b) => b[1] - a[1]);
}

async function main(): Promise<void> {
	console.log(`fleet root: ${root}\nsocket: ${socketPath}\nworkers: ${workers} duration: ${durationS}s probe: ${probeIntervalMs}ms`);
	const supervisor = spawnSupervisor();
	const supervisorStartedAt = Date.now();
	const client = await connectEventually(supervisor);
	console.log(`supervisor ready in ${Date.now() - supervisorStartedAt} ms (pid ${client.hello?.supervisorPid})`);

	const sessions: Session[] = [];
	const createMs: number[] = [];
	const cpuSamples: number[] = [];
	const pids = () => [client.hello?.supervisorPid ?? 0, ...sessions.map((s) => s.workerPid)].filter((p) => p > 0);
	const cpuTimer = setInterval(() => { const v = sampleCpu(pids()); if (Number.isFinite(v)) cpuSamples.push(v); }, 2000);

	for (let i = 0; i < workers; i++) {
		const startedAt = Date.now();
		const response = await client.request(
			{ type: "create", config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true } },
			300_000,
		);
		const elapsed = Date.now() - startedAt;
		if (!response.success) { console.log(`create #${i + 1} FAILED after ${elapsed} ms: ${response.error}`); continue; }
		const summary = response.data as { activeSessionId?: string; id: string; workerPid?: number; sessionFile?: string };
		sessions.push({ activeSessionId: summary.activeSessionId ?? summary.id, workerPid: summary.workerPid ?? 0, sessionFile: summary.sessionFile ?? "" });
		createMs.push(elapsed);
		console.log(`create #${i + 1}: ${elapsed} ms (resident=${sessions.length})`);
	}

	const probeMs: number[] = [];
	let probeFailures = 0;
	const probeDeadline = Date.now() + durationS * 1000;
	let cursor = 0;
	while (Date.now() < probeDeadline && sessions.length > 0) {
		const session = sessions[cursor++ % sessions.length]!;
		const startedAt = Date.now();
		try {
			const response = await client.request({ type: "get_state", activeSessionId: session.activeSessionId }, 120_000);
			if (!response.success) probeFailures++;
		} catch { probeFailures++; }
		probeMs.push(Date.now() - startedAt);
		await delay(probeIntervalMs);
	}

	// One more cold create with the full fleet resident: the operator's "start another session" case.
	const lateStartedAt = Date.now();
	const late = await client.request({ type: "create", config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true } }, 300_000);
	const lateMs = Date.now() - lateStartedAt;
	if (late.success) { const s = late.data as { workerPid?: number; activeSessionId?: string; id: string }; sessions.push({ activeSessionId: s.activeSessionId ?? s.id, workerPid: s.workerPid ?? 0, sessionFile: "" }); }
	console.log(`create with ${workers} resident: ${lateMs} ms (${late.success ? "ok" : `FAILED: ${late.error}`})`);

	clearInterval(cpuTimer);
	try { await client.request({ type: "shutdown" }, 60_000); } catch {}
	client.close();
	const exitDeadline = Date.now() + 30_000;
	while (supervisor.exitCode === null && Date.now() < exitDeadline) await delay(100);
	for (const pid of pids()) { try { process.kill(pid, "SIGKILL"); } catch {} }

	const logs = readLogs();
	const lifecycle = readLifecycle();
	const guard = lifecycle.filter((r) => r.event === "daemon_registry_guard_timing");
	const guardData = guard.map((r) => (r.data ?? r.details ?? r) as Record<string, unknown>);
	const guardElapsed = guardData.map((d) => Number(d.elapsedMs)).filter(Number.isFinite);
	const guardAction = guardData.map((d) => Number(d.actionMs)).filter(Number.isFinite);
	const guardByRole: Record<string, number> = {};
	for (const r of guard) guardByRole[r.role ?? "?"] = (guardByRole[r.role ?? "?"] ?? 0) + 1;
	const fence = [...logs.matchAll(/supervisor_claim_check_completed elapsedMs=(\d+)/g)].map((m) => Number(m[1]));
	const admission = [...logs.matchAll(/Worker command admission .*supervisor_claim_check_completed elapsedMs=(\d+)/g)].map((m) => Number(m[1]));
	const identity = lifecycle.filter((r) => r.event === "process_identity_query_timing").length;
	const fenceFailed = (logs.match(/supervisor_claim_check_failed/g) ?? []).length;

	console.log("\n===== REPORT =====");
	console.log(`create latency (ms): ${createMs.join(", ")}`);
	console.log(`create ${stat(createMs)}  |  create with fleet resident: ${lateMs} ms`);
	console.log(`get_state relayed probe ${stat(probeMs)} failures=${probeFailures}`);
	console.log(`fleet cpu %: avg=${(cpuSamples.reduce((a, b) => a + b, 0) / Math.max(1, cpuSamples.length)).toFixed(0)} max=${cpuSamples.length ? Math.max(...cpuSamples).toFixed(0) : "n/a"} (${sessions.length} workers + supervisor)`);
	console.log(`registry guard slow acquisitions: ${stat(guardElapsed)} sum=${guardElapsed.reduce((a, b) => a + b, 0)}ms actionMs p50=${q(guardAction, 0.5)} byRole=${JSON.stringify(guardByRole)}`);
	console.log(`worker fence checks >=100ms: ${stat(fence)} failed=${fenceFailed}`);
	console.log(`worker command admissions >=100ms: ${stat(admission)}`);
	console.log(`process identity (ps) queries >=100ms: ${identity}`);
	console.log("\nworker startup phases (sincePreviousMs, median / max / n), slowest first:");
	for (const [phase, med, max, n] of phaseTable(logs, "Worker startup").filter(([phase]) => phase !== "process_closed").slice(0, 14)) console.log(`  ${phase.padEnd(34)} ${String(med).padStart(7)} ${String(max).padStart(7)} ${n}`);
	console.log("\nruntime create phases (worker side):");
	for (const [phase, med, max, n] of phaseTable(logs, "Runtime create").slice(0, 10)) console.log(`  ${phase.padEnd(34)} ${String(med).padStart(7)} ${String(max).padStart(7)} ${n}`);
	writeFileSync(join(root, "report.json"), JSON.stringify({ workers, createMs, lateMs, probeMs, probeFailures, cpuSamples, guardElapsed, fence, admission }, null, 2));
	console.log(`\nreport.json + logs: ${root}`);
	if (!keep) { try { rmSync(socketPath, { force: true }); } catch {} }
}

main().catch((error) => { console.error(error); process.exit(1); });
