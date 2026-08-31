import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, getApiProvider, registerFauxProvider } from "../../../ai/src/index.js";
import type { ExtensionAPI } from "../../src/index.js";

export default function registerServiceTierFauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		api: "openai-codex-responses",
		provider: "openai-codex",
		models: [{ id: "gpt-5.6-sol", reasoning: true }],
	});
	faux.setResponses([fauxAssistantMessage("SERVICE_TIER_PROCESS_OK")]);
	const apiProvider = getApiProvider(faux.api);
	if (!apiProvider) throw new Error("Faux API provider was not registered");

	pi.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		streamSimple: (model, context, options) => {
			const requestLogPath = process.env.PRIME_AGENT_TEST_SERVICE_TIER_REQUEST_LOG;
			if (requestLogPath) {
				writeFileSync(
					requestLogPath,
					JSON.stringify({
						model: model.id,
						provider: model.provider,
						reasoning: options?.reasoning,
						serviceTier: options?.serviceTier,
					}),
				);
			}
			return apiProvider.streamSimple(model, context, options);
		},
		models: faux.models.map((model) => ({
			api: model.api,
			baseUrl: model.baseUrl,
			contextWindow: model.contextWindow,
			cost: model.cost,
			id: model.id,
			input: model.input,
			maxTokens: model.maxTokens,
			name: model.name,
			reasoning: model.reasoning,
		})),
	});
}
