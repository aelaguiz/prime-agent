import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import chalk from "chalk";
import { APP_NAME, getAgentDir, VERSION } from "../config.js";
import { isOrphanProcessCandidateExactDead } from "../core/orphan-process-journal.js";
import {
	classifyProcessIdentityAuthority,
	getProcessStartId,
	isExactProcessStartId,
	matchesExactProcessIdentity,
} from "../core/session-lease.js";
import { DaemonClient } from "../modes/daemon/daemon-client.js";
import {
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	type DaemonRuntimeIdentity,
	parseDaemonSupervisorHelloIdentity,
} from "../modes/daemon/daemon-protocol.js";
import {
	acquireDaemonSocketPathLease,
	assertSocketLease,
	cleanupDaemonSocketPath,
	type DaemonSocketIdentity,
	defaultDaemonSocketDir,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	normalizeSocketPath,
} from "../modes/daemon/daemon-socket.js";
import {
	acquireDaemonOfflineMaintenanceLease,
	acquireDaemonShutdownAdmission,
} from "../modes/daemon/daemon-supervisor-ownership.js";
import {
	cleanupDaemonWorkerArtifacts,
	enumerateCanonicalDaemonWorkerDescriptors,
	readCanonicalDaemonWorkerDescriptor,
} from "../modes/daemon/daemon-worker-cleanup.js";
import { type DaemonWorkerDescriptor, daemonWorkerProcessAuthority } from "../modes/daemon/daemon-worker-protocol.js";
import { formatDaemonListTable } from "./daemon-ps-format.js";
import { promptYesNo } from "./daemon-stop-confirm.js";

/**
 * `daemon ps` discovers every prime-agent daemon on the machine, not just the
 * one on a single socket. Discovery has two sources merged by socket path:
 *
 *  1. The OS list of listening Unix sockets owned by a prime-agent process.
 *     Linux `ss -lxp` and any explicit lsof `TST=LISTEN` record may supply
 *     listener evidence. Apple lsof 4.91 exposes only pathname candidates;
 *     those paths are never PID authority and become actionable only after a
 *     fresh exact supervisor hello and stable socket-inode proof.
 *  2. A sweep of the default socket dir, which catches orphaned socket *files*
 *     left behind by daemons that are no longer running.
 *
 * Each discovered socket is then probed with the existing daemon_hello + list
 * primitives, so introspection works even against stale daemons running an
 * older build (a new protocol command would not).
 */

export type DaemonStatus = "current" | "stale" | "unreachable" | "orphan-file";

export interface DiscoveredDaemonProcess {
	pid: number;
	/** Physical identity used for comparison, leases, and unlink proof. */
	socketPath: string;
	/** Lexical AF_UNIX spelling used only for connect/request operations. */
	connectPath?: string;
	uptimeSeconds?: number;
}

export interface DaemonListenerObservation extends DiscoveredDaemonProcess {
	exactStartId: string;
	socketIdentity: DaemonSocketIdentity;
}

export interface DaemonInfo {
	socketPath: string;
	pid?: number;
	uptimeSeconds?: number;
	version?: string;
	protocolVersion?: number;
	schemaId?: string;
	buildId?: string;
	executablePath?: string;
	pidSource?: "listener" | "hello";
	sessionCount?: number;
	status: DaemonStatus;
	isDefault: boolean;
	hasTrackedWorkers?: boolean;
	/** A process held this pathname, but no LISTEN descriptor was proven. */
	hasUnverifiedEndpointCandidate?: boolean;
}

const STATUS_ORDER: Record<DaemonStatus, number> = {
	current: 0,
	stale: 1,
	unreachable: 2,
	"orphan-file": 3,
};
const SHUTDOWN_QUIET_PERIOD_MS = 1000;
const SHUTDOWN_CONVERGENCE_TIMEOUT_MS = 10_000;

export function evaluateShutdownQuietPeriod(now: number, quietSince: number | undefined): "complete" | "waiting" {
	if (quietSince !== undefined && now - quietSince >= SHUTDOWN_QUIET_PERIOD_MS) {
		return "complete";
	}
	return "waiting";
}

// Linux comm names (and thus the process name ss reports) are capped at 15 chars.
const MAX_COMM_LENGTH = 15;

function processNameMatches(name: string, appName: string): boolean {
	return name === appName || appName.slice(0, MAX_COMM_LENGTH) === name;
}

/** Parse `ss -lxp` output into the prime-agent daemons listening on unix sockets. */
export function parseSsListeners(stdout: string, appName: string): DiscoveredDaemonProcess[] {
	const daemons: DiscoveredDaemonProcess[] = [];
	for (const line of stdout.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[1] !== "LISTEN") {
			continue;
		}
		const socketPath = fields[4];
		if (!socketPath?.startsWith("/")) {
			continue;
		}
		const owner = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
		if (!owner || !processNameMatches(owner[1]!, appName)) {
			continue;
		}
		daemons.push({
			pid: Number.parseInt(owner[2]!, 10),
			socketPath: normalizeSocketPath(socketPath),
			connectPath: resolve(socketPath),
		});
	}
	return daemons;
}

/** Parse `lsof -nP -F pfnT -U ...` output into bound LISTEN unix sockets only. */
export function parseLsofListeners(stdout: string): DiscoveredDaemonProcess[] {
	const daemons: DiscoveredDaemonProcess[] = [];
	const seen = new Set<string>();
	let pid: number | undefined;
	let name: string | undefined;
	let listening = false;

	const flushFile = (): void => {
		if (pid === undefined || !name || !listening || !name.startsWith("/") || name.includes("->")) {
			name = undefined;
			listening = false;
			return;
		}
		const socketPath = normalizeSocketPath(name);
		const key = `${pid}:${socketPath}`;
		if (!seen.has(key)) {
			seen.add(key);
			daemons.push({ pid, socketPath, connectPath: resolve(name) });
		}
		name = undefined;
		listening = false;
	};

	for (const line of `${stdout}\nf`.split("\n")) {
		const field = line[0];
		const value = line.slice(1);
		if (field === "p") {
			flushFile();
			const parsed = Number.parseInt(value, 10);
			pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
		} else if (field === "f") {
			flushFile();
		} else if (field === "n") {
			name = value;
		} else if (field === "T" && value === "ST=LISTEN") {
			listening = true;
		}
	}
	return daemons;
}

export interface DaemonSocketOperationCandidate {
	/** Physical identity used only for deduplication and authority comparisons. */
	socketPath: string;
	/** Absolute lexical spelling reported by the process for AF_UNIX connect. */
	connectPath: string;
}

/**
 * Extract Unix endpoint path candidates without claiming that their descriptor
 * is the listening descriptor. Darwin lsof does not expose Unix LISTEN state;
 * these paths may only be probed for a fresh exact supervisor hello.
 */
export function parseLsofSocketOperationCandidates(stdout: string): DaemonSocketOperationCandidate[] {
	const byPhysicalPath = new Map<string, DaemonSocketOperationCandidate>();
	for (const line of stdout.split("\n")) {
		if (line[0] !== "n") continue;
		const name = line.slice(1);
		if (!name.startsWith("/") || name.includes("->")) continue;
		try {
			const connectPath = resolve(name);
			const socketPath = normalizeSocketPath(connectPath);
			byPhysicalPath.set(socketPath, { socketPath, connectPath });
		} catch {
			// Broken aliases are unresolved endpoint evidence, not candidates.
		}
	}
	return [...byPhysicalPath.values()];
}

export function parsePrimeAgentProcessIds(stdout: string, appName: string): number[] {
	const pids: number[] = [];
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\S+)(?:\s+(.*))?$/);
		if (!match) {
			continue;
		}
		const command = basename(match[2]!);
		const argv0 = basename(match[3]?.trim().split(/\s+/, 1)[0] ?? "");
		if (processNameMatches(command, appName) || processNameMatches(argv0, appName)) {
			pids.push(Number.parseInt(match[1]!, 10));
		}
	}
	return pids;
}

