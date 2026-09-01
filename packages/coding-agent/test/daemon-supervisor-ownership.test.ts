import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCliSubprocessEnv } from "../src/cli/subprocess-launch.js";
import {
	ORPHAN_PROCESS_JOURNAL_ENV,
	ORPHAN_PROCESS_JOURNAL_GENERATION_ENV,
} from "../src/core/orphan-process-journal.js";
import { createProcessIdentityOwnerToken, getProcessStartId } from "../src/core/session-lease.js";
import { normalizeSocketPath } from "../src/modes/daemon/daemon-socket.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import {
	acquireDaemonOfflineMaintenanceLease,
	acquireDaemonShutdownAdmission,
	acquireDaemonSupervisorOwnership,
	assertDaemonSupervisorOwnerCurrent,
	daemonSupervisorOwnerLegacyProcessStartId,
	persistDaemonStartupFenceFromOwner,
	waitForDaemonStartupFence,
	withRegistryGuards,
} from "../src/modes/daemon/daemon-supervisor-ownership.js";

type Ownership = Awaited<ReturnType<typeof acquireDaemonSupervisorOwnership>>;

const originalProcessTitle = process.title;
const testSupervisorIdentity = createProcessIdentityOwnerToken();
beforeAll(() => {
	process.title = testSupervisorIdentity.argument;
});
afterAll(() => {
	process.title = originalProcessTitle;
});

interface OwnerRecord {
	token: string;
	generation: string;
	updatedAt: string;
	[key: string]: unknown;
}

const registryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const previousRegistryDirEnv = process.env[registryDirEnv];
const cleanupDirs: string[] = [];

