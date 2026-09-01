import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	ATTACHMENT_DISPLAY_MIME,
	DIFF_DISPLAY_MIME,
	type HostRequestHandlers,
	ReplKernelManager,
} from "../src/core/kernel/index.js";
import {
	clearOrphanProcessJournal,
	initializeOrphanProcessJournal,
	ORPHAN_PROCESS_JOURNAL_ENV,
	ORPHAN_PROCESS_JOURNAL_GENERATION_ENV,
	reapOrphanProcessAuthority,
} from "../src/core/orphan-process-journal.js";
import { installTestOrphanProcessJournal } from "./orphan-process-journal-test-helper.js";

function clearInheritedProcessTestEnvironment(): void {
	for (const name of Object.keys(process.env)) {
		if (name.startsWith("RLM_") || name.startsWith("PRIME_AGENT_INTERNAL_")) delete process.env[name];
	}
}

clearInheritedProcessTestEnvironment();

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveReplPython();
const describeIf = python ? describe : describe.skip;

describeIf("ReplKernelManager execute (real runtime)", () => {
	let dir = "";
	let manager: ReplKernelManager | undefined;
	let restoreJournal = () => {};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-execute-"));
		restoreJournal = installTestOrphanProcessJournal(dir);
	});

	afterEach(async () => {
		await manager?.shutdown({ snapshot: true, drainHostRequests: true });
		manager = undefined;
		restoreJournal();
		restoreJournal = () => {};
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = "";
		}
	});

	it("streams stdout/stderr, returns results, and persists state across cells", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const chunks: { name: string; text: string }[] = [];
		const first = await manager.execute("import sys\nx = 21\nprint('to-out')\nsys.stderr.write('to-err\\n')", {
			onStream: (chunk, name) => chunks.push({ name, text: chunk }),
		});
		expect(first.status).toBe("ok");
		expect(first.stdout).toContain("to-out");
		expect(first.stderr).toContain("to-err");
		expect(chunks.some((c) => c.name === "stdout" && c.text.includes("to-out"))).toBe(true);

		const second = await manager.execute("x * 2");
		expect(second.status).toBe("ok");
		expect(second.result).toBe("42");
	}, 30_000);

	it("reports cell errors with a clean traceback", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const r = await manager.execute("def boom():\n    raise ValueError('nope')\nboom()");
		expect(r.status).toBe("error");
		expect(r.error?.ename).toBe("ValueError");
		expect(r.error?.evalue).toBe("nope");
		expect(r.error?.traceback.join("")).toContain("raise ValueError('nope')");
	}, 30_000);

	it("parses emitted display payloads into diffs, attachments, and sent messages", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const code = [
			"from rlm import emit",
			`emit({${JSON.stringify(DIFF_DISPLAY_MIME)}: {"path": "/tmp/f.py", "old_str": "a", "new_str": "b", "start_line": 3}})`,
			`emit({${JSON.stringify(ATTACHMENT_DISPLAY_MIME)}: {"mime_type": "image/png", "data": "aGVsbG8=", "path": "/tmp/i.png"}})`,
			`emit({${JSON.stringify(AGENT_MESSAGE_DISPLAY_MIME)}: {"id": "m1", "message": "hi", "deliveryStatus": "delivered", "receiverRole": "parent", "target": {"activeSessionId": "a", "sessionId": "s"}}})`,
		].join("\n");
		const r = await manager.execute(code);
		expect(r.status).toBe("ok");
		expect(r.diffs).toEqual([{ path: "/tmp/f.py", oldStr: "a", newStr: "b", startLine: 3 }]);
		expect(r.attachments).toEqual([{ mimeType: "image/png", data: "aGVsbG8=", path: "/tmp/i.png" }]);
		expect(r.sentAgentMessages).toEqual([
			{
				id: "m1",
				message: "hi",
				deliveryStatus: "delivered",
				receiverRole: "parent",
				target: { activeSessionId: "a", sessionId: "s" },
			},
		]);
	}, 30_000);

	it("round-trips host requests through hostHandlers, including error replies", async () => {
		const hostHandlers: HostRequestHandlers = {
			"test.echo": async (payload) => ({ echoed: payload.value, cell: payload.cellSourceCode }),
			"test.fail": async () => {
				throw new Error("handler exploded");
			},
		};
		manager = new ReplKernelManager({ python: python as string, cwd: dir, hostHandlers });

		const ok = await manager.execute(
			"import rlm\nreply = await rlm.host_request('test.echo', {'value': 7})\nreply['echoed']",
		);
		expect(ok.status).toBe("ok");
		expect(ok.result).toBe("7");

		const cellSource = await manager.execute("reply['cell']");
		expect(cellSource.status).toBe("ok");
		expect(cellSource.result).toContain("test.echo");

		const failed = await manager.execute("import rlm\nawait rlm.host_request('test.fail')");
		expect(failed.status).toBe("error");
		expect(failed.error?.ename).toBe("RuntimeError");
		expect(failed.error?.evalue).toBe("handler exploded");

		const unknown = await manager.execute("import rlm\nawait rlm.host_request('test.unknown')");
		expect(unknown.status).toBe("error");
		expect(unknown.error?.evalue).toContain('host request type "test.unknown" is not available');
	}, 30_000);

	it("dispose sends the protocol shutdown so live bash children die with the kernel", async () => {
		const journalPath = join(dir, "orphans.jsonl");
		const authority = initializeOrphanProcessJournal(journalPath);
		const previousPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		const previousGeneration = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
		try {
			manager = new ReplKernelManager({ python: python as string, cwd: dir });
			const r = await manager.execute("from rlm import bash\nh = bash('sleep 600')\nh.pid");
			expect(r.status).toBe("ok");
			const pid = Number(r.result);
			expect(Number.isInteger(pid)).toBe(true);
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			let alive = true;
			for (let i = 0; i < 100; i++) {
				try {
					process.kill(pid, 0);
				} catch {
					alive = false;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(alive).toBe(false);
			const records = readFileSync(journalPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { generation: string; sequence: number });
			expect(records.map((record) => record.sequence)).toEqual(records.map((_, index) => index));
			expect(records.every((record) => record.generation === authority.generation)).toBe(true);
			await expect(
				reapOrphanProcessAuthority(journalPath, { expectedGeneration: authority.generation }),
			).resolves.toBe(true);
			expect(clearOrphanProcessJournal(journalPath, authority.generation)).toBe(true);
		} finally {
			if (previousPath === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = previousPath;
			if (previousGeneration === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = previousGeneration;
		}
	}, 30_000);

	it("kill uses the admission-stored target pid to reap detached bash descendants", async () => {
		const journalPath = join(dir, "kill-orphans.jsonl");
		const authority = initializeOrphanProcessJournal(journalPath);
		const previousPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		const previousGeneration = process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = authority.generation;
		try {
			manager = new ReplKernelManager({ python: python as string, cwd: dir });
			const result = await manager.execute("from rlm import bash\nh = bash('sleep 600')\nh.pid");
			expect(result.status).toBe("ok");
			const pid = Number(result.result);
			expect(Number.isInteger(pid)).toBe(true);
			await manager.kill();
			await vi.waitFor(
				() => {
					expect(() => process.kill(pid, 0)).toThrow();
				},
				{ timeout: 5000, interval: 50 },
			);
			await expect(
				reapOrphanProcessAuthority(journalPath, { expectedGeneration: authority.generation }),
			).resolves.toBe(true);
			expect(clearOrphanProcessJournal(journalPath, authority.generation)).toBe(true);
		} finally {
			if (previousPath === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = previousPath;
			if (previousGeneration === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_GENERATION_ENV] = previousGeneration;
		}
	}, 30_000);

	it("surfaces unattributed background output separately from cell stdout", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const first = await manager.execute(
			[
				"import threading, time",
				"def late():",
				"    time.sleep(0.5)",
				"    print('SECRET-thread', flush=True)",
				"threading.Thread(target=late, daemon=True).start()",
			].join("\n"),
		);
		expect(first.status).toBe("ok");

		const second = await manager.execute("import time\ntime.sleep(1.0)\nprint('own-output')");
		expect(second.status).toBe("ok");
		expect(second.stdout).toContain("own-output");
		expect(second.stdout).not.toContain("SECRET-thread");
		expect(second.backgroundOutput ?? "").toContain("SECRET-thread");
	}, 30_000);
});