export function mergeDiscoveredDaemonProcesses(
	...groups: readonly DiscoveredDaemonProcess[][]
): DiscoveredDaemonProcess[] {
	const byIdentity = new Map<string, DiscoveredDaemonProcess>();
	for (const group of groups) {
		for (const daemon of group) {
			const physicalSocketPath = normalizeSocketPath(daemon.socketPath);
			const key = `${daemon.pid}:${physicalSocketPath}`;
			const previous = byIdentity.get(key);
			byIdentity.set(key, {
				...previous,
				...daemon,
				socketPath: physicalSocketPath,
				connectPath: daemon.connectPath ?? previous?.connectPath,
			});
		}
	}
	return [...byIdentity.values()];
}

/** Parse `ps -o pid=,etimes=` output into a pid → uptime-seconds map. */
export function parsePsEtimes(stdout: string): Map<number, number> {
	const uptimes = new Map<number, number>();
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)$/);
		if (match) {
			uptimes.set(Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10));
		}
	}
	return uptimes;
}

function scanListeningDaemonCandidates(): DiscoveredDaemonProcess[] {
	if (process.platform === "win32") return [];
	const ss = spawnSync("ss", ["-lxp"], { encoding: "utf8" });
	if (!ss.error && ss.status === 0 && typeof ss.stdout === "string") {
		return parseSsListeners(ss.stdout, APP_NAME);
	}
	const lsof = spawnSync("lsof", ["-nP", "-F", "pfnT", "-U", "-a", "-c", APP_NAME], {
		encoding: "utf8",
	});
	const byName = !lsof.error && typeof lsof.stdout === "string" ? parseLsofListeners(lsof.stdout) : [];
	let byPid: DiscoveredDaemonProcess[] = [];
	const ps = spawnSync("ps", ["-axo", "pid=,comm=,args="], { encoding: "utf8" });
	if (!ps.error && ps.status === 0 && typeof ps.stdout === "string") {
		const pids = parsePrimeAgentProcessIds(ps.stdout, APP_NAME);
		if (pids.length > 0) {
			const lsofByPid = spawnSync("lsof", ["-nP", "-F", "pfnT", "-U", "-a", "-p", pids.join(",")], {
				encoding: "utf8",
			});
			if (!lsofByPid.error && typeof lsofByPid.stdout === "string") {
				byPid = parseLsofListeners(lsofByPid.stdout);
			}
		}
	}
	return mergeDiscoveredDaemonProcesses(byName, byPid);
}

function scanDaemonSocketOperationCandidates(): DaemonSocketOperationCandidate[] {
	if (process.platform !== "darwin") return [];
	const outputs: string[] = [];
	const byName = spawnSync("lsof", ["-nP", "-F", "pn", "-U", "-a", "-c", APP_NAME], {
		encoding: "utf8",
	});
	if (!byName.error && typeof byName.stdout === "string") outputs.push(byName.stdout);
	const ps = spawnSync("ps", ["-axo", "pid=,comm=,args="], { encoding: "utf8" });
	if (!ps.error && ps.status === 0 && typeof ps.stdout === "string") {
		const pids = parsePrimeAgentProcessIds(ps.stdout, APP_NAME);
		if (pids.length > 0) {
			const byPid = spawnSync("lsof", ["-nP", "-F", "pn", "-U", "-a", "-p", pids.join(",")], {
				encoding: "utf8",
			});
			if (!byPid.error && typeof byPid.stdout === "string") outputs.push(byPid.stdout);
		}
	}
	const byPhysicalPath = new Map<string, DaemonSocketOperationCandidate>();
	for (const output of outputs) {
		for (const candidate of parseLsofSocketOperationCandidates(output)) {
			byPhysicalPath.set(candidate.socketPath, candidate);
		}
	}
	return [...byPhysicalPath.values()];
}

function captureDaemonListenerObservation(candidate: DiscoveredDaemonProcess): DaemonListenerObservation | undefined {
	const socketPath = normalizeSocketPath(candidate.socketPath);
	const firstStartId = getProcessStartId(candidate.pid);
	if (!firstStartId || !isExactProcessStartId(firstStartId)) return undefined;
	let firstSocketIdentity: DaemonSocketIdentity | undefined;
	try {
		firstSocketIdentity = getDaemonSocketIdentity(socketPath);
	} catch {
		return undefined;
	}
	if (!firstSocketIdentity) return undefined;
	const secondStartId = getProcessStartId(candidate.pid);
	let secondSocketIdentity: DaemonSocketIdentity | undefined;
	try {
		secondSocketIdentity = getDaemonSocketIdentity(socketPath);
	} catch {
		return undefined;
	}
	if (
		secondStartId !== firstStartId ||
		!secondSocketIdentity ||
		!sameDaemonSocketIdentity(firstSocketIdentity, secondSocketIdentity)
	) {
		return undefined;
	}
	return {
		pid: candidate.pid,
		socketPath,
		...(candidate.connectPath ? { connectPath: candidate.connectPath } : {}),
		...(candidate.uptimeSeconds !== undefined ? { uptimeSeconds: candidate.uptimeSeconds } : {}),
		exactStartId: firstStartId,
		socketIdentity: firstSocketIdentity,
	};
}

interface DaemonListenerScan {
	verified: DaemonListenerObservation[];
	retained: DiscoveredDaemonProcess[];
}

function scanDaemonListenerObservations(): DaemonListenerScan {
	const verified: DaemonListenerObservation[] = [];
	const retained: DiscoveredDaemonProcess[] = [];
	for (const candidate of enrichUptimes(scanListeningDaemonCandidates())) {
		const observation = captureDaemonListenerObservation(candidate);
		if (observation) verified.push(observation);
		else retained.push(candidate);
	}
	return { verified, retained };
}

function scanListeningDaemons(): DaemonListenerObservation[] {
	return scanDaemonListenerObservations().verified;
}

async function captureReachableDaemonListenerObservation(
	connectPath: string,
	expectedPid?: number,
): Promise<DaemonListenerObservation | undefined> {
	const socketPath = normalizeSocketPath(connectPath);
	let firstSocketIdentity: DaemonSocketIdentity | undefined;
	try {
		firstSocketIdentity = getDaemonSocketIdentity(socketPath);
	} catch {
		return undefined;
	}
	if (!firstSocketIdentity) return undefined;

	const client = new DaemonClient(connectPath);
	try {
		await client.connect(1000);
		const hello = await client.waitForHello(1000);
		const identity = parseDaemonSupervisorHelloIdentity(hello);
		const supervisorPid = hello.supervisorPid;
		if (
			identity.status !== "exact" ||
			typeof supervisorPid !== "number" ||
			!Number.isInteger(supervisorPid) ||
			supervisorPid <= 0 ||
			(expectedPid !== undefined && supervisorPid !== expectedPid) ||
			typeof hello.supervisorSocketPath !== "string" ||
			normalizeSocketPath(hello.supervisorSocketPath) !== socketPath ||
			!matchesExactProcessIdentity(supervisorPid, identity.authorityProcessStartId)
		) {
			return undefined;
		}
		let secondSocketIdentity: DaemonSocketIdentity | undefined;
		try {
			secondSocketIdentity = getDaemonSocketIdentity(socketPath);
		} catch {
			return undefined;
		}
		if (
			!secondSocketIdentity ||
			!sameDaemonSocketIdentity(firstSocketIdentity, secondSocketIdentity) ||
			!matchesExactProcessIdentity(supervisorPid, identity.authorityProcessStartId)
		) {
			return undefined;
		}
		return {
			pid: supervisorPid,
			socketPath,
			connectPath,
			exactStartId: identity.authorityProcessStartId,
			socketIdentity: secondSocketIdentity,
		};
	} catch {
		return undefined;
	} finally {
		client.close();
	}
}

function hasAnyDaemonListenerAtSocket(socketPath: string): boolean {
	const physicalSocketPath = normalizeSocketPath(socketPath);
	return scanListeningDaemonCandidates().some(
		(candidate) => normalizeSocketPath(candidate.socketPath) === physicalSocketPath,
	);
}

export function sameDaemonListenerObservation(
	left: DaemonListenerObservation,
	right: DaemonListenerObservation,
): boolean {
	return (
		left.pid === right.pid &&
		left.exactStartId === right.exactStartId &&
		left.socketPath === right.socketPath &&
		sameDaemonSocketIdentity(left.socketIdentity, right.socketIdentity)
	);
}

