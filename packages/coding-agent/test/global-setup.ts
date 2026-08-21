import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ISOLATED_ENV_KEYS = [
	"PRIME_AGENT_INTERNAL_DAEMON_CATALOG",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER",
	"PRIME_AGENT_INTERNAL_OWNED_WORKER",
	"PRIME_AGENT_INTERNAL_PARENT_PROCESS_INSTANCE_ID",
	"PRIME_AGENT_INTERNAL_PROCESS_INSTANCE_ID",
	"PRIME_AGENT_INTERNAL_PROCESS_LAUNCH_TRIGGER",
	"PRIME_AGENT_INTERNAL_PROCESS_LIFECYCLE_CONTEXT",
	"PRIME_AGENT_INTERNAL_PROCESS_LIFECYCLE_ROLE",
] as const;

export default function setup(): () => void {
	const agentDirKey = "PRIME_AGENT_CODING_AGENT_DIR";
	const priorAgentDir = process.env[agentDirKey];
	const priorInternalValues = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
	const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-vitest-"));
	process.env[agentDirKey] = agentDir;
	for (const key of ISOLATED_ENV_KEYS) delete process.env[key];

	return () => {
		rmSync(agentDir, { recursive: true, force: true });
		if (priorAgentDir === undefined) delete process.env[agentDirKey];
		else process.env[agentDirKey] = priorAgentDir;
		for (const [key, value] of priorInternalValues) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}
