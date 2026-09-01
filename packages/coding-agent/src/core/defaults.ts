import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

type ModelIdentity = {
	provider: string;
	id: string;
};

const MODEL_THINKING_DEFAULTS: Readonly<Record<string, ThinkingLevel>> = {
	"openai-codex/gpt-5.6-sol": "max",
	"anthropic/claude-fable-5": "xhigh",
	"anthropic/claude-fable-5-1": "xhigh",
	"anthropic/claude-opus-5": "xhigh",
};

export function getDefaultThinkingLevelForModel(
	model: ModelIdentity | undefined,
	fallback: ThinkingLevel = DEFAULT_THINKING_LEVEL,
): ThinkingLevel {
	if (!model) {
		return fallback;
	}
	return MODEL_THINKING_DEFAULTS[`${model.provider}/${model.id}`] ?? fallback;
}