export function findMatchingDaemonListenerObservation(
	expected: DaemonListenerObservation,
	candidates: readonly DaemonListenerObservation[],
): DaemonListenerObservation | undefined {
	return candidates.find((candidate) => sameDaemonListenerObservation(candidate, expected));
}

function enrichUptimes<T extends DiscoveredDaemonProcess>(daemons: T[]): T[] {
	const pids = daemons.map((daemon) => daemon.pid);
	if (pids.length === 0) return daemons;
	const ps = spawnSync("ps", ["-o", "pid=,etimes=", "-p", pids.join(",")], { encoding: "utf8" });
	if (ps.error || typeof ps.stdout !== "string") return daemons;
	const uptimes = parsePsEtimes(ps.stdout);
	return daemons.map((daemon) => ({ ...daemon, uptimeSeconds: uptimes.get(daemon.pid) }));
}

function sameDaemonSocketIdentity(left: DaemonSocketIdentity, right: DaemonSocketIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/** Socket files in the default socket dir (may be live daemons or orphaned files). */
function scanSocketDir(): string[] {
	if (process.platform === "win32") {
		return [];
	}
	const dir = defaultDaemonSocketDir();
	if (!existsSync(dir)) {
		return [];
	}
	const sockets: string[] = [];
	for (const entry of readdirSync(dir)) {
		const socketPath = join(dir, entry);
		try {
			if (lstatSync(socketPath).isSocket()) {
				sockets.push(normalizeSocketPath(socketPath));
			}
		} catch {
			// Entry vanished between readdir and lstat; ignore.
		}
	}
	return sockets;
}

interface ProbeResult {
	version?: string;
	protocolVersion?: number;
	schemaId?: string;
	runtime?: DaemonRuntimeIdentity;
	sessionCount?: number;
	supervisorPid?: number;
	supervisorProcessStartId?: string;
	supervisorAuthorityProcessStartId?: string;
	supervisorIdentityInvalid?: true;
	reachable: boolean;
}

function operationalDaemonSocketPath(physicalSocketPath: string): string {
	if (process.platform === "darwin") {
		if (physicalSocketPath.startsWith("/private/var/")) return physicalSocketPath.slice("/private".length);
		if (physicalSocketPath.startsWith("/private/tmp/")) return physicalSocketPath.slice("/private".length);
	}
	return physicalSocketPath;
}

export function daemonHelloExactProcessAuthority(value: {
	supervisorProcessStartId?: unknown;
	supervisorAuthorityProcessStartId?: unknown;
}): string | undefined {
	const identity = parseDaemonSupervisorHelloIdentity(value);
	return identity.status === "exact" ? identity.authorityProcessStartId : undefined;
}

async function daemonSocketAcceptsConnection(socketPath: string): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(300);
		return true;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

async function probeDaemon(socketPath: string): Promise<ProbeResult> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(300);
	} catch {
		client.close();
		return { reachable: false };
	}
	try {
		let version: string | undefined;
		let protocolVersion: number | undefined;
		let schemaId: string | undefined;
		let runtime: DaemonRuntimeIdentity | undefined;
		let supervisorPid: number | undefined;
		let supervisorProcessStartId: string | undefined;
		let supervisorAuthorityProcessStartId: string | undefined;
		let supervisorIdentityInvalid: true | undefined;
		let greeted = false;
		try {
			const hello = await client.waitForHello(1500);
			version = hello.appVersion;
			protocolVersion = hello.protocol.version;
			schemaId = hello.schemaId;
			runtime = hello.runtime;
			const supervisorIdentity = parseDaemonSupervisorHelloIdentity(hello);
			supervisorPid = hello.supervisorPid;
			if (supervisorIdentity.status === "exact") {
				supervisorAuthorityProcessStartId = daemonHelloExactProcessAuthority(hello);
				supervisorProcessStartId = supervisorIdentity.legacyProcessStartId;
			} else if (supervisorIdentity.status === "legacy-only") {
				supervisorProcessStartId = supervisorIdentity.legacyProcessStartId;
			} else {
				supervisorIdentityInvalid = true;
			}
			greeted = true;
		} catch {
			// Connected but no recognizable greeting: an old/foreign daemon.
		}
		let sessionCount: number | undefined;
		try {
			const response = await client.request({ type: "list" }, greeted ? 30000 : 1500);
			if (response.success) {
				const sessions = (response.data as { sessions?: unknown })?.sessions;
				if (Array.isArray(sessions)) {
					sessionCount = sessions.length;
				}
			}
		} catch {
			// Leave sessionCount undefined when the daemon will not answer list.
		}
		return {
			version,
			protocolVersion,
			schemaId,
			runtime,
			sessionCount,
			supervisorPid,
			supervisorProcessStartId,
			supervisorAuthorityProcessStartId,
			supervisorIdentityInvalid,
			reachable: true,
		};
	} finally {
		client.close();
	}
}

function classifyReachable(probe: ProbeResult): DaemonStatus {
	if (
		probe.supervisorIdentityInvalid !== true &&
		probe.protocolVersion === DAEMON_PROTOCOL_VERSION &&
		probe.schemaId === DAEMON_SCHEMA_ID &&
		probe.version === VERSION
	) {
		return "current";
	}
	return "stale";
}

export function verifyHelloSupervisorPid(
	pid: number | undefined,
	expectedProcessStartId: string | undefined,
): number | undefined {
	if (!Number.isInteger(pid) || pid === undefined || pid <= 0) {
		return undefined;
	}
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") {
			return undefined;
		}
	}
	if (
		!expectedProcessStartId ||
		!isExactProcessStartId(expectedProcessStartId) ||
		getProcessStartId(pid) !== expectedProcessStartId
	) {
		return undefined;
	}
	return pid;
}

/** Discover every daemon on the machine and probe each for version + session count. */
type DaemonWorkerInventory = ReturnType<typeof enumerateCanonicalDaemonWorkerDescriptors>;

export function trackedWorkerSocketPaths(workerInventory: DaemonWorkerInventory): Set<string> {
	return new Set<string>([
		...workerInventory.descriptors.map((entry) => normalizeSocketPath(entry.descriptor.socketPath)),
		...workerInventory.retained.flatMap((entry) => (entry.socketPath ? [normalizeSocketPath(entry.socketPath)] : [])),
	]);
}

export async function discoverDaemons(
	workerInventory: DaemonWorkerInventory = enumerateCanonicalDaemonWorkerDescriptors(getAgentDir()),
): Promise<DaemonInfo[]> {
	const trackedWorkerSockets = trackedWorkerSocketPaths(workerInventory);
	const processBySocket = new Map<string, DiscoveredDaemonProcess>();
	const listenerScan = scanDaemonListenerObservations();
	for (const daemon of [...listenerScan.verified, ...listenerScan.retained]) {
		if (trackedWorkerSockets.has(daemon.socketPath)) continue;
		processBySocket.set(daemon.socketPath, daemon);
	}
	const operationCandidateBySocket = new Map(
		scanDaemonSocketOperationCandidates()
			.filter((candidate) => !trackedWorkerSockets.has(candidate.socketPath))
			.map((candidate) => [candidate.socketPath, candidate] as const),
	);

	const supervisorSockets = new Set(
		workerInventory.descriptors
			.filter((entry) => getTrackedWorkerLiveness(entry.descriptor) !== "exact-dead")
			.map((entry) => normalizeSocketPath(entry.descriptor.supervisorSocketPath)),
	);
	const sockets = new Set<string>([
		...processBySocket.keys(),
		...operationCandidateBySocket.keys(),
		...scanSocketDir().filter((socketPath) => !trackedWorkerSockets.has(socketPath)),
		...supervisorSockets,
	]);
	for (const socketPath of [...sockets]) {
		if (isKernelInfrastructureSocketPath(socketPath)) sockets.delete(socketPath);
	}
	const defaultSocket = normalizeSocketPath(defaultDaemonSocketPath());

	const infos = await Promise.all(
		[...sockets].map(async (socketPath): Promise<DaemonInfo> => {
			const proc = processBySocket.get(socketPath);
			const operationCandidate = operationCandidateBySocket.get(socketPath);
			const probe = await probeDaemon(
				proc?.connectPath ?? operationCandidate?.connectPath ?? operationalDaemonSocketPath(socketPath),
			);
			const pid =
				proc?.pid ?? verifyHelloSupervisorPid(probe.supervisorPid, probe.supervisorAuthorityProcessStartId);
			const hasTrackedWorkers = supervisorSockets.has(socketPath);
			const status: DaemonStatus = probe.reachable
				? classifyReachable(probe)
				: proc || operationCandidate || hasTrackedWorkers
					? "unreachable"
					: "orphan-file";
			return {
				socketPath,
				pid,
				uptimeSeconds: proc?.uptimeSeconds,
				version: probe.version,
				protocolVersion: probe.protocolVersion,
				schemaId: probe.schemaId,
				buildId: probe.runtime?.buildId,
				executablePath:
					probe.runtime?.launcherPath ?? probe.runtime?.entrypointPath ?? probe.runtime?.executablePath,
				...(pid !== undefined ? { pidSource: proc ? ("listener" as const) : ("hello" as const) } : {}),
				sessionCount: probe.sessionCount,
				status,
				isDefault: socketPath === defaultSocket,
				...(hasTrackedWorkers ? { hasTrackedWorkers: true } : {}),
				...(operationCandidate && !proc ? { hasUnverifiedEndpointCandidate: true } : {}),
			};
		}),
	);
	return sortDaemons(infos);
}

