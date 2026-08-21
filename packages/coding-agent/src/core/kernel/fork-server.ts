// Node-side client for the Python kernel forkserver (see fork-server-script.ts).
// One forkserver process per (python, cwd, env) profile, spawned lazily and kept
// alive for the agent process. Each KernelManager asks it to fork a kernel onto a
// connection file instead of paying a full `python -m ipykernel_launcher` cold boot.
//
// Everything degrades to direct spawn: if the forkserver is disabled, unavailable,
// or a spawn request fails/times out, callers catch ForkServerUnavailable and fall
// back to the existing path, so correctness never depends on fork.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import {
	createObservedProcessInstanceId,
	recordProcessLifecycle,
	withoutProcessLifecycleEnvironment,
} from "../process-lifecycle.js";
import { FORK_SERVER_SCRIPT } from "./fork-server-script.js";

const READY_TIMEOUT_MS = 30_000;
const SPAWN_TIMEOUT_MS = 10_000;
const STDERR_TAIL_MAX_BYTES = 32 * 1024;

// Vars the Python interpreter consumes at startup (before any user code runs), so
// they can't be honored post-fork via os.environ.update — the forked child inherits
// the template's already-initialized sys.path / site config. A kernel overriding any
// of these to a value the template didn't launch with must take the direct-spawn
// path. We treat the entire PYTHON* family as startup-affecting rather than
// enumerating individual vars: the set is large and version-dependent, and a false
// positive merely (safely) routes a kernel to direct spawn. Plus the non-PYTHON*
// startup vars that also steer interpreter/site resolution.
const INTERPRETER_STARTUP_ENV_EXACT = ["VIRTUAL_ENV", "CONDA_PREFIX", "__PYVENV_LAUNCHER__"];

function affectsInterpreterStartup(key: string): boolean {
	return key.startsWith("PYTHON") || INTERPRETER_STARTUP_ENV_EXACT.includes(key);
}

function boundedUtf8Tail(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value);
	if (bytes.length <= maxBytes) return value;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
	return bytes.subarray(start).toString("utf8");
}

function lifecycleError(error: unknown): { name: string; message: string; code?: string | number } {
	if (!(error instanceof Error)) return { name: typeof error, message: String(error) };
	const code = (error as NodeJS.ErrnoException).code;
	const message = error.message.split("\nforkserver stderr:\n", 1)[0];
	return { name: error.name, message, ...(code !== undefined ? { code } : {}) };
}

export class ForkServerUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ForkServerUnavailable";
	}
}

// On by default on Linux (fork-without-exec is unsafe on macOS);
// PRIME_AGENT_KERNEL_FORKSERVER=0 opts out.
export function isForkServerEnabled(): boolean {
	if (process.platform !== "linux") return false;
	return process.env.PRIME_AGENT_KERNEL_FORKSERVER !== "0";
}

// A forkserver template is defined solely by the interpreter — the imported
// module graph doesn't depend on cwd/env. Those are per-kernel and applied in the
// forked child, so every kernel for a given python shares ONE template.
interface ForkServerParams {
	python: string;
}

interface SpawnParams {
	connectionPath: string;
	exitPath?: string;
	cwd?: string;
	// Mirrors process.env shape; undefined values are dropped when JSON-serialized
	// to the child, matching how spawn() treats them on the direct path.
	env?: Record<string, string | undefined>;
}

