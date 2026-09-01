import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lockSync } from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireSessionLease,
	canonicalSessionPath,
	classifyProcessIdentityAuthority,
	createProcessIdentityOwnerToken,
	getLegacyProcessStartId,
	getProcessStartId,
	getWindowsProcessStartId,
	isExactProcessStartId,
	isProcessIdentityCurrent,
	matchesExactProcessIdentity,
	normalizePortableProcessIdentityHint,
	observeProcessIdentity,
	type ProcessIdentityObservationOptions,
	projectLegacyProcessStartId,
	readLinuxProcessIdentityFile,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
	SessionAlreadyActiveError,
	SessionLease,
	SessionLeaseOwnershipLostError,
} from "../src/core/session-lease.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-session-lease-test-"));
	tempDirs.push(directory);
	return directory;
}

function enabledEnvironment(owner: string): NodeJS.ProcessEnv {
	return {
		[SESSION_LEASES_ENABLED_ENV]: "1",
		[SESSION_LEASE_OWNER_ID_ENV]: owner,
	};
}

function preMoveLeaseOwnerAlive(owner: { pid: number; processStartId?: string }): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	if (!owner.processStartId) return true;
	const observed = getLegacyProcessStartId(owner.pid);
	return observed === undefined || observed === owner.processStartId;
}

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

function linuxStat(pid: number, startTime: string): string {
	const fields = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), startTime];
	return `${pid} (worker with ) delimiter) ${fields.join(" ")}\n`;
}

const LINUX_BOOT_A = "11111111-2222-3333-4444-555555555555";
const LINUX_BOOT_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function linuxExactId(startTime: string, bootId = LINUX_BOOT_A): string {
	return `proc:${bootId}:${startTime}`;
}

function linuxExactOptions(startTime: string, bootId = LINUX_BOOT_A): ProcessIdentityObservationOptions {
	return {
		platform: "linux",
		processKill: presentProcess,
		readProcStat: () => linuxStat(42, startTime),
		readProcBootId: () => `${bootId}
`,
	};
}

const presentProcess: NonNullable<ProcessIdentityObservationOptions["processKill"]> = () => {};
type ProcessQuery = NonNullable<ProcessIdentityObservationOptions["query"]>;
type ProcessQueryCall = {
	command: string;
	args: string[];
	options: Parameters<ProcessQuery>[2];
};