// Python kernel fork servers and kernels listen on `control.sock` inside
// `prime-agent-forkserver-*` / `prime-agent-kernel-*` temp dirs. They are not
// daemons and vanish within seconds, so never probe or query them.
function isKernelInfrastructureSocketPath(socketPath: string): boolean {
	return /\/prime-agent-(?:forkserver|kernel)-[^/]+\//.test(socketPath);
}

export function sortDaemons(infos: DaemonInfo[]): DaemonInfo[] {
	return [...infos].sort((left, right) => {
		if (left.isDefault !== right.isDefault) {
			return left.isDefault ? -1 : 1;
		}
		const statusDelta = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
		return statusDelta || left.socketPath.localeCompare(right.socketPath);
	});
}

export async function runPs(json: boolean): Promise<void> {
	const daemons = await discoverDaemons();
	if (json) {
		console.log(JSON.stringify(daemons, null, 2));
		return;
	}
	if (daemons.length === 0) {
		console.log("No background services found.");
		return;
	}
	console.log(formatDaemonListTable(daemons));
}

export type ReapAction =
	| { kind: "remove-file"; daemon: DaemonInfo }
	| { kind: "kill"; daemon: DaemonInfo }
	| { kind: "shutdown"; daemon: DaemonInfo }
	| { kind: "skip"; daemon: DaemonInfo; reason: string };

/**
 * Decide what to do with each discovered daemon (pure, no side effects). Reap
 * targets only clearly-safe daemons: orphaned socket files (including a stale
 * default daemon.sock with no live process), and reachable idle daemons on
 * non-default sockets. A reachable default daemon, and any reachable daemon with
 * live sessions, are never touched.
 *
 * Unreachable (hung) daemons can't report a session count, so they are only
 * ever killed with `force`, and even then never via a pid that backs more than
 * one discovered daemon (e.g. macOS lsof reports every unix socket a process
 * holds, so killing a shared pid could take down a reachable daemon with live
 * sessions). runReap additionally captures the exact process start, physical
 * socket path, and socket inode, then requires the same observation immediately
 * before each signal. A changed or recovered daemon is retained.
 */
export function planReap(daemons: readonly DaemonInfo[], force: boolean): ReapAction[] {
	const pidCounts = new Map<number, number>();
	for (const daemon of daemons) {
		if (daemon.pid !== undefined) {
			pidCounts.set(daemon.pid, (pidCounts.get(daemon.pid) ?? 0) + 1);
		}
	}

	return daemons.map((daemon): ReapAction => {
		// An orphan socket file has no owning process, so removing it is safe even
		// on the default path (a stale daemon.sock left by a crash). Decide this
		// before the default guard so a dead default socket still gets cleaned up.
		if (daemon.status === "orphan-file") {
			return { kind: "remove-file", daemon };
		}
		if (daemon.isDefault) {
			return { kind: "skip", daemon, reason: "default background service" };
		}
		if (daemon.status === "unreachable") {
			if (!force || daemon.pid === undefined) {
				return { kind: "skip", daemon, reason: 'unreachable; use "prime-agent shutdown --force" to stop it' };
			}
			if ((pidCounts.get(daemon.pid) ?? 0) > 1) {
				return {
					kind: "skip",
					daemon,
					reason: `unreachable; pid ${daemon.pid} also backs another daemon, not killing`,
				};
			}
			return { kind: "kill", daemon };
		}
		if (daemon.sessionCount !== 0) {
			return { kind: "skip", daemon, reason: `has ${daemon.sessionCount ?? "unknown"} session(s)` };
		}
		return { kind: "shutdown", daemon };
	});
}

export function planShutdownAll(daemons: readonly DaemonInfo[], force: boolean): ReapAction[] {
	return daemons.map((daemon): ReapAction => {
		if (daemon.status === "orphan-file") {
			return { kind: "remove-file", daemon };
		}
		if (daemon.status === "unreachable") {
			if (daemon.pid === undefined) {
				if (daemon.hasUnverifiedEndpointCandidate) {
					return { kind: "skip", daemon, reason: "unverified endpoint candidate; retained" };
				}
				return force || !daemon.hasTrackedWorkers
					? { kind: "remove-file", daemon }
					: { kind: "skip", daemon, reason: "has unreachable workers; use --force to kill" };
			}
			return force ? { kind: "kill", daemon } : { kind: "skip", daemon, reason: "unreachable; use --force to kill" };
		}
		return { kind: "shutdown", daemon };
	});
}

const SHUTDOWN_ALL_ACTION_ORDER: Record<ReapAction["kind"], number> = {
	shutdown: 0,
	"remove-file": 1,
	kill: 2,
	skip: 3,
};

export type ShutdownConfirmationPlan = "none" | "prompt" | "json-error" | "tty-error";

export function planShutdownConfirmation(
	daemonCount: number,
	json: boolean,
	force: boolean,
	stdinIsTTY: boolean | undefined,
): ShutdownConfirmationPlan {
	if (daemonCount === 0 || force) return "none";
	if (json) return "json-error";
	return stdinIsTTY ? "prompt" : "tty-error";
}

export async function runShutdownAll(json: boolean, force: boolean): Promise<void> {
	const daemons = await discoverDaemons();
	switch (planShutdownConfirmation(daemons.length, json, force, process.stdin.isTTY)) {
		case "json-error":
			process.exitCode = 1;
			console.log(
				JSON.stringify(
					{
						stopped: [],
						failed: daemons.map(({ socketPath }) => ({
							socketPath,
							reason: 'confirmation required; use "prime-agent shutdown --force --json"',
						})),
					},
					null,
					2,
				),
			);
			return;
		case "tty-error":
			throw new Error(
				'Shutdown requires confirmation in an interactive terminal. Use "prime-agent shutdown --force".',
			);
		case "prompt": {
			const confirmed = await promptYesNo(
				"Stop every agent and background service? Active work will be interrupted.",
			);
			if (!confirmed) {
				console.log(chalk.dim("Shutdown cancelled."));
				return;
			}
			break;
		}
		case "none":
			break;
	}
	const admission = await acquireDaemonShutdownAdmission();
	try {
		await runShutdownAllConverging(json, force, () => admission.assertOrRenew());
	} finally {
		await admission.release();
	}
}