type PendingSpawn = {
	resolve: (pid: number) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

class ForkServer {
	private readonly params: ForkServerParams;
	private readonly forkServerInstanceId = randomUUID();
	private readonly previousForkServerInstanceId?: string;
	private childProcessInstanceId?: string;
	private pid?: number;
	private startedAt?: number;
	private disposeRequested = false;
	// The env the template process was launched with, snapshotted at construction so
	// it exactly matches what the template's interpreter imported with. The
	// startup-env guard compares against THIS, not live process.env, so a later
	// mutation of process.env can't make a stale template look compatible.
	private readonly launchEnv: NodeJS.ProcessEnv;
	private proc?: ChildProcess;
	private server?: Server;
	private conn?: Socket;
	private socketDir?: string;
	private readyPromise?: Promise<void>;
	private failReady?: (err: Error) => void;
	private buffer = "";
	// Rolling tail of forkserver stderr. Forked children inherit this fd, so a
	// child's import/startup traceback lands here; surfaced in error messages.
	private stderrTail = "";
	private nextId = 1;
	private readonly pending = new Map<number, PendingSpawn>();
	// Request ids whose caller timed out; a late pid reply for one is an orphan to kill.
	private readonly abandoned = new Set<number>();
	private dead = false;

	constructor(params: ForkServerParams, previousForkServerInstanceId?: string) {
		this.params = params;
		this.previousForkServerInstanceId = previousForkServerInstanceId;
		// Snapshot now and launch the template with this same object, so the guard's
		// comparison uses exactly the env the interpreter imported with.
		this.launchEnv = withoutProcessLifecycleEnvironment(process.env);
	}

	get isDead(): boolean {
		return this.dead;
	}

	get instanceId(): string {
		return this.forkServerInstanceId;
	}

	private lifecycleDetails(details: Record<string, unknown> = {}, includeStderrTail = false): Record<string, unknown> {
		const stderrTail = includeStderrTail ? boundedUtf8Tail(this.stderrTail, STDERR_TAIL_MAX_BYTES) : "";
		return {
			forkServerInstanceId: this.forkServerInstanceId,
			...(this.childProcessInstanceId ? { childProcessInstanceId: this.childProcessInstanceId } : {}),
			...(this.pid !== undefined ? { pid: this.pid } : {}),
			...details,
			...(stderrTail ? { stderrTail, stderrTailScope: "shared-fork-server" } : {}),
		};
	}

	private recordError(error: unknown, source: string): void {
		recordProcessLifecycle("fork_server_error", this.lifecycleDetails({ source, error: lifecycleError(error) }));
	}

	/**
	 * True if `env` overrides an interpreter-startup var to a value the template
	 * didn't launch with — such a kernel can't be forked (sys.path is baked in at
	 * import), so the caller must direct-spawn it.
	 */
	needsStartupEnvNotInTemplate(env: SpawnParams["env"]): boolean {
		if (!env) return false;
		return Object.keys(env).some((k) => affectsInterpreterStartup(k) && env[k] !== this.launchEnv[k]);
	}

	private async ensureReady(): Promise<void> {
		if (this.dead) throw new ForkServerUnavailable("forkserver is dead");
		if (!this.readyPromise) {
			this.readyPromise = this.start().catch((err) => {
				this.recordError(err, "start");
				if (this.previousForkServerInstanceId) {
					recordProcessLifecycle("fork_server_restart", {
						phase: "failed",
						previousForkServerInstanceId: this.previousForkServerInstanceId,
						forkServerInstanceId: this.forkServerInstanceId,
						error: lifecycleError(err),
					});
				}
				this.markDead("start-failed");
				throw err instanceof ForkServerUnavailable ? err : new ForkServerUnavailable(String(err));
			});
		}
		return this.readyPromise;
	}

	private start(): Promise<void> {
		this.startedAt = Date.now();
		this.childProcessInstanceId = createObservedProcessInstanceId();
		recordProcessLifecycle(
			"fork_server_start",
			this.lifecycleDetails({
				phase: "attempt",
				trigger: this.previousForkServerInstanceId ? "fork-server-restart" : "fork-server-start",
				previousForkServerInstanceId: this.previousForkServerInstanceId,
				childLifecycleSelfLogged: false,
			}),
		);
		this.socketDir = mkdtempSync(join(tmpdir(), "prime-agent-forkserver-"));
		const socketPath = join(this.socketDir, "control.sock");

		return new Promise<void>((resolve, reject) => {
			const server = createServer();
			this.server = server;

			let settled = false;
			const readyTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new ForkServerUnavailable(`forkserver did not become ready within ${READY_TIMEOUT_MS}ms`));
			}, READY_TIMEOUT_MS);

			// Lets markDead() fail a still-pending start (interpreter crashed / socket
			// closed before "ready") instead of waiting out the full ready timeout.
			this.failReady = (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(readyTimer);
				reject(err instanceof ForkServerUnavailable ? err : new ForkServerUnavailable(String(err)));
			};

			server.on("connection", (socket) => {
				this.conn = socket;
				socket.setEncoding("utf8");
				socket.on("data", (chunk: string) => this.onData(chunk));
				socket.on("close", () => this.markDead("control-socket-close"));
				socket.on("error", (error) => {
					if (!this.disposeRequested) this.recordError(error, "control-socket");
					this.markDead("control-socket-error");
				});
			});

			server.on("error", (err) => {
				if (settled) return;
				this.recordError(err, "control-server");
				settled = true;
				clearTimeout(readyTimer);
				reject(new ForkServerUnavailable(`forkserver control socket failed: ${err.message}`));
			});

			// Buffered until the "ready" line; flip the promise from there.
			this.onReady = () => {
				if (settled) return;
				settled = true;
				clearTimeout(readyTimer);
				recordProcessLifecycle(
					"fork_server_ready",
					this.lifecycleDetails({ durationMs: Date.now() - (this.startedAt ?? Date.now()) }),
				);
				if (this.previousForkServerInstanceId) {
					recordProcessLifecycle("fork_server_restart", {
						phase: "completed",
						previousForkServerInstanceId: this.previousForkServerInstanceId,
						forkServerInstanceId: this.forkServerInstanceId,
					});
				}
				resolve();
			};

			server.listen(socketPath, () => {
				// The template only imports; its own cwd/env are irrelevant since each
				// forked child applies the per-kernel cwd/env itself. Inherit the daemon's.
				const proc = spawn(this.params.python, ["-c", FORK_SERVER_SCRIPT, socketPath], {
					env: this.launchEnv,
					stdio: ["ignore", "ignore", "pipe"],
				});
				this.proc = proc;
				this.pid = proc.pid;
				proc.once("spawn", () => {
					recordProcessLifecycle(
						"fork_server_start",
						this.lifecycleDetails({
							phase: "spawned",
							trigger: this.previousForkServerInstanceId ? "fork-server-restart" : "fork-server-start",
							previousForkServerInstanceId: this.previousForkServerInstanceId,
							childLifecycleSelfLogged: false,
						}),
					);
				});
				proc.stderr?.on("data", (buf: Buffer) => {
					this.stderrTail = boundedUtf8Tail(`${this.stderrTail}${buf.toString()}`, STDERR_TAIL_MAX_BYTES);
				});
				proc.on("error", (error) => {
					if (!this.disposeRequested) this.recordError(error, "process");
					this.markDead("process-error");
				});
				proc.on("exit", (code, signal) => {
					const expected = this.disposeRequested;
					recordProcessLifecycle("fork_server_exit", this.lifecycleDetails({ expected, code, signal }, !expected));
					if (!expected) this.markDead("process-exit");
				});
			});
		});
	}

	private onReady: () => void = () => {};

	private onData(chunk: string): void {
		this.buffer += chunk;
		for (let idx = this.buffer.indexOf("\n"); idx !== -1; idx = this.buffer.indexOf("\n")) {
			const line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (!line.trim()) continue;
			let msg: { type?: string; id?: number; pid?: number; error?: string };
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.type === "ready") {
				this.onReady();
				continue;
			}
			if (typeof msg.id !== "number") continue;
			const p = this.pending.get(msg.id);
			if (!p) {
				// A pid for a request the caller already abandoned (timed out): the
				// fork succeeded but nobody owns it, so kill the orphan here.
				if (this.abandoned.delete(msg.id) && typeof msg.pid === "number") {
					try {
						process.kill(msg.pid, "SIGTERM");
					} catch {
						// Orphan already exited.
					}
				}
				continue;
			}
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (typeof msg.pid === "number") {
				p.resolve(msg.pid);
			} else {
				p.reject(new ForkServerUnavailable(this.withStderr(msg.error ?? "forkserver fork failed")));
			}
		}
	}

	async spawnKernel(spawn: SpawnParams): Promise<number> {
		await this.ensureReady();
		if (this.dead || !this.conn) throw new ForkServerUnavailable("forkserver connection unavailable");
		const id = this.nextId++;
		return new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				// The fork may still land after we give up; remember the id so its late
				// pid reply gets the orphan killed instead of leaked.
				this.abandoned.add(id);
				reject(new ForkServerUnavailable(`forkserver spawn timed out after ${SPAWN_TIMEOUT_MS}ms`));
			}, SPAWN_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.conn?.write(
				`${JSON.stringify({
					id,
					connectionPath: spawn.connectionPath,
					exitPath: spawn.exitPath,
					cwd: spawn.cwd,
					env: spawn.env,
				})}\n`,
			);
		});
	}

	private withStderr(message: string): string {
		const tail = this.stderrTail.trim();
		return tail ? `${message}\nforkserver stderr:\n${tail}` : message;
	}

	/** Reject any in-flight ensureReady/spawnKernel callers so none wait out a timeout. */
	private rejectPending(reason: string): void {
		this.failReady?.(new ForkServerUnavailable(reason));
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new ForkServerUnavailable(reason));
		}
		this.pending.clear();
	}

	private markDead(source: string): void {
		if (this.dead) return;
		recordProcessLifecycle("fork_server_death", this.lifecycleDetails({ expected: false, source }, true));
		this.dispose(this.withStderr("forkserver died"), false);
	}

	dispose(reason = "forkserver disposed", expected = true): void {
		if (this.dead) return;
		if (expected) this.disposeRequested = true;
		recordProcessLifecycle(
			"fork_server_dispose",
			this.lifecycleDetails({ expected, trigger: expected ? "requested" : "death-cleanup" }),
		);
		// Flip `dead` at entry so the close/exit events our own teardown triggers
		// don't re-enter. Pending callers are rejected directly here (not deferred to
		// those events), so this early flag flip can't strand them on a timeout.
		this.dead = true;
		this.rejectPending(reason);
		// Best-effort teardown: each resource may already be gone.
		try {
			this.conn?.destroy();
		} catch {
			// Already destroyed.
		}
		try {
			this.server?.close();
		} catch {
			// Already closed.
		}
		try {
			this.proc?.kill("SIGTERM");
		} catch {
			// Already exited.
		}
		if (this.socketDir) {
			try {
				rmSync(this.socketDir, { recursive: true, force: true });
			} catch {
				// Leave the socket dir for OS tmp cleanup.
			}
			this.socketDir = undefined;
		}
	}
}