afterEach(() => {
	if (previousRegistryDirEnv === undefined) {
		delete process.env[registryDirEnv];
	} else {
		process.env[registryDirEnv] = previousRegistryDirEnv;
	}
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function createPaths(): {
	root: string;
	registryDir: string;
	socketPath: string;
	agentDir: string;
	descriptorDir: string;
} {
	const root = mkdtempSync(join(tmpdir(), "ownership-registry-"));
	cleanupDirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	return {
		root,
		registryDir: join(root, "registry"),
		socketPath: join(root, "daemon.sock"),
		agentDir,
		descriptorDir: join(root, "workers"),
	};
}

async function acquire(paths: ReturnType<typeof createPaths>, generation = "registry-owner"): Promise<Ownership> {
	return acquireDaemonSupervisorOwnership({
		agentDir: paths.agentDir,
		appVersion: "test",
		descriptorDir: paths.descriptorDir,
		generation,
		registryDir: paths.registryDir,
		socketPath: paths.socketPath,
		offlineMaintenanceWaitMs: 0,
	});
}

function ownerDir(paths: ReturnType<typeof createPaths>, generation: string): string {
	return join(paths.registryDir, `${generation}.owner`);
}

function readJson(path: string): OwnerRecord {
	return JSON.parse(readFileSync(path, "utf8")) as OwnerRecord;
}

interface Frozen849cParentProcessIdentity {
	pid: number;
	processStartId?: string;
}

interface Frozen849cParentShutdownAdmission extends Frozen849cParentProcessIdentity {
	version: 1;
	token: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
}

interface Frozen849cParentStartupFence extends Frozen849cParentProcessIdentity {
	version: 1;
	token: string;
	ownerToken: string;
	socketPath: string;
	supervisorGeneration: string;
	createdAt: string;
}

// Compatibility projection and reader bodies frozen from exact parent 849c92114b0b4372fa272281b87cdbe8f7c9ed8d.
// These intentionally model the frozen parent reader only; it is legacy/non-exact and must never authorize a new
// reader mutation or signal.
function frozen849cParentProcessStartIdProjection(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "win32") {
		try {
			const startTicks = execFileSync(
				"powershell.exe",
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`,
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			).trim();
			return /^\d+$/.test(startTicks) ? `win:${startTicks}` : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		const fields = stat.slice(commandEnd + 2).split(" ");
		const startTime = fields[19];
		if (startTime) return `proc:${startTime}`;
	} catch {}
	try {
		const startTime = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return startTime ? `ps:${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

function frozen849cParentProcessIdentityAlive(identity: Frozen849cParentProcessIdentity): boolean {
	try {
		process.kill(identity.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	if (!identity.processStartId) return true;
	const observed = frozen849cParentProcessStartIdProjection(identity.pid);
	return observed === undefined || observed === identity.processStartId;
}

function readFrozen849cParentActiveShutdownAdmission(path: string): Frozen849cParentShutdownAdmission | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!value || typeof value !== "object") throw new Error(`Invalid daemon shutdown admission: ${path}`);
	const admission = value as Partial<Frozen849cParentShutdownAdmission>;
	if (
		admission.version !== 1 ||
		typeof admission.token !== "string" ||
		!Number.isInteger(admission.pid) ||
		(admission.pid ?? 0) <= 0 ||
		(admission.processStartId !== undefined && typeof admission.processStartId !== "string") ||
		typeof admission.createdAt !== "string" ||
		typeof admission.updatedAt !== "string" ||
		typeof admission.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(admission.expiresAt))
	) {
		throw new Error(`Invalid daemon shutdown admission: ${path}`);
	}
	const parsed = admission as Frozen849cParentShutdownAdmission;
	if (Date.parse(parsed.expiresAt) > Date.now() && frozen849cParentProcessIdentityAlive(parsed)) return parsed;
	rmSync(path, { force: true });
	return undefined;
}

function readFrozen849cParentStartupFence(path: string): Frozen849cParentStartupFence | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!value || typeof value !== "object") throw new Error(`Invalid daemon startup fence: ${path}`);
	const fence = value as Partial<Frozen849cParentStartupFence>;
	if (
		fence.version !== 1 ||
		typeof fence.token !== "string" ||
		typeof fence.ownerToken !== "string" ||
		!Number.isInteger(fence.pid) ||
		(fence.pid ?? 0) <= 0 ||
		typeof fence.processStartId !== "string" ||
		typeof fence.socketPath !== "string" ||
		typeof fence.supervisorGeneration !== "string" ||
		typeof fence.createdAt !== "string"
	) {
		throw new Error(`Invalid daemon startup fence: ${path}`);
	}
	return fence as Frozen849cParentStartupFence;
}

function startupFenceFile(registryDir: string, socketPath: string): string {
	const key = createHash("sha256").update(normalizeSocketPath(socketPath)).digest("hex");
	return join(registryDir, "startup-fences", `${key}.json`);
}

describe("daemon supervisor ownership registry", () => {
	it("scrubs inherited orphan authority from generic CLI children", () => {
		const environment = createCliSubprocessEnv({
			[ORPHAN_PROCESS_JOURNAL_ENV]: "/tmp/stale-orphans.jsonl",
			[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV]: "stale-generation",
			PATH: process.env.PATH,
		});
		expect(environment[ORPHAN_PROCESS_JOURNAL_ENV]).toBeUndefined();
		expect(environment[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV]).toBeUndefined();
	});

	it("mirrors a current owner while the frozen exact-parent fence reader fails closed", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const legacyOwner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "legacy-owner",
			registryDir: legacyDir,
			socketPath: paths.socketPath,
		});
		const record = legacyOwner.record;
		expect(record.authorityProcessStartId).toBe(getProcessStartId(process.pid));
		const hello = {
			supervisorGeneration: record.generation,
			supervisorOwnerToken: record.token,
			supervisorPid: record.pid,
			supervisorProcessStartId: daemonSupervisorOwnerLegacyProcessStartId(record),
			supervisorAuthorityProcessStartId: record.authorityProcessStartId,
			supervisorSocketPath: record.socketPath,
		};
		const legacyOwnerPath = join(legacyDir, "legacy-owner.owner", "owner.json");
		const legacyBytes = readFileSync(legacyOwnerPath, "utf8");

		await persistDaemonStartupFenceFromOwner(paths.socketPath, hello, paths.registryDir, legacyDir);

		const primaryFencePath = startupFenceFile(paths.registryDir, paths.socketPath);
		const legacyFencePath = startupFenceFile(legacyDir, paths.socketPath);
		expect(readFileSync(primaryFencePath, "utf8")).toBe(readFileSync(legacyFencePath, "utf8"));
		// Token authority has no signal-safe legacy projection. The exact parent
		// reader rejects the authority-only fence and therefore overblocks.
		expect(() => readFrozen849cParentStartupFence(legacyFencePath)).toThrow(/Invalid daemon startup fence/);
		expect(readFileSync(legacyOwnerPath, "utf8")).toBe(legacyBytes);

		await expect(persistDaemonStartupFenceFromOwner(paths.socketPath, hello, paths.registryDir)).rejects.toThrow(
			/does not match/,
		);
		await legacyOwner.release();
	});

	it.runIf(process.platform !== "win32")(
		"compares and migrates lexical owner and startup-fence aliases by physical identity",
		async () => {
			const paths = createPaths();
			const physicalParent = join(paths.root, "physical");
			const aliasParent = join(paths.root, "alias");
			mkdirSync(physicalParent);
			symlinkSync(physicalParent, aliasParent, "dir");
			const physicalSocketPath = join(physicalParent, "daemon.sock");
			const aliasSocketPath = join(aliasParent, "daemon.sock");
			const owner = await acquireDaemonSupervisorOwnership({
				agentDir: paths.agentDir,
				appVersion: "test",
				descriptorDir: paths.descriptorDir,
				generation: "alias-owner",
				registryDir: paths.registryDir,
				socketPath: aliasSocketPath,
				offlineMaintenanceWaitMs: 0,
			});
			const ownerDirectory = ownerDir(paths, "alias-owner");
			for (const fileName of ["owner.json", "scope.json"]) {
				const path = join(ownerDirectory, fileName);
				const record = readJson(path);
				writeFileSync(path, `${JSON.stringify({ ...record, socketPath: aliasSocketPath }, null, 2)}\n`);
			}
			await expect(
				acquireDaemonSupervisorOwnership({
					agentDir: paths.agentDir,
					appVersion: "test",
					descriptorDir: join(paths.root, "other-workers"),
					generation: "alias-contender",
					registryDir: paths.registryDir,
					socketPath: physicalSocketPath,
					offlineMaintenanceWaitMs: 0,
				}),
			).rejects.toThrow(/already owns/);
			await owner.updatePhase("owner");
			for (const fileName of ["owner.json", "scope.json"]) {
				expect(readJson(join(ownerDirectory, fileName)).socketPath).toBe(normalizeSocketPath(physicalSocketPath));
			}

			const hello = {
				supervisorGeneration: owner.record.generation,
				supervisorOwnerToken: owner.record.token,
				supervisorPid: owner.record.pid,
				supervisorProcessStartId: daemonSupervisorOwnerLegacyProcessStartId(owner.record),
				supervisorAuthorityProcessStartId: owner.record.authorityProcessStartId,
				supervisorSocketPath: aliasSocketPath,
			};
			await persistDaemonStartupFenceFromOwner(aliasSocketPath, hello, paths.registryDir);
			const canonicalFencePath = startupFenceFile(paths.registryDir, physicalSocketPath);
			const fence = readJson(canonicalFencePath);
			const legacyKey = createHash("sha256").update(resolve(aliasSocketPath)).digest("hex");
			const legacyFencePath = join(paths.registryDir, "startup-fences", `${legacyKey}.json`);
			writeFileSync(legacyFencePath, `${JSON.stringify({ ...fence, socketPath: aliasSocketPath }, null, 2)}\n`);
			rmSync(canonicalFencePath, { force: true });

			await persistDaemonStartupFenceFromOwner(physicalSocketPath, hello, paths.registryDir);
			expect(existsSync(canonicalFencePath)).toBe(true);
			expect(existsSync(legacyFencePath)).toBe(false);
			await owner.release();
		},
	);

	it.each(["primary", "legacy"] as const)(
		"scans and clears a %s-only startup fence without treating the other registry as authority absence",
		async (location) => {
			const paths = createPaths();
			const legacyDir = join(paths.root, "legacy-registry");
			const targetRegistry = location === "primary" ? paths.registryDir : legacyDir;
			const path = startupFenceFile(targetRegistry, paths.socketPath);
			mkdirSync(join(targetRegistry, "startup-fences"), { recursive: true });
			const base = {
				version: 1,
				token: `${location}-only-token`,
				ownerToken: `${location}-owner-token`,
				pid: process.pid,
				processStartId: frozen849cParentProcessStartIdProjection(process.pid)!,
				socketPath: paths.socketPath,
				supervisorGeneration: `${location}-generation`,
				createdAt: new Date().toISOString(),
			};
			writeFileSync(path, `${JSON.stringify(base, null, 2)}\n`);

			await expect(waitForDaemonStartupFence(paths.socketPath, 0, paths.registryDir, legacyDir)).rejects.toThrow(
				/Timed out waiting/,
			);
			expect(existsSync(path)).toBe(true);

			writeFileSync(
				path,
				`${JSON.stringify({ ...base, pid: 2_147_483_647, processStartId: "ps:dead" }, null, 2)}\n`,
			);
			await expect(
				waitForDaemonStartupFence(paths.socketPath, 100, paths.registryDir, legacyDir),
			).resolves.toBeUndefined();
			expect(existsSync(path)).toBe(false);
		},
	);

	it("fails closed on partial or malformed mirrored startup fences", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const primaryPath = startupFenceFile(paths.registryDir, paths.socketPath);
		mkdirSync(join(paths.registryDir, "startup-fences"), { recursive: true });
		writeFileSync(
			primaryPath,
			`${JSON.stringify(
				{
					version: 1,
					token: "partial-token",
					ownerToken: "partial-owner",
					pid: process.pid,
					processStartId: frozen849cParentProcessStartIdProjection(process.pid),
					mirrorRequired: true,
					socketPath: paths.socketPath,
					supervisorGeneration: "partial-generation",
					createdAt: new Date().toISOString(),
				},
				null,
				2,
			)}\n`,
		);
		await expect(waitForDaemonStartupFence(paths.socketPath, 0, paths.registryDir, legacyDir)).rejects.toThrow(
			/mirror is incomplete/,
		);

		mkdirSync(join(legacyDir, "startup-fences"), { recursive: true });
		writeFileSync(startupFenceFile(legacyDir, paths.socketPath), "{not-json\n");
		await expect(waitForDaemonStartupFence(paths.socketPath, 0, paths.registryDir, legacyDir)).rejects.toThrow(
			/Unexpected token|JSON/,
		);
	});

	it("does not clear a live replacement that overtakes a dead startup fence", async () => {
		const paths = createPaths();
		const path = startupFenceFile(paths.registryDir, paths.socketPath);
		mkdirSync(join(paths.registryDir, "startup-fences"), { recursive: true });
		const dead = {
			version: 1,
			token: "dead-predecessor",
			ownerToken: "dead-owner",
			pid: 2_147_483_647,
			processStartId: "ps:dead",
			socketPath: paths.socketPath,
			supervisorGeneration: "dead-generation",
			createdAt: new Date(0).toISOString(),
		};
		writeFileSync(path, `${JSON.stringify(dead, null, 2)}\n`);
		const dropGuard = await lockfile.lock(paths.registryDir, {
			realpath: false,
			lockfilePath: join(paths.registryDir, ".guard"),
		});
		const waiting = waitForDaemonStartupFence(paths.socketPath, 100, paths.registryDir);
		const replacement = {
			...dead,
			token: "live-replacement",
			ownerToken: "live-owner",
			pid: process.pid,
			processStartId: frozen849cParentProcessStartIdProjection(process.pid),
			supervisorGeneration: "live-generation",
			createdAt: new Date().toISOString(),
		};
		writeFileSync(path, `${JSON.stringify(replacement, null, 2)}\n`);
		await dropGuard();

		await expect(waiting).rejects.toThrow(/Timed out waiting/);
		expect(readJson(path).token).toBe("live-replacement");
	});

	it("validates a current dual owner claim through the legacy registry", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const legacyOwner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "legacy-claim-owner",
			registryDir: legacyDir,
			socketPath: paths.socketPath,
		});
		const identity = {
			generation: legacyOwner.record.generation,
			pid: legacyOwner.record.pid,
			...(legacyOwner.record.processStartId ? { processStartId: legacyOwner.record.processStartId } : {}),
			socketPath: legacyOwner.record.socketPath,
		};
		mkdirSync(paths.registryDir, { recursive: true });

		if (legacyOwner.record.processStartId) {
			await expect(
				assertDaemonSupervisorOwnerCurrent(identity, undefined, paths.registryDir, legacyDir),
			).resolves.toEqual(expect.any(String));
		} else {
			// A contender cannot turn a coarse hint into exact authorization.
			await expect(
				assertDaemonSupervisorOwnerCurrent(identity, undefined, paths.registryDir, legacyDir),
			).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		}

		await expect(assertDaemonSupervisorOwnerCurrent(identity, undefined, paths.registryDir)).rejects.toMatchObject({
			code: "supervisor_generation_stale",
		});
		await legacyOwner.release();
	});

	it("verifies authority without waiting for a held registry guard", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths);
		const processStartId = ownership.record.authorityProcessStartId ?? ownership.record.processStartId;
		const identity = {
			generation: ownership.record.generation,
			pid: ownership.record.pid,
			...(processStartId ? { processStartId } : {}),
			socketPath: ownership.record.socketPath,
		};
		// proper-lockfile holds the canonical guard path as a directory, so a caller
		// that takes the mutation guard would spin through its whole retry budget.
		const dropGuard = await lockfile.lock(paths.registryDir, {
			realpath: false,
			lockfilePath: join(paths.registryDir, ".guard"),
		});
		try {
			const startedAt = Date.now();
			await ownership.assertCurrent();
			if (processStartId) {
				await expect(assertDaemonSupervisorOwnerCurrent(identity, undefined, paths.registryDir)).resolves.toEqual(
					expect.any(String),
				);
			}
			expect(Date.now() - startedAt).toBeLessThan(1500);
		} finally {
			await dropGuard();
		}
		await ownership.release();
	});

	it("legacy registry reads never reclaim abandoned legacy directories", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const abandoned = join(legacyDir, "abandoned.owner");
		mkdirSync(abandoned, { recursive: true });

		await expect(
			persistDaemonStartupFenceFromOwner(
				paths.socketPath,
				{
					supervisorGeneration: "legacy",
					supervisorOwnerToken: "legacy",
					supervisorPid: 1,
					supervisorProcessStartId: "proc:1",
					supervisorSocketPath: paths.socketPath,
				},
				paths.registryDir,
				legacyDir,
			),
		).rejects.toThrow(/Invalid daemon supervisor owner record/);

		expect(existsSync(abandoned)).toBe(true);
	});

	it("marks ownership lost when the record is mismatched or absent", async () => {
		const paths = createPaths();
		const mismatched = await acquire(paths, "mismatched-owner");
		const mismatchedPath = join(ownerDir(paths, "mismatched-owner"), "owner.json");
		const foreign = { ...readJson(mismatchedPath), token: "successor-token" };
		writeFileSync(mismatchedPath, `${JSON.stringify(foreign, null, 2)}\n`);

		await expect(mismatched.assertCurrent()).rejects.toMatchObject({
			code: "supervisor_generation_stale",
			name: "DaemonSupervisorOwnershipLostError",
		});
		expect(readJson(mismatchedPath).token).toBe("successor-token");
		await expect(mismatched.release()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		rmSync(ownerDir(paths, "mismatched-owner"), { recursive: true, force: true });

		const reaped = await acquire(paths, "reaped-owner");
		const reapedDir = ownerDir(paths, "reaped-owner");
		rmSync(reapedDir, { recursive: true, force: true });
		await expect(reaped.assertCurrent()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		expect(existsSync(reapedDir)).toBe(false);
		await expect(reaped.release()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
	});

	it("aborts phase mutation and release when the canonical token is replaced", async () => {
		const paths = createPaths();
		const ownership = await acquire(paths, "mutation-replaced-owner");
		const path = join(ownerDir(paths, ownership.record.generation), "owner.json");
		const replacement = { ...readJson(path), token: "replacement-token" };
		writeFileSync(path, `${JSON.stringify(replacement, null, 2)}\n`);

		await expect(ownership.updatePhase("owner")).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		expect(readJson(path).token).toBe("replacement-token");
		await expect(ownership.release()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		expect(readJson(path).token).toBe("replacement-token");
	});

	it("does not resurrect the shutdown admission when release overtakes an in-flight renew", async () => {
		const paths = createPaths();
		mkdirSync(paths.registryDir, { recursive: true, mode: 0o700 });
		process.env[registryDirEnv] = paths.registryDir;
		const admission = await acquireDaemonShutdownAdmission();
		const admissionPath = join(paths.registryDir, "shutdown-admission.json");
		expect(existsSync(admissionPath)).toBe(true);
		const dropGuard = await lockfile.lock(paths.registryDir, {
			realpath: false,
			lockfilePath: join(paths.registryDir, ".guard"),
		});
		const pending = admission.assertOrRenew();
		pending.catch(() => undefined);
		const releasing = admission.release();
		await dropGuard();
		await expect(pending).rejects.toMatchObject({ code: "daemon_shutdown_in_progress" });
		await releasing;
		expect(existsSync(admissionPath)).toBe(false);
	});

	it("keeps global shutdown admission and scoped maintenance mutually exclusive", async () => {
		const paths = createPaths();
		process.env[registryDirEnv] = paths.registryDir;
		const maintenance = await acquireDaemonOfflineMaintenanceLease(
			{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
			paths.registryDir,
		);
		expect(maintenance).toBeDefined();
		let shutdownAcquired = false;
		const pendingShutdown = acquireDaemonShutdownAdmission().then((admission) => {
			shutdownAcquired = true;
			return admission;
		});
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(shutdownAcquired).toBe(false);
		await maintenance?.release();
		const shutdown = await pendingShutdown;
		expect(
			await acquireDaemonOfflineMaintenanceLease(
				{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
				paths.registryDir,
			),
		).toBeUndefined();
		await shutdown.release();
	});

	it("disambiguates never-acquired from lost-on-disk ownership errors", async () => {
		const paths = createPaths();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype) as object, {
			ownership: undefined,
			generation: "unowned-generation",
			socketPath: paths.socketPath,
		});
		const assertCurrentOwnership = Reflect.get(supervisor, "assertCurrentOwnership") as () => Promise<void>;
		const neverAcquired = await assertCurrentOwnership
			.call(supervisor)
			.then(() => undefined)
			.catch((error: unknown) => error as Error & { code?: string });
		if (!neverAcquired) throw new Error("assertCurrentOwnership did not throw");
		expect(neverAcquired.code).toBe("supervisor_generation_stale");
		expect(neverAcquired.message).toContain("holds no registry ownership");
		expect(neverAcquired.message).toContain(paths.socketPath);
		expect(neverAcquired.message).toContain("sessions are preserved");

		const ownership = await acquire(paths);
		const ownerPath = join(ownerDir(paths, ownership.record.generation), "owner.json");
		const foreign = { ...readJson(ownerPath), token: "successor-token" };
		writeFileSync(ownerPath, `${JSON.stringify(foreign, null, 2)}\n`);
		const lostOnDisk = await ownership
			.assertCurrent()
			.then(() => undefined)
			.catch((error: unknown) => error as Error & { code?: string });
		if (!lostOnDisk) throw new Error("assertCurrent did not throw");
		expect(lostOnDisk.code).toBe("supervisor_generation_stale");
		expect(lostOnDisk.message).toContain("no longer owns its registry entry");
		expect(lostOnDisk.message).toContain(paths.socketPath);
		expect(lostOnDisk.message).toContain(paths.registryDir);
		expect(lostOnDisk.message).toContain("sessions are preserved");
		expect(lostOnDisk.message).not.toBe(neverAcquired.message);
		await expect(ownership.release()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
	});

	it("lets a live supervisor fence CLI offline maintenance for the same scope", async () => {
		const paths = createPaths();
		const owner = await acquire(paths, "owner-before-maintenance");

		await expect(
			acquireDaemonOfflineMaintenanceLease(
				{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
				paths.registryDir,
			),
		).resolves.toBeUndefined();

		await owner.release();
		const maintenance = await acquireDaemonOfflineMaintenanceLease(
			{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
			paths.registryDir,
		);
		expect(maintenance).toBeDefined();
		await maintenance?.release();
	});

	it("fences same-scope supervisor start during maintenance but leaves unrelated scopes available", async () => {
		const paths = createPaths();
		const maintenance = await acquireDaemonOfflineMaintenanceLease(
			{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
			paths.registryDir,
		);
		expect(maintenance).toBeDefined();
		const compatibilityOwners = readdirSync(paths.registryDir).filter((name) => name.endsWith(".owner"));
		expect(compatibilityOwners).toHaveLength(1);
		const compatibilityOwner = readJson(join(paths.registryDir, compatibilityOwners[0]!, "owner.json"));
		expect(compatibilityOwner).toMatchObject({
			version: 1,
			role: "supervisor",
			purpose: "offline-maintenance",
			pid: process.pid,
			socketPath: normalizeSocketPath(paths.socketPath),
		});
		expect(
			compatibilityOwner.processStartId ??
				compatibilityOwner.processIdentityHint ??
				compatibilityOwner.authorityProcessStartId ??
				compatibilityOwner.authorityProcessIdentityHint,
		).toBeDefined();
		expect(
			frozen849cParentProcessIdentityAlive(compatibilityOwner as unknown as Frozen849cParentProcessIdentity),
		).toBe(true);
		// An older scanner knows only `*.owner`; this ordinary non-expiring owner
		// is sufficient even though that scanner ignores the lease directory.

		await expect(acquire(paths, "maintenance-blocked-owner")).rejects.toMatchObject({
			code: "daemon_offline_maintenance_in_progress",
		});
		const unrelated = await acquireDaemonSupervisorOwnership({
			agentDir: join(paths.root, "unrelated-agent"),
			appVersion: "test",
			descriptorDir: join(paths.root, "unrelated-workers"),
			generation: "unrelated-owner",
			registryDir: paths.registryDir,
			socketPath: join(paths.root, "unrelated.sock"),
		});
		await unrelated.release();

		await maintenance?.release();
		const owner = await acquire(paths, "owner-after-maintenance");
		await owner.release();
	});

	it("waits boundedly for a maintenance lease to release before acquiring", async () => {
		const paths = createPaths();
		const maintenance = await acquireDaemonOfflineMaintenanceLease(
			{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
			paths.registryDir,
		);
		if (!maintenance) throw new Error("maintenance lease was not acquired");
		const released = new Promise<void>((resolveRelease, rejectRelease) => {
			setTimeout(() => {
				void maintenance.release().then(resolveRelease, rejectRelease);
			}, 25);
		});
		const owner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "waited-owner",
			registryDir: paths.registryDir,
			socketPath: paths.socketPath,
			offlineMaintenanceWaitMs: 500,
		});
		await released;
		await owner.release();
	});

	it("freshly rejects an unchanged owner fingerprint after exact process death", async () => {
		const paths = createPaths();
		const template = await acquire(paths, "fingerprint-owner");
		const ownerPath = join(ownerDir(paths, "fingerprint-owner"), "owner.json");
		const record = readJson(ownerPath);
		await template.release();

		const capability = createProcessIdentityOwnerToken();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", capability.argument], {
			stdio: "ignore",
		});
		if (!child.pid) throw new Error("identity fixture did not start");
		try {
			let processStartId: string | undefined;
			for (let attempt = 0; attempt < 50 && !processStartId; attempt++) {
				processStartId = getProcessStartId(child.pid);
				if (!processStartId) await new Promise((resolve) => setTimeout(resolve, 20));
			}
			if (!processStartId) throw new Error("identity fixture never exposed an exact identity");
			record.pid = child.pid;
			record.authorityProcessStartId = processStartId;
			record.offlineMaintenanceExpiresAt = new Date(0).toISOString();
			delete record.processStartId;
			delete record.processIdentityHint;
			delete record.authorityProcessIdentityHint;
			const directory = ownerDir(paths, "fingerprint-owner");
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "scope.json"),
				`${JSON.stringify({
					version: 1,
					role: "supervisor",
					token: record.token,
					generation: record.generation,
					socketPath: record.socketPath,
					descriptorDir: record.descriptorDir,
				})}\n`,
			);
			writeFileSync(ownerPath, `${JSON.stringify(record, null, 2)}\n`);
			const identity = {
				generation: record.generation,
				pid: child.pid,
				processStartId,
				socketPath: String(record.socketPath),
			};
			const fingerprint = await assertDaemonSupervisorOwnerCurrent(identity, undefined, paths.registryDir);
			await expect(acquire(paths, "exact-live-contender")).rejects.toMatchObject({
				code: "daemon_supervisor_already_running",
			});

			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
			await expect(
				assertDaemonSupervisorOwnerCurrent(identity, fingerprint, paths.registryDir),
			).rejects.toMatchObject({ code: "supervisor_generation_stale" });
			const replacement = await acquire(paths, "exact-dead-replacement");
			await replacement.release();
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	});

	it("retains expired live maintenance and lets its exact token owner renew", async () => {
		const paths = createPaths();
		const maintenance = await acquireDaemonOfflineMaintenanceLease(
			{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
			paths.registryDir,
		);
		if (!maintenance) throw new Error("maintenance lease was not acquired");
		const maintenanceDir = join(paths.registryDir, "offline-maintenance");
		const entry = readdirSync(maintenanceDir).find((name) => name.endsWith(".json"));
		if (!entry) throw new Error("maintenance record was not written");
		const path = join(maintenanceDir, entry);
		const expired = { ...readJson(path), expiresAt: new Date(0).toISOString() };
		writeFileSync(path, `${JSON.stringify(expired, null, 2)}\n`);

		await expect(maintenance.assertOrRenew()).resolves.toBeUndefined();
		expect(Date.parse(String(readJson(path).expiresAt))).toBeGreaterThan(Date.now());
		await expect(acquire(paths, "expired-live-blocked")).rejects.toMatchObject({
			code: "daemon_offline_maintenance_in_progress",
		});
		await maintenance.release();
	});

	it("aborts renewable mutation when a maintenance copy is replaced", async () => {
		const paths = createPaths();
		const maintenance = await acquireDaemonOfflineMaintenanceLease(
			{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
			paths.registryDir,
		);
		if (!maintenance) throw new Error("maintenance lease was not acquired");
		const directory = join(paths.registryDir, "offline-maintenance");
		const entry = readdirSync(directory).find((name) => name.endsWith(".json"));
		if (!entry) throw new Error("maintenance record was not written");
		const path = join(directory, entry);
		const replacement = { ...readJson(path), token: "replacement-token" };
		writeFileSync(path, `${JSON.stringify(replacement, null, 2)}\n`);

		await expect(maintenance.assertOrRenew()).rejects.toMatchObject({
			code: "daemon_offline_maintenance_in_progress",
		});
		expect(readJson(path).token).toBe("replacement-token");
		await expect(maintenance.release()).rejects.toMatchObject({
			code: "daemon_offline_maintenance_in_progress",
		});
	});

	it.each(["missing", "replaced"] as const)(
		"loses maintenance authority when its shutdown sentinel is %s",
		async (scenario) => {
			const paths = createPaths();
			const maintenance = await acquireDaemonOfflineMaintenanceLease(
				{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
				paths.registryDir,
			);
			if (!maintenance) throw new Error("maintenance lease was not acquired");
			const sentinelPath = join(paths.registryDir, "shutdown-admission.json");
			if (scenario === "missing") {
				rmSync(sentinelPath, { force: true });
			} else {
				const replacement = { ...readJson(sentinelPath), token: "replacement-sentinel" };
				writeFileSync(sentinelPath, `${JSON.stringify(replacement, null, 2)}\n`);
			}

			await expect(maintenance.assertOrRenew()).rejects.toMatchObject({
				code: "daemon_offline_maintenance_in_progress",
			});
			await expect(maintenance.release()).rejects.toMatchObject({
				code: "daemon_offline_maintenance_in_progress",
			});
			if (scenario === "replaced") expect(readJson(sentinelPath).token).toBe("replacement-sentinel");
		},
	);

	it("retains coarse and malformed relevant owners but reclaims observed PID absence", async () => {
		const paths = createPaths();
		const coarse = await acquire(paths, "coarse-owner");
		const coarsePath = join(ownerDir(paths, "coarse-owner"), "owner.json");
		const coarseRecord: OwnerRecord = {
			...readJson(coarsePath),
			processStartId: "ps:lstart:coarse-only",
		};
		delete coarseRecord.processIdentityHint;
		delete coarseRecord.authorityProcessStartId;
		delete coarseRecord.authorityProcessIdentityHint;
		writeFileSync(coarsePath, `${JSON.stringify(coarseRecord, null, 2)}\n`);
		await expect(acquire(paths, "coarse-contender")).rejects.toMatchObject({
			code: "daemon_supervisor_already_running",
		});
		await expect(coarse.release()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		rmSync(ownerDir(paths, "coarse-owner"), { recursive: true, force: true });

		const malformedDir = ownerDir(paths, "malformed-owner");
		mkdirSync(malformedDir, { recursive: true });
		writeFileSync(
			join(malformedDir, "scope.json"),
			`${JSON.stringify({
				version: 1,
				role: "supervisor",
				token: "malformed",
				generation: "malformed-owner",
				socketPath: coarse.record.socketPath,
				descriptorDir: coarse.record.descriptorDir,
			})}\n`,
		);
		writeFileSync(join(malformedDir, "owner.json"), "{not-json\n");
		await expect(acquire(paths, "malformed-contender")).rejects.toThrow(/Invalid daemon supervisor owner record/);
		rmSync(malformedDir, { recursive: true, force: true });

		await acquire(paths, "dead-owner");
		const deadPath = join(ownerDir(paths, "dead-owner"), "owner.json");
		const deadRecord: OwnerRecord = { ...readJson(deadPath), pid: 2_147_483_647 };
		delete deadRecord.processStartId;
		delete deadRecord.processIdentityHint;
		delete deadRecord.authorityProcessStartId;
		delete deadRecord.authorityProcessIdentityHint;
		writeFileSync(deadPath, `${JSON.stringify(deadRecord, null, 2)}\n`);
		const replacement = await acquire(paths, "dead-replacement");
		expect(existsSync(ownerDir(paths, "dead-owner"))).toBe(false);
		await replacement.release();
	});

	it("mirrors new owners and lets a live legacy-only owner block the union", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const legacyOnly = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "legacy-only",
			registryDir: legacyDir,
			socketPath: paths.socketPath,
			offlineMaintenanceWaitMs: 0,
		});
		await expect(
			acquireDaemonSupervisorOwnership({
				agentDir: paths.agentDir,
				appVersion: "test",
				descriptorDir: paths.descriptorDir,
				generation: "dual-contender",
				registryDir: paths.registryDir,
				legacyRegistryDir: legacyDir,
				socketPath: paths.socketPath,
				offlineMaintenanceWaitMs: 0,
			}),
		).rejects.toMatchObject({ code: "daemon_supervisor_already_running" });
		await legacyOnly.release();

		const mirrored = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "mirrored-owner",
			registryDir: paths.registryDir,
			legacyRegistryDir: legacyDir,
			socketPath: paths.socketPath,
			offlineMaintenanceWaitMs: 0,
		});
		const newCopy = readJson(join(paths.registryDir, "mirrored-owner.owner", "owner.json"));
		const oldVisibleCopy = readJson(join(legacyDir, "mirrored-owner.owner", "owner.json"));
		expect(oldVisibleCopy).toMatchObject({
			token: newCopy.token,
			pid: newCopy.pid,
			socketPath: newCopy.socketPath,
			mirrorRequired: true,
		});
		expect(oldVisibleCopy.processStartId).toBeUndefined();
		expect(oldVisibleCopy.processIdentityHint).toBeUndefined();
		expect(oldVisibleCopy.authorityProcessStartId).toBe(getProcessStartId(process.pid));
		expect(newCopy.processStartId).toBeUndefined();
		expect(newCopy.authorityProcessStartId).toBe(mirrored.record.authorityProcessStartId);
		expect(frozen849cParentProcessIdentityAlive(oldVisibleCopy as unknown as Frozen849cParentProcessIdentity)).toBe(
			true,
		);
		await mirrored.release();
	});

	it("mirrors maintenance and shutdown authority for old-registry-only readers", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const maintenance = await acquireDaemonOfflineMaintenanceLease(
			{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
			paths.registryDir,
			legacyDir,
		);
		if (!maintenance) throw new Error("dual maintenance lease was not acquired");
		const newMaintenance = readdirSync(join(paths.registryDir, "offline-maintenance")).find((name) =>
			name.endsWith(".json"),
		);
		const legacyMaintenance = readdirSync(join(legacyDir, "offline-maintenance")).find((name) =>
			name.endsWith(".json"),
		);
		expect(legacyMaintenance).toBe(newMaintenance);
		const oldVisibleMaintenance = readJson(join(legacyDir, "offline-maintenance", legacyMaintenance!));
		expect(oldVisibleMaintenance).toMatchObject({
			token: readJson(join(paths.registryDir, "offline-maintenance", newMaintenance!)).token,
			mirrorRequired: true,
		});
		expect(oldVisibleMaintenance.expiresAt).toBe("+275760-09-13T00:00:00.000Z");
		const legacyCompatibilityOwner = readdirSync(legacyDir).find((name) => name.endsWith(".owner"));
		if (!legacyCompatibilityOwner) throw new Error("legacy compatibility owner was not written");
		expect(
			readJson(join(legacyDir, legacyCompatibilityOwner, "owner.json")).offlineMaintenanceExpiresAt,
		).toBeUndefined();
		const legacySentinelPath = join(legacyDir, "shutdown-admission.json");
		const primarySentinel = readJson(join(paths.registryDir, "shutdown-admission.json"));
		const legacySentinel = readJson(legacySentinelPath);
		expect(legacySentinel).toMatchObject({
			token: oldVisibleMaintenance.token,
			pid: process.pid,
			purpose: "offline-maintenance",
			socketPath: normalizeSocketPath(paths.socketPath),
			descriptorDir: oldVisibleMaintenance.descriptorDir,
			expiresAt: "+275760-09-13T00:00:00.000Z",
			mirrorRequired: true,
		});
		expect(legacySentinel.token).toBe(primarySentinel.token);
		expect(legacySentinel.processStartId).toBeUndefined();
		expect(readFrozen849cParentActiveShutdownAdmission(legacySentinelPath)?.token).toBe(oldVisibleMaintenance.token);
		expect(existsSync(legacySentinelPath)).toBe(true);
		await expect(
			acquireDaemonSupervisorOwnership({
				agentDir: paths.agentDir,
				appVersion: "old-reader",
				descriptorDir: paths.descriptorDir,
				generation: "old-reader-contender",
				registryDir: legacyDir,
				socketPath: paths.socketPath,
				offlineMaintenanceWaitMs: 0,
			}),
		).rejects.toMatchObject({ code: "daemon_offline_maintenance_in_progress" });
		await maintenance.release();

		const shutdown = await acquireDaemonShutdownAdmission(paths.registryDir, legacyDir);
		const newShutdown = readJson(join(paths.registryDir, "shutdown-admission.json"));
		const oldVisibleShutdown = readJson(join(legacyDir, "shutdown-admission.json"));
		expect(oldVisibleShutdown).toMatchObject({
			token: newShutdown.token,
			pid: newShutdown.pid,
			mirrorRequired: true,
		});
		expect(oldVisibleShutdown.expiresAt).toBe("+275760-09-13T00:00:00.000Z");
		expect(oldVisibleShutdown.processStartId).toBeUndefined();
		expect(readFrozen849cParentActiveShutdownAdmission(join(legacyDir, "shutdown-admission.json"))?.token).toBe(
			oldVisibleShutdown.token,
		);
		await expect(
			acquireDaemonOfflineMaintenanceLease(
				{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
				legacyDir,
			),
		).resolves.toBeUndefined();
		await shutdown.release();
		expect(existsSync(join(paths.registryDir, "shutdown-admission.json"))).toBe(false);
		expect(existsSync(join(legacyDir, "shutdown-admission.json"))).toBe(false);
	});

	it("keeps the frozen exact-parent shutdown predicate live through the JS Date maximum", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const maintenance = await acquireDaemonOfflineMaintenanceLease(
			{ socketPath: paths.socketPath, descriptorDir: paths.descriptorDir },
			paths.registryDir,
			legacyDir,
		);
		if (!maintenance) throw new Error("dual maintenance lease was not acquired");
		const sentinelPath = join(legacyDir, "shutdown-admission.json");
		const sentinel = readJson(sentinelPath);
		const dateMaximum = Date.parse("+275760-09-13T00:00:00.000Z");
		const beyondYear9999 = 253_402_300_800_000;
		expect(dateMaximum).toBe(8_640_000_000_000_000);
		expect(beyondYear9999).toBeGreaterThan(Date.parse("9999-12-31T23:59:59.999Z"));
		expect(beyondYear9999).toBeLessThan(dateMaximum);
		expect(sentinel.expiresAt).toBe("+275760-09-13T00:00:00.000Z");

		const now = vi.spyOn(Date, "now").mockReturnValue(beyondYear9999);
		try {
			expect(readFrozen849cParentActiveShutdownAdmission(sentinelPath)?.token).toBe(sentinel.token);
			expect(existsSync(sentinelPath)).toBe(true);
		} finally {
			now.mockRestore();
		}
		await maintenance.release();
	});

	it("keeps a partial mirrored owner blocking and never reports release success", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const mirrored = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "partial-owner",
			registryDir: paths.registryDir,
			legacyRegistryDir: legacyDir,
			socketPath: paths.socketPath,
			offlineMaintenanceWaitMs: 0,
		});
		rmSync(join(paths.registryDir, "partial-owner.owner"), { recursive: true, force: true });
		await expect(
			acquireDaemonSupervisorOwnership({
				agentDir: paths.agentDir,
				appVersion: "test",
				descriptorDir: paths.descriptorDir,
				generation: "partial-contender",
				registryDir: paths.registryDir,
				legacyRegistryDir: legacyDir,
				socketPath: paths.socketPath,
				offlineMaintenanceWaitMs: 0,
			}),
		).rejects.toMatchObject({ code: "daemon_supervisor_already_running" });
		await expect(mirrored.release()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
	});

	it("orders dual guards canonically", async () => {
		const paths = createPaths();
		const left = join(paths.root, "guard-z");
		const right = join(paths.root, "guard-a");
		const visits: string[] = [];
		await Promise.all([
			withRegistryGuards([left, right], () => visits.push("forward")),
			withRegistryGuards([right, left], () => visits.push("reverse")),
		]);
		expect(visits.sort()).toEqual(["forward", "reverse"]);
	});

	it("checks the canonical guard file, token inode, and full record before mutation", async () => {
		const paths = createPaths();
		const registryDir = join(paths.root, "guard-replacement");
		const canonical = join(registryDir, ".guard");
		const marker = join(paths.root, "must-not-commit");

		await expect(
			withRegistryGuards([registryDir], (guard): void => {
				const originalOwner = readJson(canonical);
				writeFileSync(canonical, `${JSON.stringify({ ...originalOwner, createdAt: "replacement" })}\n`);
				guard.assertCurrent();
				writeFileSync(marker, "committed");
			}),
		).rejects.toMatchObject({ code: "authority_guard_compromised" });
		expect(existsSync(marker)).toBe(false);
		rmSync(canonical, { force: true });

		const pausedOwner = `${canonical}.paused-owner`;
		await expect(
			withRegistryGuards([registryDir], (guard): void => {
				renameSync(canonical, pausedOwner);
				cpSync(pausedOwner, canonical);
				guard.assertCurrent();
				writeFileSync(marker, "committed");
			}),
		).rejects.toMatchObject({ code: "authority_guard_compromised" });
		expect(readJson(canonical)).toMatchObject({ pid: process.pid, type: "authority-mutation-guard" });
		expect(existsSync(marker)).toBe(false);
		rmSync(canonical, { force: true });
		rmSync(pausedOwner, { force: true });
	});

	it("keeps old and new contenders out after injected 5s and 30s staleness", async () => {
		const paths = createPaths();
		const registryDir = join(paths.root, "injected-stale-guard");
		const fixture = join(paths.root, "registry-stale-contender.mts");
		const helperUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/authority-mutation-guard.ts")).href;
		const identityUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/session-lease.ts")).href;
		const properLockUrl = pathToFileURL(
			resolve(import.meta.dirname, "../../../node_modules/proper-lockfile/index.js"),
		).href;
		writeFileSync(
			fixture,
			`import { writeFileSync } from "node:fs";
import lockfile from ${JSON.stringify(properLockUrl)};
import { acquireAuthorityMutationGuard } from ${JSON.stringify(helperUrl)};
import { classifyProcessIdentityAuthority, observeProcessIdentity } from ${JSON.stringify(identityUrl)};
const [mode, registryDir, result] = process.argv.slice(2);
try {
  if (mode === "old") {
    const release = await lockfile.lock(registryDir, {
      realpath: false,
      lockfilePath: registryDir + "/.guard",
      stale: 5_000,
      retries: 0,
    });
    writeFileSync(result, "entered");
    await release();
  } else {
    const observed = observeProcessIdentity(process.pid);
    if (observed.status !== "present-exact" && observed.status !== "present-coarse") throw new Error("identity");
    const held = acquireAuthorityMutationGuard({
      authorityPath: registryDir,
      lockfilePath: registryDir + "/.guard",
      attempts: 1,
      retryMs: 1,
      identity: observed.status === "present-exact" ? { processStartId: observed.id } : { processIdentityHint: observed.hint },
      classifyOwner: (owner) => classifyProcessIdentityAuthority(owner.pid, owner.processStartId) === "exact-dead" ? "exact-dead" : "retained",
      failureMessage: "blocked",
    });
    writeFileSync(result, "entered");
    held.release();
  }
} catch (error) {
  writeFileSync(result, "blocked:" + String(error && typeof error === "object" && "code" in error ? error.code : "error"));
}
`,
		);
		const tsxPath = resolve(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs");
		const oldResult = join(paths.root, "old-result");
		const newResult = join(paths.root, "new-result");
		let exits: Promise<unknown>[] = [];
		await withRegistryGuards([registryDir], (guard) => {
			const guardFile = join(registryDir, ".guard");
			const owner = readJson(guardFile);
			expect(owner).toMatchObject({ pid: process.pid, type: "authority-mutation-guard" });
			// Cross both stale thresholds without waiting for wall time. The
			// canonical regular file is non-empty from its first public inode, so an
			// old directory-lock writer cannot remove it with rmdir.
			utimesSync(guardFile, new Date(0), new Date(0));
			const old = spawn(process.execPath, [tsxPath, fixture, "old", registryDir, oldResult], { stdio: "ignore" });
			const current = spawn(process.execPath, [tsxPath, fixture, "new", registryDir, newResult], {
				stdio: "ignore",
			});
			exits = [once(old, "exit"), once(current, "exit")];
			const deadline = Date.now() + 10_000;
			while ((!existsSync(oldResult) || !existsSync(newResult)) && Date.now() < deadline) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
			expect(readFileSync(oldResult, "utf8")).toMatch(/^blocked:/);
			expect(readFileSync(newResult, "utf8")).toMatch(/^blocked:/);
			guard.assertCurrent();
		});
		await Promise.all(exits);
	});

	it("lets one of two exact-dead reclaimers publish a successor that the other cannot remove", async () => {
		const paths = createPaths();
		const registryDir = join(paths.root, "crashed-guard-race");
		const crashedEntered = join(paths.root, "crashed-entered");
		const crashFixture = join(paths.root, "crashed-registry-guard.mts");
		const contenderFixture = join(paths.root, "registry-guard-reclaimer.mts");
		const sourceUrl = pathToFileURL(
			resolve(import.meta.dirname, "../src/modes/daemon/daemon-supervisor-ownership.ts"),
		).href;
		writeFileSync(
			crashFixture,
			`import { writeFileSync } from "node:fs";
import { withRegistryGuards } from ${JSON.stringify(sourceUrl)};
const [registryDir, entered] = process.argv.slice(2);
await withRegistryGuards([registryDir], () => {
  writeFileSync(entered, "entered");
  process.exit(0);
});
`,
		);
		writeFileSync(
			contenderFixture,
			`import { existsSync, writeFileSync } from "node:fs";
import { withRegistryGuards } from ${JSON.stringify(sourceUrl)};
const [registryDir, started, winner, release] = process.argv.slice(2);
writeFileSync(started, "started");
try {
  await withRegistryGuards([registryDir], (guard) => {
    writeFileSync(winner, String(process.pid), { flag: "wx" });
    while (!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    guard.assertCurrent();
  });
} catch {}
`,
		);
		const tsxArgs = ["--import", "tsx"] as const;
		const crashed = spawn(process.execPath, [...tsxArgs, crashFixture, registryDir, crashedEntered], {
			stdio: "ignore",
		});
		await once(crashed, "exit");
		expect(existsSync(crashedEntered)).toBe(true);
		const abandoned = readJson(join(registryDir, ".guard"));

		const winnerPath = join(paths.root, "winner");
		const releasePath = join(paths.root, "release-winner");
		const firstStarted = join(paths.root, "first-started");
		const secondStarted = join(paths.root, "second-started");
		const first = spawn(
			process.execPath,
			[...tsxArgs, contenderFixture, registryDir, firstStarted, winnerPath, releasePath],
			{ stdio: "ignore" },
		);
		const second = spawn(
			process.execPath,
			[...tsxArgs, contenderFixture, registryDir, secondStarted, winnerPath, releasePath],
			{ stdio: "ignore" },
		);
		const firstExit = once(first, "exit");
		const secondExit = once(second, "exit");
		const deadline = Date.now() + 10_000;
		while (
			(!existsSync(firstStarted) || !existsSync(secondStarted) || !existsSync(winnerPath)) &&
			Date.now() < deadline
		) {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
		expect(existsSync(winnerPath)).toBe(true);
		const winnerPid = Number(readFileSync(winnerPath, "utf8"));
		const winner = first.pid === winnerPid ? first : second;
		const loser = winner === first ? second : first;
		const winnerExit = winner === first ? firstExit : secondExit;
		const loserExit = loser === first ? firstExit : secondExit;
		const canonicalGuard = join(registryDir, ".guard");
		utimesSync(canonicalGuard, new Date(0), new Date(0));
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
		const successor = readJson(canonicalGuard);
		expect(successor.pid).toBe(winnerPid);
		expect(successor.token).not.toBe(abandoned.token);

		loser.kill("SIGKILL");
		await loserExit;
		writeFileSync(releasePath, "release");
		await winnerExit;
		expect(existsSync(canonicalGuard)).toBe(false);
	});
});