async function runShutdownAllConverging(
	json: boolean,
	force: boolean,
	assertAdmission: () => Promise<void>,
): Promise<void> {
	const stopped: Array<{ socketPath: string; action: string }> = [];
	const failed: Array<{ socketPath: string; reason: string }> = [];
	const handledPids = new Set<number>();
	const reportedFailures = new Set<string>();
	const workerInventory = enumerateCanonicalDaemonWorkerDescriptors(getAgentDir());
	const trackedWorkerSockets = trackedWorkerSocketPaths(workerInventory);
	const genericTerminationBlocked = workerInventory.retained.some((entry) => !entry.socketPath);

	if (force) {
		await stopHiddenSupervisors(
			stopped,
			failed,
			handledPids,
			reportedFailures,
			assertAdmission,
			trackedWorkerSockets,
			genericTerminationBlocked,
		);
	}
	const daemons = (await discoverDaemons(workerInventory)).filter(
		(daemon) => !trackedWorkerSockets.has(daemon.socketPath),
	);
	const actions = [...planShutdownAll(daemons, force)].sort(
		(left, right) => SHUTDOWN_ALL_ACTION_ORDER[left.kind] - SHUTDOWN_ALL_ACTION_ORDER[right.kind],
	);

	for (const action of actions) {
		const { socketPath, pid } = action.daemon;
		if (genericTerminationBlocked && action.kind !== "skip") {
			failed.push({
				socketPath,
				reason: "daemon mutation retained because worker descriptor scope is unresolved",
			});
			continue;
		}
		switch (action.kind) {
			case "remove-file": {
				if ((await probeDaemon(socketPath)).reachable) {
					apply(
						await stopBackgroundService(socketPath, pid, handledPids, force, assertAdmission),
						socketPath,
						stopped,
						failed,
					);
				} else {
					const reason = await removeOrphanSocketFile(socketPath, assertAdmission);
					if (reason) failed.push({ socketPath, reason });
					else stopped.push({ socketPath, action: "removed verified stale socket file" });
				}
				break;
			}
			case "kill":
			case "shutdown":
				apply(
					await stopBackgroundService(socketPath, pid, handledPids, force, assertAdmission),
					socketPath,
					stopped,
					failed,
				);
				break;
			case "skip":
				failed.push({ socketPath, reason: action.reason });
				break;
		}
	}

	const stoppedSocketPaths = new Set(stopped.map((entry) => normalizeSocketPath(entry.socketPath)));
	const workerProofRequired = force || stoppedSocketPaths.size > 0;
	const workerFailures: Array<{ socketPath: string; reason: string }> = workerProofRequired
		? workerInventory.retained.map((entry) => ({
				socketPath: entry.socketPath ?? entry.path,
				reason: `retained worker descriptor evidence ${entry.path}: ${entry.reason}`,
			}))
		: [];
	for (const entry of workerInventory.descriptors) {
		const supervisorSocketPath = normalizeSocketPath(entry.descriptor.supervisorSocketPath);
		if (!force && !stoppedSocketPaths.has(supervisorSocketPath)) continue;
		workerFailures.push(
			...(await forceStopTrackedWorker(entry.descriptor, entry.descriptorPath, assertAdmission)).map((reason) => ({
				socketPath: normalizeSocketPath(entry.descriptor.socketPath),
				reason,
			})),
		);
	}
	failed.push(...workerFailures);
	if (force) {
		await terminateVerifiedResiduals(
			stopped,
			failed,
			handledPids,
			reportedFailures,
			assertAdmission,
			trackedWorkerSockets,
			genericTerminationBlocked,
		);
	}
	if (workerFailures.length > 0 && stopped.length > 0) {
		for (const entry of stopped.splice(0)) {
			failed.push({
				socketPath: entry.socketPath,
				reason: `root stop was not reported because worker cleanup proof is unresolved (${entry.action})`,
			});
		}
	}

	if (json) {
		if (failed.length > 0) process.exitCode = 1;
		console.log(JSON.stringify({ stopped, failed }, null, 2));
		return;
	}
	if (stopped.length === 0 && failed.length === 0) {
		console.log("No background services found.");
		return;
	}
	for (const entry of stopped) console.log(chalk.green(`stopped ${entry.socketPath}: ${entry.action}`));
	for (const entry of failed) console.log(chalk.red(`failed  ${entry.socketPath}: ${entry.reason}`));
	if (failed.length > 0) process.exitCode = 1;
}

async function stopHiddenSupervisors(
	stopped: Array<{ socketPath: string; action: string }>,
	failed: Array<{ socketPath: string; reason: string }>,
	handledPids: Set<number>,
	reportedFailures: Set<string>,
	assertAdmission: () => Promise<void>,
	trackedWorkerSockets: ReadonlySet<string>,
	genericTerminationBlocked: boolean,
): Promise<void> {
	if (genericTerminationBlocked) {
		recordShutdownFailure(
			failed,
			reportedFailures,
			"worker-descriptor-authority",
			"generic daemon termination retained because worker descriptor scope is unresolved",
		);
		return;
	}
	while (true) {
		const listeners = scanListeningDaemons().filter((listener) => !trackedWorkerSockets.has(listener.socketPath));
		const bySocket = new Map<string, DaemonListenerObservation[]>();
		for (const listener of listeners) {
			const group = bySocket.get(listener.socketPath) ?? [];
			group.push(listener);
			bySocket.set(listener.socketPath, group);
		}
		const hidden: DaemonListenerObservation[] = [];
		for (const [socketPath, group] of bySocket) {
			if (new Set(group.map((listener) => listener.pid)).size < 2) {
				continue;
			}
			const probe = await probeDaemon(group[0]?.connectPath ?? operationalDaemonSocketPath(socketPath));
			const current = group.find(
				(listener) =>
					listener.pid === probe.supervisorPid &&
					listener.exactStartId === probe.supervisorAuthorityProcessStartId,
			);
			if (!current) {
				recordShutdownFailure(
					failed,
					reportedFailures,
					socketPath,
					"could not identify the current same-path daemon",
				);
				continue;
			}
			hidden.push(...group.filter((listener) => !sameDaemonListenerObservation(listener, current)));
		}
		if (hidden.length === 0) {
			return;
		}
		const before = daemonListenerSignature(hidden);
		for (const listener of hidden) {
			if (await terminateVerifiedListener(listener, failed, reportedFailures, assertAdmission)) {
				handledPids.add(listener.pid);
				stopped.push({ socketPath: listener.socketPath, action: `stopped hidden daemon (pid ${listener.pid})` });
			}
		}
		const afterHidden = scanListeningDaemons().filter(
			(listener) =>
				!trackedWorkerSockets.has(listener.socketPath) &&
				hidden.some((candidate) => sameDaemonListenerObservation(candidate, listener)),
		);
		if (afterHidden.length === 0 || daemonListenerSignature(afterHidden) === before) {
			return;
		}
	}
}