// Keyed by interpreter only: cwd/env are per-kernel (applied in the child), so all
// kernels for a given python share ONE warm template.
const servers = new Map<string, ForkServer>();
let cleanupRegistered = false;

function keyFor(params: ForkServerParams): string {
	return params.python;
}

function registerForkServerCleanupOnce(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	// A forkserver is process-lived and shared across sessions, so per-session
	// cleanup must not yank the warm template from other live sessions — only a full
	// process shutdown (no sessionId) disposes it here.
	registerSessionResourceCleanup((sessionId) => {
		if (!sessionId) disposeAllForkServers();
	});
	// cleanupSessionResources(undefined) is never called on exit, so also tear the
	// forkserver down directly on process teardown or it leaks as an orphan.
	process.once("exit", disposeAllForkServers);
	for (const signal of ["SIGINT", "SIGTERM", "beforeExit"] as const) {
		process.once(signal, () => disposeAllForkServers());
	}
}

/**
 * Fork a kernel onto `spawn.connectionPath` from the shared template for this
 * interpreter, applying `spawn.cwd`/`spawn.env` in the forked child. Throws
 * ForkServerUnavailable if forking is disabled or fails — callers fall back to
 * direct spawn. Returns the forked child's pid (owned/killed by the caller).
 */
export async function forkKernel(python: string, spawn: SpawnParams): Promise<number> {
	if (!isForkServerEnabled()) throw new ForkServerUnavailable("forkserver disabled");
	registerForkServerCleanupOnce();
	const key = keyFor({ python });
	let server = servers.get(key);
	if (!server || server.isDead) {
		const previousForkServerInstanceId = server?.instanceId;
		server = new ForkServer({ python }, previousForkServerInstanceId);
		servers.set(key, server);
		if (previousForkServerInstanceId) {
			recordProcessLifecycle("fork_server_restart", {
				phase: "attempt",
				previousForkServerInstanceId,
				forkServerInstanceId: server.instanceId,
			});
		}
	}
	// Compare against the template's own launch env (not live process.env): a kernel
	// overriding an interpreter-startup var to a value the template didn't import
	// with can't be forked — defer to direct spawn rather than boot with wrong sys.path.
	if (server.needsStartupEnvNotInTemplate(spawn.env)) {
		throw new ForkServerUnavailable("kernel overrides interpreter-startup env; using direct spawn");
	}
	try {
		return await server.spawnKernel(spawn);
	} catch (err) {
		// Keep a dead instance in the map until the next caller replaces it so the
		// replacement can record previous/new fork-server lineage.
		throw err instanceof ForkServerUnavailable ? err : new ForkServerUnavailable(String(err));
	}
}

export function disposeAllForkServers(): void {
	for (const server of servers.values()) server.dispose();
	servers.clear();
}
