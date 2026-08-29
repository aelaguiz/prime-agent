import { Container, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	BrandSplashHeader,
	getRandomStartHint,
	InteractiveMode,
	START_HINTS,
} from "../src/modes/interactive/interactive-mode.js";
import type { PromptStashState } from "../src/modes/interactive/prompt-stash-state.js";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.js";

describe("InteractiveMode startup hints", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	function createMode(sessionHasMessages = false, returnToAgentsView = false, getEditorText = () => "") {
		const mode = {
			sessionHasMessages,
			options: { returnToAgentsView },
			editor: { getText: getEditorText },
			connectionState: {
				model: { id: "test-model", name: "test-model", reasoning: true },
				thinkingLevel: "high",
			},
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		return mode;
	}

	it("keeps a blank row above the shared splash and limits its metadata", () => {
		const header = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
			undefined,
			{
				topPadding: true,
				getStartHint: () => 'Try "refactor @<filepath>"',
			},
		);

		const lines = header.render(120);
		const output = stripAnsi(lines.join("\n"));

		expect(lines[0]).toBe("");
		expect(output).toContain("version  v0.0.0");
		expect(output).toContain("model    test-model");
		expect(output).toContain("cwd      /tmp/project");
		expect(output).toContain('Try "refactor @<filepath>"');
		expect(output).not.toContain("input");
		expect(output).not.toContain("files");
		expect(output).not.toContain("help");

		const unpadded = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
		);
		expect(unpadded.render(120)[0]).not.toBe("");
	});

	it("randomly selects from five concise filepath prompts", () => {
		expect(START_HINTS).toHaveLength(5);
		expect(new Set(START_HINTS).size).toBe(5);

		for (const [index, hint] of START_HINTS.entries()) {
			expect(getRandomStartHint(() => index / START_HINTS.length)).toBe(hint);
			expect(hint).toMatch(/^Try ".*@<filepath>.*"$/);
		}
	});

	it("places the fresh-chat shortcut hint after the model and effort", () => {
		const mode = createMode();
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("test-model • high  ? for shortcuts");
	});

	it("projects disabled Fast mode as a bold bright-red priority label", () => {
		const mode = Object.assign(createMode(), {
			connectionState: {
				model: {
					id: "gpt-5.6-sol",
					name: "GPT-5.6 Sol",
					provider: "openai-codex",
					api: "openai-codex-responses",
					reasoning: true,
				},
				thinkingLevel: "high",
				serviceTier: "default",
			},
		});
		const label = Reflect.get(InteractiveMode.prototype, "getTrayPriorityLabel").call(mode);

		expect(stripAnsi(label)).toBe("FAST OFF");
		expect(label).toBe(theme.bold(theme.fg("fastModeOff", "FAST OFF")));
		expect(label).toContain(theme.getFgAnsi("fastModeOff"));
		if (theme.bold("FAST OFF") !== "FAST OFF") {
			expect(label).toContain("\u001b[1m");
		}
	});

	it("routes session-view requests through the existing agents-view return path", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, true), { returnToAgentsView });

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(returnToAgentsView).toHaveBeenCalledOnce();
	});

	it("no longer blocks the agents-view handoff on a draft", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const showStatus = vi.fn();
		const mode = Object.assign(
			createMode(false, true, () => "draft prompt"),
			{ returnToAgentsView, showStatus },
		);

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(returnToAgentsView).toHaveBeenCalledOnce();
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("no longer blocks the scoped agents-view handoff on a draft", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const showStatus = vi.fn();
		const mode = Object.assign(
			createMode(false, true, () => "scoped draft"),
			{ returnToAgentsView, showStatus },
		);

		await Reflect.get(InteractiveMode.prototype, "openScopedAgentsView").call(mode);

		expect(returnToAgentsView).toHaveBeenCalledWith("scoped_agents_view");
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("stashes the draft once per agents-view handoff even when re-requested mid-teardown", async () => {
		const promptStashState: PromptStashState = {};
		let resolveDispose!: () => void;
		const disposePromise = new Promise<void>((resolve) => {
			resolveDispose = resolve;
		});
		const mode = Object.assign(
			createMode(false, true, () => "draft prompt"),
			{
				promptStashState,
				pastedImages: new Map(),
				isShuttingDown: false,
				agentsViewRequest: undefined,
				unregisterSignalHandlers: vi.fn(),
				teardownSessionUi: vi.fn(async () => {}),
				agentConnection: { dispose: vi.fn(() => disposePromise) },
			},
		);
		const returnToAgentsView = Reflect.get(InteractiveMode.prototype, "returnToAgentsView");

		const firstHandoff = returnToAgentsView.call(mode);
		await returnToAgentsView.call(mode);

		expect(promptStashState.stash).toMatchObject({ text: "draft prompt", restoreOnOpen: true });
		expect(promptStashState.queuedStashes).toBeUndefined();
		resolveDispose();
		await firstHandoff;
	});

	it("opens the shared session view on back navigation for process-local chats", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, false), { requestAgentsView, returnToAgentsView });

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(true);
		expect(requestAgentsView).toHaveBeenCalledOnce();
		expect(returnToAgentsView).not.toHaveBeenCalled();
	});

	it("returns to the daemon agents view on back navigation for daemon chats", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, true), { requestAgentsView, returnToAgentsView });

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(true);
		expect(returnToAgentsView).toHaveBeenCalledOnce();
		expect(requestAgentsView).not.toHaveBeenCalled();
	});

	it("leaves back navigation to the editor while a draft exists", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const mode = Object.assign(
			createMode(false, false, () => "draft prompt"),
			{ requestAgentsView },
		);

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(false);
		expect(requestAgentsView).not.toHaveBeenCalled();
	});

	it("protects a draft from the stop-and-archive hotkey", () => {
		const stopAgentAndExit = vi.fn();
		const showStatus = vi.fn();
		const mode = Object.assign(
			createMode(false, false, () => "unsent draft"),
			{
				stopAgentAndExit,
				showStatus,
			},
		);

		Reflect.get(InteractiveMode.prototype, "handleStopAgent").call(mode);

		expect(stopAgentAndExit).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Clear or stash the prompt before stopping the agent", "warning");
	});

	it("stops once and exits without a stale resume hint", async () => {
		let releaseStop!: () => void;
		const stopGate = new Promise<void>((resolve) => {
			releaseStop = resolve;
		});
		const stop = vi.fn(() => stopGate);
		const shutdown = vi.fn(async () => {});
		const mode = Object.assign(createMode(), {
			isStoppingAgent: false,
			isShuttingDown: false,
			agentConnection: { stop },
			showStatus: vi.fn(),
			showError: vi.fn(),
			shutdown,
		});
		const stopAgentAndExit = Reflect.get(InteractiveMode.prototype, "stopAgentAndExit");

		const firstStop = stopAgentAndExit.call(mode) as Promise<void>;
		await stopAgentAndExit.call(mode);

		expect(stop).toHaveBeenCalledOnce();
		expect(shutdown).not.toHaveBeenCalled();

		releaseStop();
		await firstStop;

		expect(shutdown).toHaveBeenCalledOnce();
		expect(shutdown).toHaveBeenCalledWith({ showResumeHint: false });
	});

	it("keeps the TUI open and retryable when stop-and-archive fails", async () => {
		const shutdown = vi.fn(async () => {});
		const showError = vi.fn();
		const mode = Object.assign(createMode(), {
			isStoppingAgent: false,
			isShuttingDown: false,
			agentConnection: { stop: vi.fn(async () => Promise.reject(new Error("daemon refused stop"))) },
			showStatus: vi.fn(),
			showError,
			shutdown,
		});

		await Reflect.get(InteractiveMode.prototype, "stopAgentAndExit").call(mode);

		expect(mode.isStoppingAgent).toBe(false);
		expect(shutdown).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith("Failed to stop and archive agent: daemon refused stop");
	});

	it("suppresses only the connection-close error expected during a requested stop", async () => {
		let listener!: (event: { type: "closed"; error?: string }) => Promise<void>;
		const showError = vi.fn();
		const mode = Object.assign(createMode(), {
			isStoppingAgent: true,
			isShuttingDown: false,
			agentConnection: {
				subscribe: (next: typeof listener) => {
					listener = next;
					return () => {};
				},
			},
			showError,
		});

		Reflect.get(InteractiveMode.prototype, "subscribeToAgent").call(mode);
		await listener({ type: "closed", error: "expected stop close" });

		expect(showError).not.toHaveBeenCalled();

		mode.isStoppingAgent = false;
		await listener({ type: "closed", error: "unexpected close" });

		expect(showError).toHaveBeenCalledWith("unexpected close");
	});

	it("explains that the agents view needs the daemon for non-daemon chats", async () => {
		const showStatus = vi.fn();
		const shutdown = vi.fn(async () => {});
		const mode = Object.assign(createMode(false, false), {
			returnToAgentsView: vi.fn(async () => {}),
			showStatus,
			shutdown,
		});

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("needs the daemon"));
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("keeps the lowercase agents hint while typing", () => {
		let editorText = "";
		const mode = createMode(false, true, () => editorText);
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(getLabel())).toBe("← agents/resume  test-model • high  ? for shortcuts");

		editorText = "draft prompt";
		expect(stripAnsi(getLabel())).toBe("← agents/resume  test-model • high");
	});

	it("hides the fresh-chat shortcut hint while the prompt has text", () => {
		let editorText = "";
		const mode = createMode(false, false, () => editorText);
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(getLabel())).toBe("test-model • high  ? for shortcuts");

		editorText = "draft prompt";
		expect(stripAnsi(getLabel())).toBe("test-model • high");

		editorText = " ";
		expect(stripAnsi(getLabel())).toBe("test-model • high");

		editorText = "";
		expect(stripAnsi(getLabel())).toBe("test-model • high  ? for shortcuts");
	});

	it("hides the tray shortcut guidance for chats with history", () => {
		const mode = createMode(true);
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("test-model • high");
	});

	it("keeps the question-mark shortcut guide compact", () => {
		const guide = Reflect.get(InteractiveMode.prototype, "getShortcutGuide").call(createMode());

		expect(guide).toContain("`!` shell mode · `/` commands · `@` file paths");
		expect(guide).toContain("`Ctrl+X` stop & archive agent");
		expect(guide).toContain("`Ctrl+D` detach; resident agent keeps running");
		expect(guide).toContain("stash prompt");
		expect(guide).toContain("`/hotkeys` full reference");
		expect(guide).not.toContain("Ctrl+Z");
		expect(guide).not.toContain("suspend");
		expect(guide).not.toContain("**Navigation**");
		expect(guide).not.toContain("**Extensions**");
	});

	it("renders question-mark shortcut help ephemerally without appending to chat history", () => {
		const shortcutGuideContainer = new Container();
		const chatContainer = new Container();
		const mode = Object.assign(createMode(), {
			shortcutGuideContainer,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});

		Reflect.get(InteractiveMode.prototype, "showShortcutGuide").call(mode);
		Reflect.get(InteractiveMode.prototype, "showShortcutGuide").call(mode);

		expect(chatContainer.children).toHaveLength(0);
		expect(shortcutGuideContainer.children).toHaveLength(2);

		Reflect.get(InteractiveMode.prototype, "clearShortcutGuide").call(mode);

		expect(shortcutGuideContainer.children).toHaveLength(0);
	});

	it("keeps /hotkeys comprehensive without Ctrl+Z", () => {
		const guide = Reflect.get(InteractiveMode.prototype, "getHotkeysGuide").call(createMode());

		expect(new KeybindingsManager().getEffectiveConfig()["app.session.stop"]).toBe("ctrl+x");
		expect(guide).toContain("**Navigation**");
		expect(guide).toContain("**Editing**");
		expect(guide).toContain("**Fullscreen mode (`/fullscreen`)**");
		expect(guide).toContain("Stop and archive current agent (when editor is empty)");
		expect(guide).toContain("Detach and exit; agent keeps running (when editor is empty)");
		expect(guide).toContain("Queue follow-up message");
		expect(guide).not.toContain("Ctrl+Z");
		expect(guide).not.toContain("Suspend to background");
	});

	it("renders /hotkeys in chat history instead of the temporary guide", () => {
		const shortcutGuideContainer = new Container();
		const chatContainer = new Container();
		const mode = Object.assign(createMode(), {
			shortcutGuideContainer,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});

		Reflect.get(InteractiveMode.prototype, "handleHotkeysCommand").call(mode);

		expect(chatContainer.children).toHaveLength(2);
		expect(shortcutGuideContainer.children).toHaveLength(0);
	});
});