async function terminateVerifiedResiduals(
	stopped: Array<{ socketPath: string; action: string }>,
	failed: Array<{ socketPath: string; reason: string }>,
	handledPids: Set<number>,
	reportedFailures: Set<string>,
	assertAdmission: () => Promise<void>,
	trackedWorkerSockets: ReadonlySet<string>,
	genericTerminationBlocked: boolean,
): Promise<void> {
	if (genericTerminationBlocked) {
		recordShutdownFailure(
			failed,
			reportedFailures,
			"worker-descriptor-authority",
			"generic residual termination retained because worker descriptor scope is unresolved",
		);
		return;
	}
	let previousSignature: string | undefined;
	let quietSince: number | undefined;
	let unverifiedSince: number | undefined;
	const deadline = Date.now() + SHUTDOWN_CONVERGENCE_TIMEOUT_MS;
	while (true) {
		await assertAdmission();
		const listenerScan = scanDaemonListenerObservations();
		if (listenerScan.retained.length > 0) {
			for (const listener of listenerScan.retained) {
				recordShutdownFailure(
					failed,
					reportedFailures,
					listener.socketPath,
					`listener identity is unavailable; retained pid ${listener.pid}`,
				);
			}
			return;
		}
		const allListeners = listenerScan.verified;
		const workerListeners = allListeners.filter((listener) => trackedWorkerSockets.has(listener.socketPath));
		if (workerListeners.length > 0) {
			recordResidualListenerFailures(
				workerListeners,
				failed,
				reportedFailures,
				"is retained as tracked worker authority",
			);
			return;
		}
		const listeners = allListeners.filter((listener) => !trackedWorkerSockets.has(listener.socketPath));
		const verifiedSocketPaths = new Set(allListeners.map((listener) => listener.socketPath));
		const unverifiedEndpoints = scanDaemonSocketOperationCandidates().filter(
			(candidate) =>
				!trackedWorkerSockets.has(candidate.socketPath) && !verifiedSocketPaths.has(candidate.socketPath),
		);
		const now = Date.now();
		if (listeners.length === 0 && unverifiedEndpoints.length > 0) {
			previousSignature = undefined;
			quietSince = undefined;
			unverifiedSince ??= now;
			if (now - unverifiedSince >= SHUTDOWN_QUIET_PERIOD_MS) {
				for (const endpoint of unverifiedEndpoints) {
					recordShutdownFailure(
						failed,
						reportedFailures,
						endpoint.socketPath,
						"unverified endpoint candidate remained after shutdown; retained",
					);
				}
				return;
			}
			await delay(100);
			continue;
		}
		unverifiedSince = undefined;
		if (listeners.length === 0) {
			previousSignature = undefined;
			quietSince ??= now;
			const quietPeriod = evaluateShutdownQuietPeriod(now, quietSince);
			if (quietPeriod === "complete") {
				return;
			}
			await delay(100);
			continue;
		}
		quietSince = undefined;
		const signature = daemonListenerSignature(listeners);
		if (now >= deadline) {
			recordResidualListenerFailures(listeners, failed, reportedFailures, "kept respawning during shutdown");
			return;
		}
		if (signature === previousSignature) {
			recordResidualListenerFailures(listeners, failed, reportedFailures, "remained after shutdown");
			return;
		}
		previousSignature = signature;
		const seenPids = new Set<number>();
		for (const listener of listeners) {
			if (seenPids.has(listener.pid)) {
				continue;
			}
			seenPids.add(listener.pid);
			const alreadyReported = handledPids.has(listener.pid);
			if (await terminateVerifiedListener(listener, failed, reportedFailures, assertAdmission)) {
				handledPids.add(listener.pid);
				if (!alreadyReported) {
					stopped.push({
						socketPath: listener.socketPath,
						action: `stopped residual daemon process (pid ${listener.pid})`,
					});
				}
			}
		}
	}
}

function recordResidualListenerFailures(
	listeners: readonly DaemonListenerObservation[],
	failed: Array<{ socketPath: string; reason: string }>,
	reportedFailures: Set<string>,
	reason: string,
): void {
	for (const listener of listeners) {
		const identity = `pid ${listener.pid}, start ${listener.exactStartId}`;
		recordShutdownFailure(
			failed,
			reportedFailures,
			listener.socketPath,
			`daemon ${reason} (${identity})${describeDaemonParent(listener.pid)}`,
		);
	}
}
function describeDaemonParent(pid: number): string {
	const result = spawnSync("ps", ["-o", "ppid=,tty=,command=", "-p", String(pid)], { encoding: "utf8" });
	if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
		return "";
	}
	const match = result.stdout.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
	if (!match) {
		return "";
	}
	return `; close parent PID ${match[1]} on ${match[2]} (${match[3]}) and retry shutdown`;
}

