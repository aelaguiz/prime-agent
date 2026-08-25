import { setTimeout as delay } from "node:timers/promises";
import { ensureInteractiveDaemonRunning } from "../../cli/daemon-launch.js";
import { DaemonCapabilityUnavailableError, DaemonClient, type DaemonHello } from "../daemon/daemon-client.js";
import { type DaemonErrorInfo, isDaemonMutatingCommand } from "../daemon/daemon-protocol.js";
import { defaultDaemonSocketPath } from "../daemon/daemon-socket.js";

export type DaemonCommandBody = Parameters<DaemonClient["request"]>[0];

export const DAEMON_GET_TIMEOUT_MS = 10_000;
export const DAEMON_COMMAND_TIMEOUT_MS = 15_000;
export const DAEMON_CREATE_TIMEOUT_MS = 30_000;
/** A catalog scan of every saved session takes as long as the shipped CLI allows for it. */
export const DAEMON_CATALOG_TIMEOUT_MS = 30_000;

const RECOVERY_CONNECT_WAIT_MS = 2_000;
const RECOVERY_POLL_INTERVAL_MS = 50;

/** A daemon that answered with `success: false`; carries the daemon's own wording verbatim. */
export class DaemonCommandError extends Error {
	constructor(
		readonly command: string,
		readonly daemonMessage: string,
		readonly errorInfo?: DaemonErrorInfo,
	) {
		const code = errorInfo ? ` (${errorInfo.code})` : "";
		super(`${command} failed${code}: ${daemonMessage}`);
		this.name = "DaemonCommandError";
	}
}

export interface DaemonBridgeOptions {
	daemonSocket?: string;
}

/**
 * Single daemon connection shared by every MCP tool handler. Read getters and
 * control commands only: the bridge never attaches, never sends client env, and
 * never advertises UI capabilities, so it cannot take dialog ownership away from
 * an interactive client.
 */
export class DaemonBridge {
	readonly socketPath: string;
	private readonly client: DaemonClient;
	private started = false;
	private recovering?: Promise<void>;

	constructor(options: DaemonBridgeOptions = {}) {
		this.socketPath = options.daemonSocket ?? defaultDaemonSocketPath();
		this.client = new DaemonClient(this.socketPath);
	}

	get hello(): DaemonHello | undefined {
		return this.client.hello;
	}

	async start(): Promise<void> {
		if (this.started) {
			return;
		}
		this.armAutoReconnect();
		await ensureInteractiveDaemonRunning(this.socketPath);
		await this.client.connect();
		await this.client.waitForHello();
		this.started = true;
	}

	/**
	 * A read-only command is retried once after recovering the connection. A
	 * mutating command is never retried: a client-side timeout does not cancel it
	 * (the daemon works on a session command for up to 24 hours), and a retry gets
	 * a fresh wire id, so the daemon's idempotency journal would not match it and
	 * the session would receive the command twice.
	 */
	async command<T>(body: DaemonCommandBody, timeoutMs = DAEMON_COMMAND_TIMEOUT_MS): Promise<T> {
		try {
			return await this.send<T>(body, timeoutMs);
		} catch (error) {
			if (error instanceof DaemonCommandError || error instanceof DaemonCapabilityUnavailableError) {
				throw error;
			}
			// Recover for every command type, so a client that only sends mutations still
			// heals the connection (and re-arms auto-reconnect), then decline the re-send.
			await this.recover(error);
			if (isDaemonMutatingCommand(body)) {
				throw error;
			}
			return await this.send<T>(body, timeoutMs);
		}
	}

	close(): void {
		this.client.close();
		this.started = false;
	}

	private async send<T>(body: DaemonCommandBody, timeoutMs: number): Promise<T> {
		const response = await this.client.request(body, timeoutMs);
		if (!response.success) {
			throw new DaemonCommandError(response.command, response.error, response.errorInfo);
		}
		return response.data as T;
	}

	/** One bounded recovery attempt, shared by every caller that hits the same outage. */
	private recover(cause: unknown): Promise<void> {
		const recovering =
			this.recovering ??
			this.runRecovery(cause).finally(() => {
				this.recovering = undefined;
			});
		this.recovering = recovering;
		return recovering;
	}

	private async runRecovery(cause: unknown): Promise<void> {
		try {
			await ensureInteractiveDaemonRunning(this.socketPath);
			// The client runs its own reconnect loop after a socket loss. Let it finish
			// first: two concurrent connects race, and the loser destroys the socket the
			// winner just established.
			await this.waitForConnection();
			if (!this.client.isConnected) {
				await this.client.reconnect();
			}
			await this.client.waitForHello();
			// The client drops its reconnect options for good once a reconnect window
			// expires, so re-arm after every recovery or a later outage never recovers.
			this.armAutoReconnect();
		} catch (error) {
			const causeMessage = cause instanceof Error ? cause.message : String(cause);
			const recoveryMessage = error instanceof Error ? error.message : String(error);
			throw new Error(
				`The Prime Agent daemon is unreachable (${causeMessage}). Recovery failed: ${recoveryMessage}`,
			);
		}
	}

	private async waitForConnection(): Promise<void> {
		const deadline = Date.now() + RECOVERY_CONNECT_WAIT_MS;
		while (!this.client.isConnected && Date.now() < deadline) {
			await delay(RECOVERY_POLL_INTERVAL_MS);
		}
	}

	private armAutoReconnect(): void {
		this.client.enableAutoReconnect({ recoverDaemon: () => ensureInteractiveDaemonRunning(this.socketPath) });
	}
}
