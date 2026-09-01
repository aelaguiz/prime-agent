import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createHarness, type Harness } from "./suite/harness.js";
import { createTestResourceLoader, userMsg } from "./utilities.js";

describe("fork thinking defaults", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) {
			session.dispose();
		}
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	async function createSession(harness: Harness, modelId: string, sessionManager = SessionManager.inMemory()) {
		const result = await createAgentSession({
			cwd: harness.tempDir,
			authStorage: harness.authStorage,
			model: harness.getModel(modelId),
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: harness.settingsManager,
		});
		sessions.push(result.session);
		return result.session;
	}

	it("starts Sol at max and the preferred Anthropic models at xhigh without changing other defaults", async () => {
		const codexHarness = await createHarness({
			api: "openai-codex-responses",
			provider: "openai-codex",
			models: [
				{ id: "gpt-5.6-sol", reasoning: true },
				{ id: "gpt-5.6-sol-pro", reasoning: true },
			],
			settings: { defaultThinkingLevel: "low" },
		});
		harnesses.push(codexHarness);
		Object.assign(codexHarness.getModel("gpt-5.6-sol")!, {
			thinkingLevelMap: { xhigh: "xhigh", minimal: null, max: "max" },
		});
		const anthropicHarness = await createHarness({
			api: "anthropic-messages",
			provider: "anthropic",
			models: [
				{ id: "claude-fable-5", reasoning: true },
				{ id: "claude-opus-5", reasoning: true },
			],
			settings: { defaultThinkingLevel: "low" },
		});
		harnesses.push(anthropicHarness);
		Object.assign(anthropicHarness.getModel("claude-fable-5")!, {
			thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
		});
		Object.assign(anthropicHarness.getModel("claude-opus-5")!, {
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});

		expect((await createSession(codexHarness, "gpt-5.6-sol")).thinkingLevel).toBe("max");
		expect((await createSession(anthropicHarness, "claude-fable-5")).thinkingLevel).toBe("xhigh");
		expect((await createSession(anthropicHarness, "claude-opus-5")).thinkingLevel).toBe("xhigh");
		expect((await createSession(codexHarness, "gpt-5.6-sol-pro")).thinkingLevel).toBe("low");
	});

	it("keeps TUI effort changes session-local and restores them only when resuming that session", async () => {
		const harness = await createHarness({
			api: "openai-codex-responses",
			provider: "openai-codex",
			models: [{ id: "gpt-5.6-sol", reasoning: true }],
			settings: { defaultThinkingLevel: "medium" },
		});
		harnesses.push(harness);
		Object.assign(harness.getModel("gpt-5.6-sol")!, {
			thinkingLevelMap: { xhigh: "xhigh", minimal: null, max: "max" },
		});
		const sessionManager = SessionManager.inMemory(harness.tempDir);
		const firstSession = await createSession(harness, "gpt-5.6-sol", sessionManager);
		expect(firstSession.thinkingLevel).toBe("max");

		sessionManager.appendMessage(userMsg("keep this session"));
		firstSession.setThinkingLevel("low");
		expect(firstSession.thinkingLevel).toBe("low");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("medium");
		firstSession.dispose();

		const resumedSession = await createSession(harness, "gpt-5.6-sol", sessionManager);
		expect(resumedSession.thinkingLevel).toBe("low");

		const freshSession = await createSession(harness, "gpt-5.6-sol");
		expect(freshSession.thinkingLevel).toBe("max");
	});
});