async function terminateVerifiedListener(
	listener: DaemonListenerObservation,
	failed: Array<{ socketPath: string; reason: string }>,
	reportedFailures: Set<string>,
	assertAdmission: () => Promise<void>,
): Promise<boolean> {
	if (process.platform === "win32") {
		recordShutdownFailure(
			failed,
			reportedFailures,
			listener.socketPath,
			`retained daemon ${listener.pid}: process-tree death cannot be proved on Windows`,
		);
		return false;
	}
	const signal = async (name: NodeJS.Signals): Promise<boolean> => {
		await assertAdmission();
		const immediate = await captureReachableDaemonListenerObservation(
			listener.connectPath ?? operationalDaemonSocketPath(listener.socketPath),
			listener.pid,
		);
		if (!immediate || !sameDaemonListenerObservation(immediate, listener)) return false;
		try {
			process.kill(listener.pid, name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
		}
		return true;
	};

	if (!(await signal("SIGTERM"))) {
		recordShutdownFailure(
			failed,
			reportedFailures,
			listener.socketPath,
			`daemon listener identity changed before SIGTERM (pid ${listener.pid})`,
		);
		return false;
	}
	let deadline = Date.now() + 1000;
	while (
		classifyProcessIdentityAuthority(listener.pid, listener.exactStartId) !== "exact-dead" &&
		Date.now() < deadline
	) {
		await delay(50);
	}
	if (classifyProcessIdentityAuthority(listener.pid, listener.exactStartId) !== "exact-dead") {
		if (!(await signal("SIGKILL"))) {
			recordShutdownFailure(
				failed,
				reportedFailures,
				listener.socketPath,
				`daemon listener identity changed before SIGKILL (pid ${listener.pid})`,
			);
			return false;
		}
		deadline = Date.now() + 1000;
		while (
			classifyProcessIdentityAuthority(listener.pid, listener.exactStartId) !== "exact-dead" &&
			Date.now() < deadline
		) {
			await delay(50);
		}
	}
	if (classifyProcessIdentityAuthority(listener.pid, listener.exactStartId) !== "exact-dead") {
		recordShutdownFailure(
			failed,
			reportedFailures,
			listener.socketPath,
			`daemon root death was not proved (pid ${listener.pid})`,
		);
		return false;
	}
	const cleanup = await removeVerifiedListenerSocket(listener, assertAdmission);
	if (cleanup !== undefined) {
		recordShutdownFailure(failed, reportedFailures, listener.socketPath, cleanup);
		return false;
	}
	return true;
}

async function removeVerifiedListenerSocket(
	listener: DaemonListenerObservation,
	assertAdmission: () => Promise<void>,
): Promise<string | undefined> {
	await assertAdmission();
	if (hasAnyDaemonListenerAtSocket(listener.socketPath)) {
		return `socket listener changed before unlink (pid ${listener.pid})`;
	}
	let currentIdentity: DaemonSocketIdentity | undefined;
	try {
		currentIdentity = getDaemonSocketIdentity(listener.socketPath);
	} catch (error) {
		return `socket path could not be verified before unlink: ${String(error)}`;
	}
	if (!currentIdentity) return undefined;
	if (!sameDaemonSocketIdentity(currentIdentity, listener.socketIdentity)) {
		return `socket file identity changed before unlink (pid ${listener.pid})`;
	}

	let lease: Awaited<ReturnType<typeof acquireDaemonSocketPathLease>>;
	try {
		lease = await acquireDaemonSocketPathLease(listener.socketPath);
	} catch (error) {
		return `socket authority could not be acquired before unlink: ${String(error)}`;
	}
	if (!lease) return process.platform === "win32" ? "socket unlink proof is unavailable on Windows" : undefined;
	try {
		await assertAdmission();
		assertSocketLease(listener.socketPath, lease);
		if (hasAnyDaemonListenerAtSocket(listener.socketPath)) {
			return `socket listener changed immediately before unlink (pid ${listener.pid})`;
		}
		const immediate = getDaemonSocketIdentity(listener.socketPath);
		if (!immediate || !sameDaemonSocketIdentity(immediate, listener.socketIdentity)) {
			return immediate ? `socket file identity changed immediately before unlink (pid ${listener.pid})` : undefined;
		}
		cleanupDaemonSocketPath(listener.socketPath, listener.socketIdentity, lease);
		let remaining: DaemonSocketIdentity | undefined;
		try {
			remaining = getDaemonSocketIdentity(listener.socketPath);
		} catch (error) {
			return `replacement socket path could not be verified after cleanup: ${String(error)}`;
		}
		if (!remaining) return undefined;
		return sameDaemonSocketIdentity(remaining, listener.socketIdentity)
			? `verified socket file remained after cleanup (pid ${listener.pid})`
			: `replacement socket path was retained after cleanup (pid ${listener.pid})`;
	} finally {
		await lease.release().catch(() => undefined);
	}
}

function daemonListenerSignature(listeners: readonly DaemonListenerObservation[]): string {
	return listeners
		.map(
			(listener) =>
				`${listener.pid}:${listener.exactStartId}:${listener.socketPath}:${listener.socketIdentity.dev}:${listener.socketIdentity.ino}`,
		)
		.sort()
		.join("\n");
}

function recordShutdownFailure(
	failed: Array<{ socketPath: string; reason: string }>,
	reportedFailures: Set<string>,
	socketPath: string,
	reason: string,
): void {
	const key = `${socketPath}\0${reason}`;
	if (reportedFailures.has(key)) {
		return;
	}
	reportedFailures.add(key);
	failed.push({ socketPath, reason });
}

async function stopBackgroundService(
	socketPath: string,
	pid: number | undefined,
	handledPids: Set<number>,
	force: boolean,
	assertAdmission: () => Promise<void>,
): Promise<ReapOutcome> {
	const physicalSocketPath = normalizeSocketPath(socketPath);
	let listener = scanListeningDaemons().find(
		(candidate) => candidate.socketPath === physicalSocketPath && (pid === undefined || candidate.pid === pid),
	);
	if (!listener) {
		const operationCandidate = scanDaemonSocketOperationCandidates().find(
			(candidate) => candidate.socketPath === physicalSocketPath,
		);
		listener = await captureReachableDaemonListenerObservation(
			operationCandidate?.connectPath ?? operationalDaemonSocketPath(physicalSocketPath),
			pid,
		);
	}
	if (!listener) return { skipped: "no stable exact listener identity; retained" };

	await assertAdmission();
	const graceful = await shutdownDaemon(listener.connectPath ?? physicalSocketPath, force, listener);
	if (graceful) {
		const deadline = Date.now() + 1000;
		while (
			classifyProcessIdentityAuthority(listener.pid, listener.exactStartId) !== "exact-dead" &&
			Date.now() < deadline
		) {
			await delay(50);
		}
		if (classifyProcessIdentityAuthority(listener.pid, listener.exactStartId) === "exact-dead") {
			const cleanupFailure = await removeVerifiedListenerSocket(listener, assertAdmission);
			if (!cleanupFailure) {
				handledPids.add(listener.pid);
				return { reaped: `stopped background service (pid ${listener.pid})` };
			}
			return { skipped: cleanupFailure };
		}
	}
	if (!force) return { skipped: "did not prove root death; retry with --force" };

	const failures: Array<{ socketPath: string; reason: string }> = [];
	const reported = new Set<string>();
	if (!(await terminateVerifiedListener(listener, failures, reported, assertAdmission))) {
		return { skipped: failures[0]?.reason ?? "verified daemon stop failed" };
	}
	handledPids.add(listener.pid);
	return { reaped: `force-stopped background service (pid ${listener.pid})` };
}

interface TrackedWorker {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
}

export type TrackedWorkerLiveness = "live" | "exact-dead" | "uncertain";

export function classifyTrackedWorkerLiveness(
	pidExists: boolean,
	expectedProcessStartId: string | undefined,
	observedProcessStartId: string | undefined,
): TrackedWorkerLiveness {
	if (!pidExists) {
		return "exact-dead";
	}
	if (
		!expectedProcessStartId ||
		!observedProcessStartId ||
		!isExactProcessStartId(expectedProcessStartId) ||
		!isExactProcessStartId(observedProcessStartId)
	) {
		return "uncertain";
	}
	return expectedProcessStartId === observedProcessStartId ? "live" : "exact-dead";
}

function getTrackedWorkerLiveness(descriptor: DaemonWorkerDescriptor): TrackedWorkerLiveness {
	const authority = classifyProcessIdentityAuthority(descriptor.pid, daemonWorkerProcessAuthority(descriptor));
	return authority === "exact-live" ? "live" : authority === "exact-dead" ? "exact-dead" : "uncertain";
}

function trackedWorkerHasExactDeadTreeDisposition(descriptor: DaemonWorkerDescriptor): boolean {
	const processStartId = daemonWorkerProcessAuthority(descriptor);
	return isOrphanProcessCandidateExactDead({
		pid: descriptor.pid,
		...(processStartId ? { processStartId } : {}),
	});
}

export async function forceStopTrackedWorker(
	descriptor: DaemonWorkerDescriptor,
	descriptorPath: string,
	assertAdmission: () => Promise<void>,
	agentDir: string = getAgentDir(),
): Promise<string[]> {
	const result = await cleanupDaemonWorkerArtifacts({
		descriptorPath,
		expectedWorkerId: descriptor.workerId,
		expectedDescriptor: descriptor,
		layout: { agentDir },
		ensureStopTombstone: true,
		assertAuthority: () => assertAdmission(),
	});
	return result.status === "cleaned"
		? []
		: [
				`could not safely stop and clean worker ${descriptor.workerId} (pid ${descriptor.pid}): ${result.reason}` +
					(result.journalPath ? `; retained authority ${result.journalPath}` : ""),
			];
}

async function forceStopTrackedWorkers(
	supervisorSocketPath: string,
	assertAdmission: () => Promise<void>,
	workers: readonly TrackedWorker[],
): Promise<string[]> {
	const failures: string[] = [];
	for (const worker of workers.filter(
		(candidate) =>
			normalizeSocketPath(candidate.descriptor.supervisorSocketPath) === normalizeSocketPath(supervisorSocketPath),
	)) {
		failures.push(...(await forceStopTrackedWorker(worker.descriptor, worker.descriptorPath, assertAdmission)));
	}
	return failures;
}

function findAllTrackedWorkers(agentDir: string = getAgentDir()): TrackedWorker[] {
	return enumerateCanonicalDaemonWorkerDescriptors(agentDir).descriptors.map((entry) => ({
		descriptor: entry.descriptor,
		descriptorPath: entry.descriptorPath,
	}));
}

export async function cleanupExactDeadWorkerTombstone(
	descriptorPath: string,
	expectedWorkerId: string,
	agentDir: string = getAgentDir(),
): Promise<ReapOutcome> {
	const initial = readCanonicalDaemonWorkerDescriptor(descriptorPath, { agentDir });
	if (!initial.ok || initial.value.descriptor.workerId !== expectedWorkerId) {
		return { skipped: initial.ok ? "worker descriptor changed or disappeared" : initial.reason };
	}
	const descriptor = initial.value.descriptor;
	if (!descriptor.stopRequestedAt) return { skipped: "worker is not stop-tombstoned" };
	if (!trackedWorkerHasExactDeadTreeDisposition(descriptor)) {
		return { skipped: "worker process tree is live or its identity is uncertain" };
	}

	const maintenance = await acquireDaemonOfflineMaintenanceLease({
		socketPath: descriptor.supervisorSocketPath,
		descriptorDir: dirname(descriptorPath),
	});
	if (!maintenance) {
		return { skipped: "worker scope is owned; cleanup deferred" };
	}
	try {
		const result = await cleanupDaemonWorkerArtifacts({
			descriptorPath,
			expectedWorkerId,
			expectedDescriptor: descriptor,
			layout: { agentDir },
			assertAuthority: () => maintenance.assertOrRenew(),
		});
		return result.status === "cleaned"
			? { reaped: `removed exact-dead worker tombstone ${expectedWorkerId}` }
			: { skipped: result.reason };
	} finally {
		await maintenance.release();
	}
}

export async function runReap(json: boolean, force: boolean): Promise<void> {
	const reaped: Array<{ socketPath: string; action: string }> = [];
	const skipped: Array<{ socketPath: string; reason: string }> = [];
	for (const worker of findAllTrackedWorkers()) {
		if (!worker.descriptor.stopRequestedAt || getTrackedWorkerLiveness(worker.descriptor) !== "exact-dead") continue;
		apply(
			await cleanupExactDeadWorkerTombstone(worker.descriptorPath, worker.descriptor.workerId),
			worker.descriptor.socketPath,
			reaped,
			skipped,
		);
	}

	const admission = await acquireDaemonShutdownAdmission();
	const handledPids = new Set<number>();
	try {
		const assertAdmission = () => admission.assertOrRenew();
		const workerInventory = enumerateCanonicalDaemonWorkerDescriptors(getAgentDir());
		const workers = workerInventory.descriptors.map((entry) => ({
			descriptor: entry.descriptor,
			descriptorPath: entry.descriptorPath,
		}));
		const genericTerminationBlocked = workerInventory.retained.some((entry) => !entry.socketPath);
		const workerProofFailures: Array<{ socketPath: string; reason: string }> = force
			? workerInventory.retained.map((entry) => ({
					socketPath: entry.socketPath ?? entry.path,
					reason: `retained worker descriptor evidence ${entry.path}: ${entry.reason}`,
				}))
			: [];
		const daemons = await discoverDaemons(workerInventory);
		for (const action of planReap(daemons, force)) {
			const { socketPath, pid } = action.daemon;
			if (genericTerminationBlocked && action.kind !== "skip") {
				skipped.push({
					socketPath,
					reason: "generic daemon termination retained because worker descriptor scope is unresolved",
				});
				continue;
			}
			switch (action.kind) {
				case "skip":
					skipped.push({ socketPath, reason: action.reason });
					break;
				case "remove-file": {
					if ((await probeDaemon(socketPath)).reachable) {
						apply(
							await stopBackgroundService(socketPath, pid, handledPids, false, assertAdmission),
							socketPath,
							reaped,
							skipped,
						);
					} else {
						const reason = await removeOrphanSocketFile(socketPath, assertAdmission);
						if (reason) skipped.push({ socketPath, reason });
						else reaped.push({ socketPath, action: "removed verified stale socket file" });
					}
					break;
				}
				case "kill":
				case "shutdown":
					apply(
						await stopBackgroundService(socketPath, pid, handledPids, action.kind === "kill", assertAdmission),
						socketPath,
						reaped,
						skipped,
					);
					break;
			}
			if (force && action.kind !== "skip") {
				workerProofFailures.push(
					...(await forceStopTrackedWorkers(socketPath, assertAdmission, workers)).map((reason) => ({
						socketPath,
						reason,
					})),
				);
			}
		}
		if (!force && reaped.length > 0) {
			const reapedSocketPaths = new Set(reaped.map((entry) => normalizeSocketPath(entry.socketPath)));
			workerProofFailures.push(
				...workerInventory.retained.map((entry) => ({
					socketPath: entry.socketPath ?? entry.path,
					reason: `retained worker descriptor evidence ${entry.path}: ${entry.reason}`,
				})),
			);
			for (const worker of workers) {
				if (!reapedSocketPaths.has(normalizeSocketPath(worker.descriptor.supervisorSocketPath))) continue;
				workerProofFailures.push(
					...(await forceStopTrackedWorker(worker.descriptor, worker.descriptorPath, assertAdmission)).map(
						(reason) => ({ socketPath: normalizeSocketPath(worker.descriptor.socketPath), reason }),
					),
				);
			}
		}
		if (workerProofFailures.length > 0) {
			skipped.push(...workerProofFailures);
			for (const entry of reaped.splice(0)) {
				skipped.push({
					socketPath: entry.socketPath,
					reason: `reap was not reported because worker cleanup proof is unresolved (${entry.action})`,
				});
			}
		}
	} finally {
		await admission.release();
	}

	if (json) {
		console.log(JSON.stringify({ reaped, skipped }, null, 2));
		return;
	}
	if (reaped.length === 0 && skipped.length === 0) {
		console.log("No background services found.");
		return;
	}
	for (const entry of reaped) console.log(chalk.green(`reaped ${entry.socketPath}: ${entry.action}`));
	for (const entry of skipped) console.log(chalk.dim(`kept   ${entry.socketPath}: ${entry.reason}`));
}

export type ReapOutcome = { reaped: string } | { skipped: string };

function apply(
	outcome: ReapOutcome,
	socketPath: string,
	reaped: Array<{ socketPath: string; action: string }>,
	skipped: Array<{ socketPath: string; reason: string }>,
): void {
	if ("reaped" in outcome) {
		reaped.push({ socketPath, action: outcome.reaped });
	} else {
		skipped.push({ socketPath, reason: outcome.skipped });
	}
}

async function removeOrphanSocketFile(
	socketPath: string,
	assertAdmission: () => Promise<void>,
): Promise<string | undefined> {
	const physicalSocketPath = normalizeSocketPath(socketPath);
	const operationPath = operationalDaemonSocketPath(physicalSocketPath);
	let expectedIdentity: DaemonSocketIdentity | undefined;
	try {
		expectedIdentity = getDaemonSocketIdentity(physicalSocketPath);
	} catch (error) {
		return `socket path could not be verified: ${String(error)}`;
	}
	if (!expectedIdentity) return undefined;
	if (await daemonSocketAcceptsConnection(operationPath)) {
		return "socket became reachable before cleanup";
	}
	await assertAdmission();
	if (hasAnyDaemonListenerAtSocket(physicalSocketPath)) {
		return "socket became a live listener before cleanup";
	}
	let lease: Awaited<ReturnType<typeof acquireDaemonSocketPathLease>>;
	try {
		lease = await acquireDaemonSocketPathLease(physicalSocketPath);
	} catch (error) {
		return `socket authority could not be acquired: ${String(error)}`;
	}
	if (!lease) return "socket unlink proof is unavailable on Windows";
	try {
		await assertAdmission();
		assertSocketLease(physicalSocketPath, lease);
		if (hasAnyDaemonListenerAtSocket(physicalSocketPath)) {
			return "socket became a live listener immediately before cleanup";
		}
		if (await daemonSocketAcceptsConnection(operationPath)) {
			return "socket became reachable immediately before cleanup";
		}
		const immediate = getDaemonSocketIdentity(physicalSocketPath);
		if (!immediate || !sameDaemonSocketIdentity(immediate, expectedIdentity)) {
			return immediate ? "socket file identity changed before cleanup" : undefined;
		}
		cleanupDaemonSocketPath(physicalSocketPath, expectedIdentity, lease);
		let remaining: DaemonSocketIdentity | undefined;
		try {
			remaining = getDaemonSocketIdentity(physicalSocketPath);
		} catch (error) {
			return `replacement socket path could not be verified after cleanup: ${String(error)}`;
		}
		if (!remaining) return undefined;
		return sameDaemonSocketIdentity(remaining, expectedIdentity)
			? "verified socket file remained after cleanup"
			: "replacement socket path was retained";
	} finally {
		await lease.release().catch(() => undefined);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask a daemon to shut down and confirm it actually stopped listening. The
 * shutdown ack alone is not proof, so success is reported only once the socket
 * stops accepting connections.
 */
async function shutdownDaemon(
	socketPath: string,
	force: boolean,
	expected: DaemonListenerObservation,
): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	let requestAttempted = false;
	try {
		await client.connect(1000);
		const hello = await client.waitForHello(1000);
		const supervisorIdentity = parseDaemonSupervisorHelloIdentity(hello);
		if (
			supervisorIdentity.status !== "exact" ||
			hello.supervisorPid !== expected.pid ||
			supervisorIdentity.authorityProcessStartId !== expected.exactStartId ||
			typeof hello.supervisorSocketPath !== "string" ||
			normalizeSocketPath(hello.supervisorSocketPath) !== expected.socketPath ||
			!matchesExactProcessIdentity(expected.pid, expected.exactStartId)
		) {
			return false;
		}
		let immediateSocketIdentity: DaemonSocketIdentity | undefined;
		try {
			immediateSocketIdentity = getDaemonSocketIdentity(expected.socketPath);
		} catch {
			return false;
		}
		if (!immediateSocketIdentity || !sameDaemonSocketIdentity(immediateSocketIdentity, expected.socketIdentity)) {
			return false;
		}
		requestAttempted = true;
		await client.request({ type: "shutdown", force }, 1500);
	} catch {
		// The verified daemon may still stop after closing the connection. Root
		// identity and listener proof below remain the source of truth.
	} finally {
		client.close();
	}
	if (!requestAttempted) return false;

	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (classifyProcessIdentityAuthority(expected.pid, expected.exactStartId) === "exact-dead") return true;
		await delay(50);
	}
	return false;
}
