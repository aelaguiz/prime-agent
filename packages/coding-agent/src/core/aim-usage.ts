import { spawn } from "node:child_process";
import { assertTrustedAimExecutable, buildAimHelperEnvironment } from "./aim-external-auth.js";

const MAX_STATUS_BYTES = 2_000_000;

export interface AimUsageWindow {
	label: string;
	usedPercent: number;
	resetAt?: number;
}

export interface AimAccountUsage {
	provider: string;
	label: string;
	ok: boolean;
	plan?: string;
	windows: AimUsageWindow[];
	limitReached: boolean;
	stale: boolean;
}

interface AimStatusAccount {
	provider?: unknown;
	label?: unknown;
	usage?: {
		ok?: unknown;
		plan?: unknown;
		windows?: unknown;
		limitReached?: unknown;
		stale?: unknown;
	};
}

function parseWindow(value: unknown): AimUsageWindow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const window = value as Record<string, unknown>;
	if (
		typeof window.label !== "string" ||
		typeof window.usedPercent !== "number" ||
		!Number.isFinite(window.usedPercent)
	) {
		return undefined;
	}
	return {
		label: window.label,
		usedPercent: Number(window.usedPercent),
		...(typeof window.resetAt === "number" && Number.isFinite(window.resetAt) ? { resetAt: window.resetAt } : {}),
	};
}

/** Parse only the non-secret usage fields needed by /usage. */
export function parseAimAccountUsage(raw: string): AimAccountUsage[] {
	const parsed = JSON.parse(raw) as { accounts?: unknown };
	if (!Array.isArray(parsed.accounts)) return [];
	return parsed.accounts.flatMap((candidate) => {
		if (!candidate || typeof candidate !== "object") return [];
		const account = candidate as AimStatusAccount;
		if (typeof account.provider !== "string" || typeof account.label !== "string") return [];
		const usage = account.usage;
		return [
			{
				provider: account.provider,
				label: account.label,
				ok: usage?.ok === true,
				...(typeof usage?.plan === "string" ? { plan: usage.plan } : {}),
				windows: Array.isArray(usage?.windows) ? usage.windows.flatMap((window) => parseWindow(window) ?? []) : [],
				limitReached: usage?.limitReached === true,
				stale: usage?.stale === true,
			},
		];
	});
}

/** Run AIM's existing secret-free status surface without a shell. */
export async function queryAimAccountUsage(executable: string, timeoutMs = 15_000): Promise<AimAccountUsage[]> {
	assertTrustedAimExecutable(executable);
	return new Promise((resolve, reject) => {
		const child = spawn(executable, ["status", "--json"], {
			env: buildAimHelperEnvironment(),
			shell: false,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else {
				try {
					resolve(parseAimAccountUsage(Buffer.concat(stdout, stdoutBytes).toString("utf8")));
				} catch {
					reject(new Error("AIM returned invalid usage data."));
				}
			}
		};
		const terminate = (error: Error) => {
			if (settled) return;
			child.stdout.removeAllListeners("data");
			child.stdout.resume();
			// This is a read-only local status process. A hard stop keeps the
			// advertised deadline real even if a child ignores SIGTERM.
			child.kill("SIGKILL");
			finish(error);
		};
		const timer = setTimeout(() => {
			terminate(new Error("AIM usage query timed out."));
		}, timeoutMs);
		timer.unref?.();
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_STATUS_BYTES) {
				terminate(new Error("AIM usage response was too large."));
			} else {
				stdout.push(chunk);
			}
		});
		child.once("error", () => finish(new Error("AIM usage query could not start.")));
		child.once("close", (code) => {
			if (code !== 0) finish(new Error("AIM usage query failed."));
			else finish();
		});
	});
}
