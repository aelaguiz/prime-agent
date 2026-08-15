import { describe, expect, it } from "vitest";
import type { DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";
import {
	assertDaemonWorkerCommandCompatibility,
	type DaemonWorkerHello,
} from "../src/modes/daemon/daemon-worker-client.js";

const handoff = {
	type: "handoff_aim_credential",
	activeSessionId: "root",
	provider: "xai",
	expectedModel: "grok-4.6",
	expectedBinding: "grok-a",
	expectedIdentityFingerprint: "fp-a",
	requestedBinding: "grok-b",
	requestedIdentityFingerprint: "fp-b",
} satisfies DaemonCommand;

const queueMutation = {
	type: "mutate_queued_message",
	activeSessionId: "root",
	lane: "steering",
	index: 0,
	expectedText: "queued-1",
	mutation: { type: "delete" },
} satisfies DaemonCommand;

function hello(schemaRevision: number, serverCapabilities: DaemonWorkerHello["serverCapabilities"]): DaemonWorkerHello {
	return {
		type: "daemon_hello",
		socketPath: "/tmp/worker.sock",
		protocol: { name: "prime-agent.daemon", version: 7 },
		schemaId: `test-schema-${schemaRevision}`,
		schemaRevision,
		serverCapabilities,
		clientId: "test-client",
	};
}

describe("daemon worker command compatibility", () => {
	it("lets a revision-15 AIM worker accept handoff but rejects queue mutation", () => {
		const worker = hello(15, ["aim_credential_handoff"]);
		expect(() => assertDaemonWorkerCommandCompatibility(worker, handoff)).not.toThrow();
		expect(() => assertDaemonWorkerCommandCompatibility(worker, queueMutation)).toThrow(
			"does not support queue_message_mutation",
		);
	});

	it("lets a revision-16 upstream worker accept queue mutation but rejects AIM handoff", () => {
		const worker = hello(16, ["queue_message_mutation"]);
		expect(() => assertDaemonWorkerCommandCompatibility(worker, queueMutation)).not.toThrow();
		expect(() => assertDaemonWorkerCommandCompatibility(worker, handoff)).toThrow(
			"does not support aim_credential_handoff",
		);
	});

	it("lets the merged worker accept both capability-gated commands", () => {
		const worker = hello(17, ["aim_credential_handoff", "queue_message_mutation"]);
		expect(() => assertDaemonWorkerCommandCompatibility(worker, handoff)).not.toThrow();
		expect(() => assertDaemonWorkerCommandCompatibility(worker, queueMutation)).not.toThrow();
	});
});
