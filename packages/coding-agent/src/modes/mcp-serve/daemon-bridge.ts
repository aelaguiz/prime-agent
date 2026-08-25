import { ensureInteractiveDaemonRunning } from "../../cli/daemon-launch.js";
import { DaemonClient, type DaemonHello } from "../daemon/daemon-client.js";
import type { DaemonErrorInfo } from "../daemon/daemon-protocol.js";
import { defaultDaemonSocketPath } from "../daemon/daemon-socket.js";

export type DaemonCommandBody = Parameters<DaemonClient["request"]>[0];

export const DAEMON_GET_TIMEOUT_MS = 10_000;
export const DAEMON_COMMAND_TIMEOUT_MS = 15_000;
export const DAEMON_CREATE_TIMEOUT_MS = 30_000;

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
		this.client.enableAutoReconnect({ recoverDaemon: () => ensureInteractiveDaemonRunning(this.socketPath) });
		await ensureInteractiveDaemonRunning(this.socketPath);
		await this.client.connect();
		await this.client.waitForHello();
		this.started = true;
	}

	async command<T>(body: DaemonCommandBody, timeoutMs = DAEMON_COMMAND_TIMEOUT_MS): Promise<T> {
		try {
			return await this.send<T>(body, timeoutMs);
		} catch (error) {
			if (error instanceof DaemonCommandError) {
				throw error;
			}
			await this.recover(error);
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

	/** One bounded recovery attempt: daemon churn (restart, update) must not fail a tool call. */
	private async recover(cause: unknown): Promise<void> {
		try {
			await ensureInteractiveDaemonRunning(this.socketPath);
			if (!this.client.isConnected) {
				await this.client.reconnect();
			}
			await this.client.waitForHello();
		} catch (error) {
			const causeMessage = cause instanceof Error ? cause.message : String(cause);
			const recoveryMessage = error instanceof Error ? error.message : String(error);
			throw new Error(
				`The Prime Agent daemon is unreachable (${causeMessage}). Recovery failed: ${recoveryMessage}`,
			);
		}
	}
}
