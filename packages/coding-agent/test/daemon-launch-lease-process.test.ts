import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonLaunchLeaseDirectory, tryAcquireDaemonLaunchLease } from "../src/modes/daemon/daemon-launch-lease.js";

const tsxPath = resolve(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs");
const fixturePath = resolve(import.meta.dirname, "fixtures/daemon-launch-lease-contender.ts");
const children: ChildProcess[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function waitForMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
	return new Promise((resolveMessage, rejectMessage) => {
		const onMessage = (message: unknown): void => {
			if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== type) return;
			cleanup();
			resolveMessage(message as Record<string, unknown>);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			cleanup();
			rejectMessage(new Error(`lease contender exited before ${type} (code=${code}, signal=${signal})`));
		};
		const cleanup = (): void => {
			child.off("message", onMessage);
			child.off("exit", onExit);
		};
		child.on("message", onMessage);
		child.on("exit", onExit);
	});
}

describe("daemon launch lease process election", () => {
	it("elects exactly one leader across simultaneous frontend processes", async () => {
		const directory = mkdtempSync(join(import.meta.dirname, ".launch-lease-process-"));
		temporaryDirectories.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const barrierPath = join(directory, "start");
		const releasePath = join(directory, "release");
		const contenders = Array.from({ length: 8 }, () => {
			const child = spawn(process.execPath, [tsxPath, fixturePath, socketPath, barrierPath, releasePath], {
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			children.push(child);
			return child;
		});
		const exits = contenders.map((child) => once(child, "exit"));
		await Promise.all(contenders.map((child) => waitForMessage(child, "ready")));
		const acquired = contenders.map((child) => waitForMessage(child, "acquired"));
		writeFileSync(barrierPath, "start\n");
		const results = await Promise.all(acquired);
		expect(results.filter((result) => result.leader === true)).toHaveLength(1);
		writeFileSync(releasePath, "release\n");
		await Promise.all(exits);
		expect(contenders.every((child) => child.exitCode === 0)).toBe(true);
	});
});

describe("daemon launch lease rolling identity records", () => {
	function fixture(record: Record<string, unknown>): { directory: string; socketPath: string } {
		const root = mkdtempSync(join(import.meta.dirname, ".launch-lease-record-"));
		temporaryDirectories.push(root);
		const socketPath = join(root, "daemon.sock");
		const directory = daemonLaunchLeaseDirectory(socketPath);
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, "lease.json"),
			`${JSON.stringify({ version: 1, token: "old", ownerPid: 2_000_000_000, socketPath, ...record })}
`,
		);
		return { directory, socketPath };
	}

	it.each([
		[
			"authority-only qualified Linux",
			{ ownerAuthorityProcessStartId: "proc:00000000-0000-4000-8000-000000000000:11" },
		],
		["authority-only token", { ownerAuthorityProcessStartId: `token:${"1".repeat(64)}` }],
		["Windows byte-identical dual", { ownerProcessStartId: "win:11", ownerAuthorityProcessStartId: "win:11" }],
		[
			"consistent historical Linux dual",
			{
				ownerProcessStartId: "proc:11",
				ownerAuthorityProcessStartId: "proc:00000000-0000-4000-8000-000000000000:11",
			},
		],
	])("reclaims exact-dead %s authority", (_name, identity) => {
		const { socketPath } = fixture(identity);
		const lease = tryAcquireDaemonLaunchLease(socketPath);
		expect(lease).toBeDefined();
		lease?.release();
	});

	it.each([
		["qualified Linux", "proc:00000000-0000-4000-8000-000000000000:11"],
		["token", `token:${"2".repeat(64)}`],
		["Windows", "win:11"],
	])("uses historical exact old-field %s only for liveness", (_name, processStartId) => {
		const { socketPath } = fixture({ ownerProcessStartId: processStartId });
		const lease = tryAcquireDaemonLaunchLease(socketPath);
		expect(lease).toBeDefined();
		lease?.release();
	});

	it.each([
		["noncanonical hint", { ownerProcessIdentityHint: "arbitrary" }],
		["multiline hint", { ownerProcessIdentityHint: "ps:lstart:a\nb" }],
		["oversize hint", { ownerProcessIdentityHint: `ps:lstart:${"x".repeat(1_025)}` }],
		[
			"conflicting start and hint",
			{ ownerProcessStartId: "proc:11", ownerProcessIdentityHint: "ps:lstart:canonical" },
		],
	])("retains present-invalid %s lease byte-for-byte", (_name, identity) => {
		const { directory, socketPath } = fixture(identity);
		const path = join(directory, "lease.json");
		const before = { bytes: readFileSync(path), stat: statSync(path, { bigint: true }) };
		expect(tryAcquireDaemonLaunchLease(socketPath)).toBeUndefined();
		expect(readFileSync(path)).toEqual(before.bytes);
		const after = statSync(path, { bigint: true });
		expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.stat.dev, ino: before.stat.ino });
	});

	it.each([
		[
			"Linux",
			{
				ownerProcessStartId: "proc:12",
				ownerAuthorityProcessStartId: "proc:00000000-0000-4000-8000-000000000000:11",
			},
		],
		["Windows", { ownerProcessStartId: "win:12", ownerAuthorityProcessStartId: "win:11" }],
	])("retains conflicting %s dual authority byte-for-byte", (_name, identity) => {
		const { directory, socketPath } = fixture(identity);
		const path = join(directory, "lease.json");
		const before = { bytes: readFileSync(path), stat: statSync(path, { bigint: true }) };
		expect(tryAcquireDaemonLaunchLease(socketPath)).toBeUndefined();
		expect(readFileSync(path)).toEqual(before.bytes);
		const after = statSync(path, { bigint: true });
		expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.stat.dev, ino: before.stat.ino });
	});

	it("retains a live bare legacy identity but reclaims it only after PID absence", () => {
		const live = fixture({ ownerPid: process.pid, ownerProcessStartId: "proc:11" });
		const livePath = join(live.directory, "lease.json");
		const liveBytes = readFileSync(livePath);
		expect(tryAcquireDaemonLaunchLease(live.socketPath)).toBeUndefined();
		expect(readFileSync(livePath)).toEqual(liveBytes);

		const dead = fixture({ ownerProcessStartId: "proc:11" });
		const lease = tryAcquireDaemonLaunchLease(dead.socketPath);
		expect(lease).toBeDefined();
		lease?.release();
	});

	it.runIf(process.platform === "darwin")(
		"bridges a live pre-normalization lexical lease and releases both authorities",
		() => {
			const root = mkdtempSync(join(tmpdir(), "prime-launch-lease-alias-"));
			temporaryDirectories.push(root);
			const socketPath = join(root, "daemon.sock");
			const lexicalKey = createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
			const lexicalDirectory = join(dirname(socketPath), `.supervisor-launch-${lexicalKey}.lock`);
			const canonicalDirectory = daemonLaunchLeaseDirectory(socketPath);
			expect(lexicalDirectory).not.toBe(canonicalDirectory);
			mkdirSync(lexicalDirectory, { recursive: true });
			const liveRecord = {
				version: 1,
				token: "legacy-live",
				ownerPid: process.pid,
				ownerProcessStartId: "proc:11",
				socketPath,
			};
			const lexicalPath = join(lexicalDirectory, "lease.json");
			writeFileSync(
				lexicalPath,
				`${JSON.stringify(liveRecord)}
`,
			);
			const before = { bytes: readFileSync(lexicalPath), stat: statSync(lexicalPath, { bigint: true }) };
			expect(tryAcquireDaemonLaunchLease(socketPath)).toBeUndefined();
			expect(readFileSync(lexicalPath)).toEqual(before.bytes);
			const retained = statSync(lexicalPath, { bigint: true });
			expect({ dev: retained.dev, ino: retained.ino }).toEqual({ dev: before.stat.dev, ino: before.stat.ino });

			rmSync(lexicalDirectory, { recursive: true, force: true });
			mkdirSync(lexicalDirectory, { recursive: true });
			writeFileSync(
				lexicalPath,
				`${JSON.stringify({ ...liveRecord, token: "legacy-dead", ownerPid: 2_000_000_000 })}
`,
			);
			const lease = tryAcquireDaemonLaunchLease(socketPath);
			expect(lease).toBeDefined();
			expect(readFileSync(join(lexicalDirectory, "lease.json"), "utf8")).toBe(
				readFileSync(join(canonicalDirectory, "lease.json"), "utf8"),
			);
			lease?.release();
			expect(() => statSync(lexicalDirectory)).toThrow();
			expect(() => statSync(canonicalDirectory)).toThrow();
		},
	);
});
