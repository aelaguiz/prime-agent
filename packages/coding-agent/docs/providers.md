# Providers

Prime Agent supports subscription-based providers via OAuth and API key providers via environment variables or the auth file. Its built-in model catalog is updated with each Prime Agent release.

## Table of Contents

- [Subscriptions](#subscriptions)
- [AIM-Managed Credentials](#aim-managed-credentials)
- [API Keys](#api-keys)
- [Auth File](#auth-file)
- [Cloud Providers](#cloud-providers)
- [Custom Providers](#custom-providers)
- [Resolution Order](#resolution-order)

## Subscriptions

Use `/login` in interactive mode, then select a provider:

- ChatGPT Plus/Pro (Codex)
- Claude Pro/Max
- GitHub Copilot

Use `/logout` to clear credentials. Tokens are stored in `~/.prime/agent/auth.json` and auto-refresh when expired.

### OpenAI Codex

- Requires ChatGPT Plus or Pro subscription
- Officially endorsed by OpenAI: [Codex for OSS](https://developers.openai.com/community/codex-for-oss)

### Claude Pro/Max

Anthropic subscription auth is active for Claude Pro/Max accounts. Third-party harness usage draws from [extra usage](https://claude.ai/settings/usage) and is billed per token, not against Claude plan limits.

### GitHub Copilot

- Press Enter for github.com, or enter your GitHub Enterprise Server domain
- If you get "model not supported", enable it in VS Code: Copilot Chat → model selector → select model → "Enable"

## AIM-Managed Credentials

AIM can install a non-secret external credential descriptor for a supported provider. Prime Agent then treats AIM as that provider's exclusive credential authority: `/login`, `/logout`, `--api-key`, runtime overrides, stored native credentials, environment variables, and custom-provider fallback keys cannot shadow or replace it.

Manage the selection with AIM, not in Prime Agent:

```bash
aim prime use --codex <profile>       # manage openai-codex
aim prime use --claude <profile>      # manage anthropic
aim prime status                      # inspect managed selections
aim prime uninstall --provider <id>   # return a provider to native auth
```

Prime Agent's `/login`, `/logout`, and model selector show the same guidance when a provider is managed. A failed managed helper is reported as an external credential error; Prime Agent does not silently fall back to native auth.

AIM writes descriptors to `~/.prime/agent/auth.json`. The descriptor contains no access token:

```json
{
  "openai-codex": {
    "type": "external",
    "source": "aimgr",
    "protocol": "aimgr-credential-v1",
    "executable": "/absolute/path/to/trusted/aim",
    "args": ["credential-helper"],
    "binding": "pro3",
    "expectedIdentityFingerprint": "<opaque-profile-identity>"
  }
}
```

Prime Agent executes the descriptor directly, without a shell, only inside the active worker for a root session. The helper receives one JSON line on stdin and must return one JSON line on stdout using `aimgr-credential-v1`. Prime Agent applies bounded input/output, timeout, exit, and freshness checks; keeps access material only in worker memory; and never writes returned values, access fingerprints, or private credential versions into `auth.json`, session JSONL, diagnostics, or daemon/client snapshots.

The first successful provider resolution pins `(provider, source, binding, identityFingerprint)` into the root's session file. Resume and fork preserve that identity binding; RLM descendants inherit it. Repointing the global AIM selection does not move a running or resumed tree to another identity. A new root session reads the current descriptor. If a bound identity is unavailable or mismatched, that tree fails closed until the binding is restored or a new root is started.

On a structured 401/403 received before any assistant output, Prime Agent may invalidate its in-memory entry and reacquire once. It retries the request only if the helper returns a different access-value fingerprint; private `credentialVersion` changes alone never authorize a retry. Mid-stream failures and all other errors use normal provider behavior.

This boundary is designed to keep account material out of Prime Agent persistence and daemon transport. It is not a same-UID sandbox: a malicious process running as the same OS user can still inspect or interfere with user-owned processes and files.

## API Keys

### Environment Variables or Auth File

Use `/login` in interactive mode and select a provider to store an API key in `auth.json`, or set credentials via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
prime-agent
```

| Provider | Environment Variable | `auth.json` key |
|----------|----------------------|------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| Azure OpenAI Responses | `AZURE_OPENAI_API_KEY` | `azure-openai-responses` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Prime Inference | `PRIME_API_KEY` | `prime-inference` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`) | `cloudflare-ai-gateway` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`) | `cloudflare-workers-ai` |
| xAI | `XAI_API_KEY` | `xai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` |
| ZAI | `ZAI_API_KEY` | `zai` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |
| Hugging Face | `HF_TOKEN` | `huggingface` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` | `minimax-cn` |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `xiaomi` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `xiaomi-token-plan-cn` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `xiaomi-token-plan-ams` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `xiaomi-token-plan-sgp` |

Reference for environment variables and `auth.json` keys: [`env-api-keys.ts`](../../ai/src/env-api-keys.ts).

#### Auth File

Store credentials in `~/.prime/agent/auth.json`:

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "openai": { "type": "api_key", "key": "sk-..." },
  "prime-inference": { "type": "api_key", "key": "..." },
  "deepseek": { "type": "api_key", "key": "sk-..." },
  "google": { "type": "api_key", "key": "..." },
  "opencode": { "type": "api_key", "key": "..." },
  "opencode-go": { "type": "api_key", "key": "..." },
  "xiaomi": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-cn":  { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-ams": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-sgp": { "type": "api_key", "key": "..." }
}
```

The file is created with `0600` permissions (user read/write only). Auth file credentials take priority over environment variables.

### Key Resolution

The `key` field supports three formats:

- **Shell command:** `"!command"` executes and uses stdout (cached for process lifetime)
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **Environment variable:** Uses the value of the named variable
  ```json
  { "type": "api_key", "key": "MY_ANTHROPIC_KEY" }
  ```
- **Literal value:** Used directly
  ```json
  { "type": "api_key", "key": "sk-ant-..." }
  ```

OAuth credentials are also stored here after `/login` and managed automatically.

### Prime Inference

Prime Inference uses the OpenAI-compatible endpoint at `https://api.pinference.ai/api/v1`. Set `PRIME_API_KEY` or store an API key for `prime-inference` via `/login`.

## Cloud Providers

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.openai.azure.com
# also supported: https://your-resource.cognitiveservices.azure.com
# root endpoints are auto-normalized to /openai/v1
# or use resource name instead of base URL
export AZURE_OPENAI_RESOURCE_NAME=your-resource

# Optional
export AZURE_OPENAI_API_VERSION=2024-02-01
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-4=my-gpt4,gpt-4o=my-gpt4o
```

### Amazon Bedrock

```bash
# Option 1: AWS Profile
export AWS_PROFILE=your-profile

# Option 2: IAM Keys
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...

# Option 3: Bearer Token
export AWS_BEARER_TOKEN_BEDROCK=...

# Optional region (defaults to us-east-1)
export AWS_REGION=us-west-2
```

Also supports ECS task roles (`AWS_CONTAINER_CREDENTIALS_*`) and IRSA (`AWS_WEB_IDENTITY_TOKEN_FILE`).

```bash
prime-agent --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0
```

Prompt caching is enabled automatically for Claude models whose ID contains a recognizable model name (base models and system-defined inference profiles). For application inference profiles (whose ARNs don't contain the model name), set `AWS_BEDROCK_FORCE_CACHE=1` to enable cache points:

```bash
export AWS_BEDROCK_FORCE_CACHE=1
prime-agent --provider amazon-bedrock --model arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123
```

If you are connecting to a Bedrock API proxy, the following environment variables can be used:

```bash
# Set the URL for the Bedrock proxy (standard AWS SDK env var)
export AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://my.corp.proxy/bedrock

# Set if your proxy does not require authentication
export AWS_BEDROCK_SKIP_AUTH=1

# Set if your proxy only supports HTTP/1.1
export AWS_BEDROCK_FORCE_HTTP1=1
```

### Cloudflare AI Gateway

`CLOUDFLARE_API_KEY` can be set via `/login`. The account ID and gateway slug must be set as environment variables.

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...        # create at dash.cloudflare.com → AI → AI Gateway
prime-agent --provider cloudflare-ai-gateway --model "claude-sonnet-4-5"
```

Routes to OpenAI, Anthropic, and Workers AI through Cloudflare AI Gateway. Workers AI uses the Unified API (`/compat`) and prefixed model IDs (`workers-ai/@cf/...`). OpenAI uses the OpenAI passthrough route (`/openai`) with native OpenAI model IDs such as `gpt-5.1`. Anthropic uses the Anthropic passthrough route (`/anthropic`) with native Anthropic model IDs such as `claude-sonnet-4-5`.

AI Gateway authentication uses `CLOUDFLARE_API_KEY` as `cf-aig-authorization`. Upstream authentication can be one of:

| Mode | Request auth | Upstream auth |
|------|--------------|---------------|
| Workers AI | Cloudflare token only | Cloudflare-native |
| Unified billing | Cloudflare token only | Cloudflare handles upstream auth and deducts credits |
| Stored BYOK | Cloudflare token only | Cloudflare injects provider keys stored in the AI Gateway dashboard |
| Inline BYOK | Cloudflare token plus upstream `Authorization` header | The request supplies the upstream provider key |

For normal Prime Agent usage, prefer unified billing or stored BYOK. Inline BYOK requires configuring an additional upstream `Authorization` header for the Cloudflare AI Gateway provider, for example via a `models.json` provider/model override.

### Cloudflare Workers AI

`CLOUDFLARE_API_KEY` can be set via `/login`. `CLOUDFLARE_ACCOUNT_ID` must be set as an environment variable.

```bash
export CLOUDFLARE_API_KEY=...           # or use /login
export CLOUDFLARE_ACCOUNT_ID=...
prime-agent --provider cloudflare-workers-ai --model "@cf/moonshotai/kimi-k2.6"
```

Prime Agent automatically sets `x-session-affinity` for [prefix caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/) discounts.

### Google Vertex AI

Uses Application Default Credentials:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project
export GOOGLE_CLOUD_LOCATION=us-central1
```

Or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account key file.

## Custom Providers

**Via models.json:** Add Ollama, LM Studio, vLLM, or any provider that speaks a supported API (OpenAI Completions, OpenAI Responses, Anthropic Messages, Google Generative AI). See [models.md](models.md).

**Via extensions:** For providers that need custom API implementations or OAuth flows, create an extension. See [custom-provider.md](custom-provider.md) and [examples/extensions/custom-provider-gitlab-duo](../examples/extensions/custom-provider-gitlab-duo/).

## Resolution Order

When an `auth.json` entry is `type: "external"`, it is exclusive for that provider and fails closed; no native source may override or replace it. Otherwise, native credentials resolve in this order:

1. CLI/runtime API-key override
2. `auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json`