describe("process identity observations", () => {
	it("validates only canonical byte-bounded portable identity hints", () => {
		const canonical = "ps:lstart:Mon Sep 1 03:00:00 2026";
		expect(normalizePortableProcessIdentityHint(canonical)).toBe(canonical);
		expect(normalizePortableProcessIdentityHint(`ps:lstart:${"a".repeat(1_024)}`)).toHaveLength(
			"ps:lstart:".length + 1_024,
		);
		for (const invalid of [
			"ps:Mon Sep 1 03:00:00 2026",
			"ps:lstart: Mon Sep 1 03:00:00 2026",
			"ps:lstart:Mon  Sep 1 03:00:00 2026",
			"ps:lstart:Mon\tSep 1 03:00:00 2026",
			"ps:lstart:Mon\nSep 1 03:00:00 2026",
			"ps:lstart:Mon\rSep 1 03:00:00 2026",
			"ps:lstart:Mon\0Sep 1 03:00:00 2026",
			"ps:lstart:Mon\u0007Sep 1 03:00:00 2026",
			"ps:lstart:Mon\u0085Sep 1 03:00:00 2026",
			"ps:lstart:\ud800",
			"ps:lstart:é",
			"ps:lstart:\ufffd",
			`ps:lstart:${"é".repeat(513)}`,
			`ps:lstart:${"a".repeat(1_025)}`,
		]) {
			expect(normalizePortableProcessIdentityHint(invalid)).toBeUndefined();
		}
	});

	it("creates a lowercase 256-bit owner capability and its exact argv marker", () => {
		const ownerToken = createProcessIdentityOwnerToken();
		expect(ownerToken.argument).toMatch(/^prime-agent-owner-token=[0-9a-f]{64}$/);
		expect(ownerToken.processStartId).toBe(`token:${ownerToken.argument.slice("prime-agent-owner-token=".length)}`);
	});

	it("uses an absolute bounded scrubbed PowerShell query for exact Windows identity", () => {
		const calls: ProcessQueryCall[] = [];
		const observation = observeProcessIdentity(42, {
			platform: "win32",
			processKill: presentProcess,
			windowsSystemRoot: "C:\\Windows",
			query: (command, args, options) => {
				calls.push({ command, args, options });
				return "638880485801234567\r\n";
			},
		});

		expect(observation).toEqual({ status: "present-exact", id: "win:638880485801234567" });
		expect(calls).toEqual([
			{
				command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
				args: [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"([System.Diagnostics.Process]::GetProcessById(42)).StartTime.ToUniversalTime().Ticks",
				],
				options: {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 2_000,
					maxBuffer: 16 * 1024,
					killSignal: "SIGKILL",
					shell: false,
					cwd: "C:\\",
					env: {
						SystemRoot: "C:\\Windows",
						WINDIR: "C:\\Windows",
						NoDefaultCurrentDirectoryInExePath: "1",
					},
					windowsHide: true,
				},
			},
		]);
	});

	it("rejects non-ASCII, empty, whitespace-only, and overlong Windows ticks", () => {
		for (const output of ["１２３", "1".repeat(33), "", " \t\r\n"]) {
			expect(
				observeProcessIdentity(42, {
					platform: "win32",
					processKill: presentProcess,
					windowsSystemRoot: "C:Windows",
					query: () => output,
				}),
			).toEqual({ status: "present-unknown" });
		}
	});

	it("does not inherit authority, PATH, runtime, or secret environment into PowerShell", () => {
		let queryEnvironment: NodeJS.ProcessEnv | undefined;
		const observation = observeProcessIdentity(42, {
			platform: "win32",
			processKill: presentProcess,
			windowsSystemRoot: "C:\\Windows",
			query: (_command, _args, options) => {
				queryEnvironment = options.env;
				return "638880485801234567";
			},
		});

		expect(observation).toEqual({ status: "present-exact", id: "win:638880485801234567" });
		expect(queryEnvironment).toEqual({
			SystemRoot: "C:\\Windows",
			WINDIR: "C:\\Windows",
			NoDefaultCurrentDirectoryInExePath: "1",
		});
		expect(
			Object.keys(queryEnvironment ?? {}).some(
				(key) =>
					key === "PATH" ||
					key.startsWith("PRIME_AGENT_INTERNAL_") ||
					key.startsWith("RLM_") ||
					key.startsWith("NODE_") ||
					key.startsWith("PYTHON") ||
					key.includes("SECRET"),
			),
		).toBe(false);
	});

	it("ignores hostile ambient Windows roots when selecting PowerShell", () => {
		const previousSystemRoot = process.env.SystemRoot;
		const previousWindir = process.env.WINDIR;
		let call: ProcessQueryCall | undefined;
		process.env.SystemRoot = "D:\\hostile-system-root";
		process.env.WINDIR = "E:\\hostile-windir";
		try {
			expect(
				observeProcessIdentity(42, {
					platform: "win32",
					processKill: presentProcess,
					query: (command, args, options) => {
						call = { command, args, options };
						return "638880485801234567";
					},
				}),
			).toEqual({ status: "present-exact", id: "win:638880485801234567" });
		} finally {
			if (previousSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = previousSystemRoot;
			if (previousWindir === undefined) delete process.env.WINDIR;
			else process.env.WINDIR = previousWindir;
		}

		expect(call).toMatchObject({
			command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			options: {
				cwd: "C:\\",
				env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
			},
		});
	});

	it("classifies Windows death, parse failure, permission failure, and timeout", () => {
		let deadQueryCount = 0;
		expect(
			observeProcessIdentity(42, {
				platform: "win32",
				processKill: () => {
					throw errno("ESRCH");
				},
				query: () => {
					deadQueryCount++;
					return "1";
				},
			}),
		).toEqual({ status: "absent" });
		expect(deadQueryCount).toBe(0);

		const windowsObservation = (query: ProcessQuery) =>
			observeProcessIdentity(42, {
				platform: "win32",
				processKill: presentProcess,
				windowsSystemRoot: "C:\\Windows",
				query,
			});
		expect(windowsObservation(() => "not-digits")).toEqual({ status: "present-unknown" });
		expect(
			windowsObservation(() => {
				throw errno("EACCES");
			}),
		).toEqual({ status: "present-unknown" });
		expect(
			windowsObservation(() => {
				throw errno("ETIMEDOUT");
			}),
		).toEqual({ status: "probe-uncertain" });
	});

	it("qualifies Linux proc stat field 22 with the validated lowercase boot UUID", () => {
		let statPath: string | undefined;
		let bootPath: string | undefined;
		let maxBytes: number | undefined;
		const readOrder: string[] = [];
		const observation = observeProcessIdentity(42, {
			platform: "linux",
			processKill: presentProcess,
			readProcStat: (path, maximum) => {
				readOrder.push("stat");
				statPath = path;
				maxBytes = maximum;
				return linuxStat(42, "987654321");
			},
			readProcBootId: (path) => {
				readOrder.push("boot");
				bootPath = path;
				return `${LINUX_BOOT_A}
`;
			},
		});

		expect(observation).toEqual({ status: "present-exact", id: linuxExactId("987654321") });
		expect(statPath).toBe("/proc/42/stat");
		expect(bootPath).toBe("/proc/sys/kernel/random/boot_id");
		expect(maxBytes).toBe(16 * 1024);
		expect(readOrder).toEqual(["boot", "stat"]);
	});

	it("distinguishes Linux absence, unreadability, malformed stat, and probe failure", () => {
		const linuxObservation = (readProcStat: NonNullable<ProcessIdentityObservationOptions["readProcStat"]>) =>
			observeProcessIdentity(42, {
				platform: "linux",
				processKill: presentProcess,
				readProcStat,
				readProcBootId: () => LINUX_BOOT_A,
			});
		expect(
			linuxObservation(() => {
				throw errno("ENOENT");
			}),
		).toEqual({ status: "present-unknown" });
		let presenceChecks = 0;
		expect(
			observeProcessIdentity(42, {
				platform: "linux",
				processKill: () => {
					presenceChecks++;
					if (presenceChecks > 1) throw errno("ESRCH");
				},
				readProcBootId: () => LINUX_BOOT_A,
				readProcStat: () => {
					throw errno("ENOENT");
				},
			}),
		).toEqual({ status: "absent" });
		expect(
			linuxObservation(() => {
				throw errno("EACCES");
			}),
		).toEqual({ status: "present-unknown" });
		expect(linuxObservation(() => "42 malformed")).toEqual({ status: "present-unknown" });
		expect(
			observeProcessIdentity(42, {
				platform: "linux",
				processKill: presentProcess,
				readProcStat: () => linuxStat(42, "123"),
				readProcBootId: () => {
					throw errno("EIO");
				},
			}),
		).toEqual({ status: "present-unknown" });
		expect(
			observeProcessIdentity(42, {
				platform: "linux",
				processKill: presentProcess,
				readProcStat: () => linuxStat(42, "123"),
				readProcBootId: () => LINUX_BOOT_B.toUpperCase(),
			}),
		).toEqual({ status: "present-unknown" });
		expect(
			linuxObservation(() => {
				throw errno("EIO");
			}),
		).toEqual({ status: "present-unknown" });
		let uncertainChecks = 0;
		expect(
			observeProcessIdentity(42, {
				platform: "linux",
				processKill: () => {
					uncertainChecks++;
					if (uncertainChecks > 1) throw errno("EIO");
				},
				readProcBootId: () => LINUX_BOOT_A,
				readProcStat: () => {
					throw errno("EIO");
				},
			}),
		).toEqual({ status: "probe-uncertain" });
		expect(
			observeProcessIdentity(42, {
				platform: "linux",
				processKill: () => {
					throw errno("EPERM");
				},
				readProcStat: () => linuxStat(42, "123"),
				readProcBootId: () => LINUX_BOOT_A,
			}),
		).toEqual({ status: "present-exact", id: linuxExactId("123") });

		let readCount = 0;
		expect(
			observeProcessIdentity(42, {
				platform: "linux",
				processKill: () => {
					throw errno("EINVAL");
				},
				readProcStat: () => {
					readCount++;
					return linuxStat(42, "1");
				},
			}),
		).toEqual({ status: "probe-uncertain" });
		expect(readCount).toBe(0);
	});

	it("rejects non-canonical Linux identity bytes and symlink reads", () => {
		const observe = (stat: string | Buffer, boot: string | Buffer = `${LINUX_BOOT_B}\n`) =>
			observeProcessIdentity(42, {
				platform: "linux",
				processKill: presentProcess,
				readProcBootId: () => boot,
				readProcStat: () => stat,
			});
		const validStat = linuxStat(42, "987");
		expect(observe(validStat)).toEqual({ status: "present-exact", id: linuxExactId("987", LINUX_BOOT_B) });
		for (const invalidBoot of [
			` ${LINUX_BOOT_B}`,
			`${LINUX_BOOT_B} `,
			`${LINUX_BOOT_B}\t`,
			`${LINUX_BOOT_B}\r\n`,
			`${LINUX_BOOT_B}\n\n`,
			LINUX_BOOT_B.toUpperCase(),
			Buffer.from([0xff]),
			Buffer.alloc(16 * 1024 + 1, 0x61),
		]) {
			expect(observe(validStat, invalidBoot)).toEqual({ status: "present-unknown" });
		}
		const simpleStat = validStat.replace("worker with ) delimiter", "worker");
		const lastDelimiter = simpleStat.lastIndexOf(") ");
		for (const invalidStat of [
			validStat.replace(/^42 /, "43 "),
			`${simpleStat.slice(0, lastDelimiter)})X${simpleStat.slice(lastDelimiter + 2)}`,
			validStat.replace("987", " 987"),
			validStat.replace("987", "９８７"),
			validStat.replace("987", "00123"),
			validStat.replace("987", "18446744073709551616"),
			validStat.replace(" S ", "\tS "),
			Buffer.from([0xff]),
			Buffer.alloc(16 * 1024 + 1, 0x61),
		]) {
			expect(observe(invalidStat)).toEqual({ status: "present-unknown" });
		}
		const opaqueComm = Buffer.concat([
			Buffer.from("42 (worker-", "ascii"),
			Buffer.from([0xff]),
			Buffer.from(simpleStat.slice(simpleStat.lastIndexOf(") ")), "ascii"),
		]);
		expect(observe(opaqueComm)).toEqual({ status: "present-exact", id: linuxExactId("987", LINUX_BOOT_B) });

		const suffix = validStat.slice(validStat.lastIndexOf(") "));
		const exactLimitStat = `42 (${"a".repeat(16 * 1024 - Buffer.byteLength("42 (") - Buffer.byteLength(suffix))}${suffix}`;
		expect(Buffer.byteLength(exactLimitStat)).toBe(16 * 1024);
		expect(observe(exactLimitStat)).toEqual({ status: "present-exact", id: linuxExactId("987", LINUX_BOOT_B) });

		const directory = createTempDir();
		const regular = join(directory, "identity");
		const link = join(directory, "identity-link");
		writeFileSync(regular, LINUX_BOOT_B);
		symlinkSync(regular, link);
		expect(readLinuxProcessIdentityFile(regular, 16 * 1024).toString("ascii")).toBe(LINUX_BOOT_B);
		expect(() => readLinuxProcessIdentityFile(link, 16 * 1024)).toThrow();
		writeFileSync(regular, Buffer.alloc(16 * 1024, 0x61));
		expect(readLinuxProcessIdentityFile(regular, 16 * 1024)).toHaveLength(16 * 1024);
		writeFileSync(regular, Buffer.alloc(16 * 1024 + 1, 0x61));
		expect(() => readLinuxProcessIdentityFile(regular, 16 * 1024)).toThrow();
	});

	it("observes one delimiter-bounded Darwin owner marker as exact", () => {
		const token = "a".repeat(64);
		const calls: ProcessQueryCall[] = [];
		const observation = observeProcessIdentity(42, {
			platform: "darwin",
			processKill: presentProcess,
			pathExists: (path) => path === "/bin/ps",
			query: (command, args, options) => {
				calls.push({ command, args, options });
				return `/usr/bin/node gate.js prime-agent-owner-token=${token}\n`;
			},
		});

		expect(observation).toEqual({ status: "present-exact", id: `token:${token}` });
		expect(calls).toEqual([
			{
				command: "/bin/ps",
				args: ["-ww", "-o", "command=", "-p", "42"],
				options: {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 2_000,
					maxBuffer: 16 * 1024,
					killSignal: "SIGKILL",
					shell: false,
					cwd: "/",
					env: { LC_ALL: "C" },
					windowsHide: true,
				},
			},
		]);
	});

	it("rejects Darwin marker spoof shapes, malformed tokens, and multiple markers", () => {
		const token = "a".repeat(64);
		const otherToken = "b".repeat(64);
		const commands = [
			`node --prime-agent-owner-token=${token}`,
			`node prime-agent-owner-token=${token.slice(0, 63)}`,
			`node prime-agent-owner-token=${token.toUpperCase()}`,
			`node prime-agent-owner-token=${token}x`,
			`node prime-agent-owner-token=${token} prime-agent-owner-token=${otherToken}`,
		];

		for (const command of commands) {
			expect(
				observeProcessIdentity(42, {
					platform: "darwin",
					processKill: presentProcess,
					pathExists: (path) => path === "/bin/ps",
					query: () => command,
				}),
			).toEqual({ status: "present-unknown" });
		}
	});

	it("keeps truncated or oversized Darwin marker output uncertain", () => {
		const partialMarker = `node prime-agent-owner-token=${"a".repeat(40)}`;
		const darwinObservation = (command: string) =>
			observeProcessIdentity(42, {
				platform: "darwin",
				processKill: presentProcess,
				pathExists: (path) => path === "/bin/ps",
				query: () => command,
			});

		expect(darwinObservation(partialMarker)).toEqual({ status: "present-unknown" });
		expect(darwinObservation("x".repeat(16 * 1024 + 1))).toEqual({ status: "probe-uncertain" });
	});

	it("does not query Darwin process metadata after definite death", () => {
		let queryCount = 0;
		expect(
			observeProcessIdentity(42, {
				platform: "darwin",
				processKill: () => {
					throw errno("ESRCH");
				},
				query: () => {
					queryCount += 1;
					return "spoof";
				},
			}),
		).toEqual({ status: "absent" });
		expect(queryCount).toBe(0);
	});

	it("freshly exact-matches Darwin capabilities while retaining uncertain owners", () => {
		const token = "a".repeat(64);
		let command = `node prime-agent-owner-token=${token}`;
		const options: ProcessIdentityObservationOptions = {
			platform: "darwin",
			processKill: presentProcess,
			pathExists: (path) => path === "/bin/ps",
			query: (_command, args) => (args.includes("command=") ? command : "Mon Sep  1 03:00:00 2026"),
		};
		const expected = `token:${token}`;

		expect(matchesExactProcessIdentity(42, expected, options)).toBe(true);
		command = `node prime-agent-owner-token=${"b".repeat(64)}`;
		expect(matchesExactProcessIdentity(42, expected, options)).toBe(false);
		expect(isProcessIdentityCurrent(42, expected, options)).toBe(false);
		command = "node gate.js";
		expect(matchesExactProcessIdentity(42, expected, options)).toBe(false);
		expect(isProcessIdentityCurrent(42, expected, options)).toBe(true);
		command = `node prime-agent-owner-token=${token.slice(0, 40)}`;
		expect(matchesExactProcessIdentity(42, expected, options)).toBe(false);
		expect(isProcessIdentityCurrent(42, expected, options)).toBe(true);

		const timeoutOptions: ProcessIdentityObservationOptions = {
			...options,
			query: () => {
				throw errno("ETIMEDOUT");
			},
		};
		expect(matchesExactProcessIdentity(42, expected, timeoutOptions)).toBe(false);
		expect(isProcessIdentityCurrent(42, expected, timeoutOptions)).toBe(true);
	});

	it("treats ps lstart as a coarse hint and never as an exact mismatch", () => {
		const calls: ProcessQueryCall[] = [];
		const options: ProcessIdentityObservationOptions = {
			platform: "darwin",
			processKill: presentProcess,
			pathExists: (path) => path === "/usr/bin/ps",
			query: (command, args, queryOptions) => {
				calls.push({ command, args, options: queryOptions });
				return args.includes("command=") ? "/usr/bin/node gate.js\n" : "Mon Sep  1 03:00:00 2026\n";
			},
		};

		expect(observeProcessIdentity(42, options)).toEqual({
			status: "present-coarse",
			hint: "ps:lstart:Mon Sep 1 03:00:00 2026",
		});
		expect(isProcessIdentityCurrent(42, "ps:Sun Aug 31 03:00:00 2026", options)).toBe(true);
		expect(isProcessIdentityCurrent(42, "proc:123", options)).toBe(true);
		expect(calls[0]).toMatchObject({
			command: "/usr/bin/ps",
			args: ["-ww", "-o", "command=", "-p", "42"],
			options: {
				timeout: 2_000,
				maxBuffer: 16 * 1024,
				shell: false,
				cwd: "/",
				env: { LC_ALL: "C" },
			},
		});
		expect(calls[1]?.args).toEqual(["-p", "42", "-o", "lstart="]);
	});

	it("rejects multiline, NUL, CRLF, and byte-oversize lstart hints", () => {
		for (const output of [
			"Mon Jan 1 00:00:00 2026\nother\n",
			"Mon Jan 1 00:00:00 2026\0",
			"Mon Jan 1 00:00:00 2026\r\n",
			"é".repeat(513),
			"a".repeat(1_025),
		]) {
			expect(
				observeProcessIdentity(42, {
					platform: "darwin",
					processKill: presentProcess,
					pathExists: (path) => path === "/usr/bin/ps",
					query: (_command, args) => (args.includes("command=") ? "node gate.js\n" : output),
				}),
			).toEqual({ status: "present-unknown" });
		}
	});

	it("requires a boot-qualified Linux identity and retains legacy evidence until absence", () => {
		const expected = linuxExactId("100");
		expect(isExactProcessStartId(expected)).toBe(true);
		expect(isExactProcessStartId("proc:100")).toBe(false);
		expect(isExactProcessStartId(`proc:${LINUX_BOOT_A}:0`)).toBe(true);
		expect(isExactProcessStartId(`proc:${LINUX_BOOT_A}:00123`)).toBe(false);
		expect(isExactProcessStartId(`proc:${LINUX_BOOT_A}:18446744073709551615`)).toBe(true);
		expect(isExactProcessStartId(`proc:${LINUX_BOOT_A}:18446744073709551616`)).toBe(false);
		expect(isExactProcessStartId(`proc:${LINUX_BOOT_A}:${"1".repeat(21)}`)).toBe(false);
		expect(isExactProcessStartId(`win:${"1".repeat(32)}`)).toBe(true);
		expect(isExactProcessStartId("win:000123")).toBe(false);
		expect(isExactProcessStartId(`win:${"1".repeat(33)}`)).toBe(false);
		expect(isExactProcessStartId("win:１２３")).toBe(false);
		expect(classifyProcessIdentityAuthority(42, expected, linuxExactOptions("100"))).toBe("exact-live");
		expect(classifyProcessIdentityAuthority(42, expected, linuxExactOptions("200"))).toBe("exact-dead");
		// Same PID and start ticks after a reboot is a different exact process.
		expect(classifyProcessIdentityAuthority(42, expected, linuxExactOptions("100", LINUX_BOOT_B))).toBe("exact-dead");
		expect(matchesExactProcessIdentity(42, expected, linuxExactOptions("100", LINUX_BOOT_B))).toBe(false);
		expect(matchesExactProcessIdentity(42, expected, linuxExactOptions("100"))).toBe(true);

		// An unqualified pre-migration proc identity can never match or prove a
		// positive mismatch while the PID is present.
		expect(classifyProcessIdentityAuthority(42, "proc:100", linuxExactOptions("100"))).toBe("retained");
		expect(classifyProcessIdentityAuthority(42, "proc:100", linuxExactOptions("200"))).toBe("retained");
		expect(matchesExactProcessIdentity(42, "proc:100", linuxExactOptions("100"))).toBe(false);
		expect(isProcessIdentityCurrent(42, "proc:100", linuxExactOptions("200"))).toBe(true);

		const bootReadFailure: ProcessIdentityObservationOptions = {
			platform: "linux",
			processKill: presentProcess,
			readProcStat: () => linuxStat(42, "100"),
			readProcBootId: () => {
				throw errno("EIO");
			},
		};
		expect(classifyProcessIdentityAuthority(42, expected, bootReadFailure)).toBe("retained");
		expect(matchesExactProcessIdentity(42, expected, bootReadFailure)).toBe(false);

		const absent: ProcessIdentityObservationOptions = {
			platform: "linux",
			processKill: () => {
				throw errno("ESRCH");
			},
		};
		expect(classifyProcessIdentityAuthority(42, expected, absent)).toBe("exact-dead");
		expect(classifyProcessIdentityAuthority(42, "proc:100", absent)).toBe("exact-dead");
		expect(isProcessIdentityCurrent(42, "proc:100", absent)).toBe(false);

		expect(classifyProcessIdentityAuthority(42, undefined, linuxExactOptions("200"))).toBe("retained");
		expect(classifyProcessIdentityAuthority(42, "malformed", linuxExactOptions("200"))).toBe("retained");
		expect(
			classifyProcessIdentityAuthority(42, expected, {
				platform: "freebsd",
				processKill: presentProcess,
				pathExists: (path) => path === "/bin/ps",
				query: () => "Mon Aug 31 12:34:56 2026",
			}),
		).toBe("retained");
	});

	it("never executes a helper planted on PATH", () => {
		const directory = createTempDir();
		const marker = join(directory, "poisoned-helper-ran");
		const fakePs = join(directory, "ps");
		writeFileSync(fakePs, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
		chmodSync(fakePs, 0o700);
		const previousPath = process.env.PATH;
		process.env.PATH = directory;
		try {
			observeProcessIdentity(process.pid, { platform: "darwin" });
			expect(existsSync(marker)).toBe(false);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("preserves legacy proc ticks only through the explicit old-reader bridge", () => {
		const legacy = getLegacyProcessStartId(42, {
			platform: "linux",
			readProcStat: () => linuxStat(42, "123"),
			readProcBootId: () => {
				throw errno("EIO");
			},
		});
		expect(legacy).toBe("proc:123");
		expect(isExactProcessStartId(legacy as string)).toBe(false);
	});

	it("projects exact identities into safe pre-qualification fields without probing", () => {
		expect(projectLegacyProcessStartId(`proc:${LINUX_BOOT_B}:123`)).toBe("proc:123");
		expect(projectLegacyProcessStartId("win:456")).toBe("win:456");
		expect(projectLegacyProcessStartId(`token:${"a".repeat(64)}`)).toBeUndefined();
		expect(projectLegacyProcessStartId("proc:123")).toBeUndefined();
		expect(projectLegacyProcessStartId(`proc:${LINUX_BOOT_B.toUpperCase()}:123`)).toBeUndefined();
	});

	it("reproduces the frozen 849c92114b0b4372fa272281b87cdbe8f7c9ed8d parent raw ps identity without normalizing spacing", () => {
		const calls: ProcessQueryCall[] = [];
		const legacy = getLegacyProcessStartId(42, {
			platform: "darwin",
			pathExists: (path) => path === "/bin/ps",
			query: (command, args, options) => {
				calls.push({ command, args, options });
				return "Mon Aug 31  12:34:56 2026\n";
			},
		});
		expect(legacy).toBe("ps:Mon Aug 31  12:34:56 2026");
		expect(calls[0]?.args).toEqual(["-p", "42", "-o", "lstart="]);
	});

	it("returns exact IDs only from the compatibility wrapper on the current OS", () => {
		const observation = observeProcessIdentity(process.pid);
		const processStartId = getProcessStartId(process.pid);
		if (observation.status === "present-exact") {
			expect(processStartId).toBe(observation.id);
			expect(isExactProcessStartId(processStartId as string)).toBe(true);
		} else {
			expect(processStartId).toBeUndefined();
		}
	});

	it("rejects invalid Windows process start identities", () => {
		let queryCount = 0;
		const query: ProcessQuery = () => {
			queryCount++;
			return "not-a-start-time";
		};

		expect(getWindowsProcessStartId(42, query)).toBeUndefined();
		expect(getWindowsProcessStartId(0, query)).toBeUndefined();
		expect(queryCount).toBe(1);
	});
});

describe("session leases", () => {
	it("rejects Reflect construction without the lexical acquisition brand and retains the real lease", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(join(agentDir, "reflect-forgery.jsonl"));
		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident"));
		if (!lease) throw new Error("session lease was not acquired");
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const directory = join(agentDir, "session-leases", `${key}.lock`);
		const ownerPath = join(directory, "owner.json");
		const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
		const leaseConstructor = SessionLease as unknown as new (...args: unknown[]) => SessionLease;

		expect(() =>
			Reflect.construct(leaseConstructor, [sessionPath, directory, owner, Symbol("SessionLease.authority")]),
		).toThrow(/only be created by acquisition/);
		expect(existsSync(ownerPath)).toBe(true);
		lease.release();
	});

	it("rejects prototype and forged receivers before they can release a real lease", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(join(agentDir, "receiver-forgery.jsonl"));
		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident"));
		if (!lease) throw new Error("session lease was not acquired");
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const directory = join(agentDir, "session-leases", `${key}.lock`);
		const ownerPath = join(directory, "owner.json");
		const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
		const forgedState = {
			released: false,
			lost: false,
			sessionPath,
			directory,
			expectedOwner: owner,
			matchesExpectedOwner: () => true,
			isSelfOwnedCurrent: () => true,
		};
		const prototypeForgery = Object.create(SessionLease.prototype) as SessionLease;
		Object.defineProperties(
			prototypeForgery,
			Object.fromEntries(
				Object.entries(forgedState).map(([name, value]) => [name, { configurable: true, value, writable: true }]),
			),
		);
		const release = SessionLease.prototype.release as unknown as (this: object) => void;

		expect(() => prototypeForgery.release()).toThrow(TypeError);
		expect(existsSync(ownerPath)).toBe(true);
		expect(() => release.call({ ...forgedState })).toThrow(TypeError);
		expect(existsSync(ownerPath)).toBe(true);
		lease.release();
	});

	it("ignores shadowed authorization methods and retains a replaced owner", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(join(agentDir, "shadowed-authorization.jsonl"));
		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident"));
		if (!lease) throw new Error("session lease was not acquired");
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const directory = join(agentDir, "session-leases", `${key}.lock`);
		const ownerPath = join(directory, "owner.json");
		const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
		Object.defineProperties(lease, {
			matchesExpectedOwner: { configurable: true, value: () => true },
			isSelfOwnedCurrent: { configurable: true, value: () => true },
		});
		writeFileSync(ownerPath, `${JSON.stringify({ ...owner, token: "replacement-token" })}\n`);

		expect(() => lease.release()).toThrow(SessionLeaseOwnershipLostError);
		expect(existsSync(directory)).toBe(true);
		expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toMatchObject({ token: "replacement-token" });
	});

	it("rejects a second live owner with a typed active-session error", () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		const first = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));
		const canonicalPath = canonicalSessionPath(sessionPath);
		const key = createHash("sha256").update(canonicalPath).digest("hex");
		const diskOwner = JSON.parse(
			readFileSync(join(agentDir, "session-leases", `${key}.lock`, "owner.json"), "utf8"),
		) as Record<string, unknown>;
		// Exact Linux/Windows owners also expose the byte-compatible projection;
		// token and coarse owners leave the old exact field absent.
		if (typeof diskOwner.authorityProcessStartId === "string") {
			expect(diskOwner.processStartId).toBe(projectLegacyProcessStartId(diskOwner.authorityProcessStartId));
		} else {
			expect(diskOwner.processStartId).toBeUndefined();
			expect(diskOwner.authorityProcessIdentityHint).toBeDefined();
		}
		expect(preMoveLeaseOwnerAlive(diskOwner as unknown as { pid: number; processStartId?: string })).toBe(true);

		expect(() => acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"))).toThrow(
			SessionAlreadyActiveError,
		);
		try {
			acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"));
		} catch (error) {
			expect(error).toMatchObject({
				code: "session_already_active",
				activeSessionId: "resident-a",
				sessionPath: canonicalSessionPath(sessionPath),
			});
		}

		first?.release();
		const second = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"));
		expect(second?.sessionPath).toBe(canonicalSessionPath(sessionPath));
		second?.release();
	});

	it("fails closed on dead owners with invalid or split identity authority", () => {
		const invalidIdentities: Array<Record<string, string>> = [
			{ authorityProcessStartId: "proc:10" },
			{
				processStartId: "proc:999",
				authorityProcessStartId: linuxExactId("10"),
			},
			{
				authorityProcessStartId: linuxExactId("10"),
				authorityProcessIdentityHint: "ps:lstart:coarse",
			},
			{ authorityProcessIdentityHint: "not-a-coarse-hint" },
		];
		for (const [index, identity] of invalidIdentities.entries()) {
			const agentDir = createTempDir();
			const sessionPath = canonicalSessionPath(resolve(agentDir, `split-${index}.jsonl`));
			const key = createHash("sha256").update(sessionPath).digest("hex");
			const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
			mkdirSync(lockDirectory, { recursive: true });
			writeFileSync(
				join(lockDirectory, "owner.json"),
				`${JSON.stringify({
					version: 1,
					token: `dead-${index}`,
					pid: 2_000_000_000,
					...identity,
					sessionPath,
					createdAt: new Date(0).toISOString(),
				})}\n`,
			);
			expect(() => acquireSessionLease(sessionPath, agentDir, enabledEnvironment("replacement"))).toThrow(
				SessionAlreadyActiveError,
			);
			expect(existsSync(lockDirectory)).toBe(true);
		}
	});

	it("reclaims a lease whose owner process is gone", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "stale.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(
			join(lockDirectory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "stale",
				pid: 2_147_483_647,
				activeSessionId: "dead-owner",
				sessionPath,
				createdAt: new Date(0).toISOString(),
			}),
		);

		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("reports guard contention as a coordination failure", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(join(agentDir, "session.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const leaseRoot = join(agentDir, "session-leases");
		const lockDirectory = join(leaseRoot, `${key}.lock`);
		mkdirSync(leaseRoot, { recursive: true });
		const release = lockSync(lockDirectory, {
			realpath: false,
			lockfilePath: `${lockDirectory}.guard`,
			stale: 5000,
		});

		try {
			let thrown: unknown;
			try {
				acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect(thrown).not.toBeInstanceOf(SessionAlreadyActiveError);
			expect((thrown as Error).message).toContain("Could not coordinate session lease");
		} finally {
			release();
		}
	});

	it("treats symlink aliases as the same persisted session", () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		const aliasPath = join(agentDir, "session-alias.jsonl");
		writeFileSync(sessionPath, "");
		symlinkSync(sessionPath, aliasPath);
		const first = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));

		expect(() => acquireSessionLease(aliasPath, agentDir, enabledEnvironment("owned-b"))).toThrow(
			SessionAlreadyActiveError,
		);
		first?.release();
	});

	it("does not infer pid reuse from a malformed persisted identity", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "unverified-pid.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(
			join(lockDirectory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "uncertain",
				pid: process.pid,
				processStartId: "different-process",
				activeSessionId: "old-owner",
				sessionPath,
				createdAt: new Date(0).toISOString(),
			}),
		);

		expect(() => acquireSessionLease(sessionPath, agentDir, enabledEnvironment("replacement"))).toThrow(
			SessionAlreadyActiveError,
		);
	});

	it("retains live leases with noncanonical stored exact identities without signaling", () => {
		for (const authorityProcessStartId of [`proc:${LINUX_BOOT_A}:00123`, "win:000123"]) {
			const agentDir = createTempDir();
			const sessionPath = canonicalSessionPath(resolve(agentDir, `${authorityProcessStartId.slice(0, 3)}.jsonl`));
			const key = createHash("sha256").update(sessionPath).digest("hex");
			const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
			mkdirSync(lockDirectory, { recursive: true });
			writeFileSync(
				join(lockDirectory, "owner.json"),
				JSON.stringify({
					version: 1,
					token: "noncanonical",
					pid: process.pid,
					authorityProcessStartId,
					activeSessionId: "old-owner",
					sessionPath,
					createdAt: new Date(0).toISOString(),
				}),
			);
			const signals: Array<string | number> = [];
			const signalSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: string | number) => {
				if (signal !== undefined) signals.push(signal);
				return true;
			});
			try {
				expect(() => acquireSessionLease(sessionPath, agentDir, enabledEnvironment("replacement"))).toThrow(
					SessionAlreadyActiveError,
				);
			} finally {
				signalSpy.mockRestore();
			}
			expect(signals.every((signal) => signal === 0)).toBe(true);
			expect(existsSync(lockDirectory)).toBe(true);
		}
	});

	it("retains missing or malformed authority instead of reclaiming it", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "malformed.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(join(lockDirectory, "owner.json"), "{not-json\n");

		expect(() => acquireSessionLease(sessionPath, agentDir, enabledEnvironment("replacement"))).toThrow(
			SessionAlreadyActiveError,
		);
		expect(existsSync(lockDirectory)).toBe(true);
	});

	it("marks a token-replaced release lost without unlinking the replacement", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "replaced.jsonl"));
		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident"));
		if (!lease) throw new Error("session lease was not acquired");
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const ownerPath = join(agentDir, "session-leases", `${key}.lock`, "owner.json");
		const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
		writeFileSync(ownerPath, `${JSON.stringify({ ...owner, token: "replacement-token" })}\n`);

		expect(() => lease.release()).toThrow(SessionLeaseOwnershipLostError);
		expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toMatchObject({ token: "replacement-token" });
	});

	it("requires the full captured owner even when the disk token is unchanged", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "same-token-replaced.jsonl"));
		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident"));
		if (!lease) throw new Error("session lease was not acquired");
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const ownerPath = join(agentDir, "session-leases", `${key}.lock`, "owner.json");
		const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
		const replacement = { ...owner, createdAt: new Date(0).toISOString() };
		writeFileSync(ownerPath, `${JSON.stringify(replacement)}\n`);

		expect(() => lease.release()).toThrow(SessionLeaseOwnershipLostError);
		expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toMatchObject({
			token: owner.token,
			createdAt: new Date(0).toISOString(),
		});
	});

	it("is inert for direct SDK runtimes unless worker isolation enables it", () => {
		const agentDir = createTempDir();
		expect(acquireSessionLease(join(agentDir, "session.jsonl"), agentDir, {})).toBeUndefined();
	});
});
