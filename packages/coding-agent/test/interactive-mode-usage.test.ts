import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type UsageCommandContext = {
	agentConnection: {
		getSessionStats: () => Promise<unknown>;
		getState: () => Promise<unknown>;
	};
	showError: (message: string) => void;
};

type InteractiveModePrototype = {
	handleUsageCommand(this: UsageCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /usage", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("reports stats lookup failures instead of rejecting the editor submission", async () => {
		const context = Object.assign(Object.create(InteractiveMode.prototype) as UsageCommandContext, {
			agentConnection: {
				getSessionStats: vi.fn(async () => {
					throw new Error("usage RPC failed");
				}),
				getState: vi.fn(async () => ({})),
			},
			showError: vi.fn(),
		});

		await expect(interactiveModePrototype.handleUsageCommand.call(context)).resolves.toBeUndefined();

		expect(context.showError).toHaveBeenCalledWith("Unable to load usage: usage RPC failed");
	});
});
