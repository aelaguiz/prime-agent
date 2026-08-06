#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PRIME_AGENT_LAUNCHER_PATH="$SCRIPT_DIR/prime-agent.sh"
# A plain `git describe --dirty` is identical across all edits in a dirty source
# checkout, so an old daemon can otherwise accept a newer source client and spawn
# stale workers. Fingerprint tracked and untracked source truth for daemon fencing.
if ! BUILD_ID="$(node "$SCRIPT_DIR/scripts/source-build-id.mjs" "$SCRIPT_DIR")"; then
  echo "Failed to compute the Prime Agent source build identity." >&2
  exit 1
fi
export PRIME_AGENT_BUILD_ID="$BUILD_ID"

# Check for --no-env / --dist flags
NO_ENV=false
USE_DIST=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  elif [[ "$arg" == "--dist" ]]; then
    USE_DIST=true
  else
    ARGS+=("$arg")
  fi
done

if [[ "$NO_ENV" == "true" ]]; then
  # Unset API keys (see packages/ai/src/env-api-keys.ts)
  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_OAUTH_TOKEN
  unset OPENAI_API_KEY
  unset PRIME_API_KEY
  unset GEMINI_API_KEY
  unset GROQ_API_KEY
  unset CEREBRAS_API_KEY
  unset XAI_API_KEY
  unset OPENROUTER_API_KEY
  unset ZAI_API_KEY
  unset MISTRAL_API_KEY
  unset MINIMAX_API_KEY
  unset MINIMAX_CN_API_KEY
  unset AI_GATEWAY_API_KEY
  unset OPENCODE_API_KEY
  unset COPILOT_GITHUB_TOKEN
  unset GH_TOKEN
  unset GITHUB_TOKEN
  unset HF_TOKEN
  unset GOOGLE_APPLICATION_CREDENTIALS
  unset GOOGLE_CLOUD_PROJECT
  unset GCLOUD_PROJECT
  unset GOOGLE_CLOUD_LOCATION
  unset AWS_PROFILE
  unset AWS_ACCESS_KEY_ID
  unset AWS_SECRET_ACCESS_KEY
  unset AWS_SESSION_TOKEN
  unset AWS_REGION
  unset AWS_DEFAULT_REGION
  unset AWS_BEARER_TOKEN_BEDROCK
  unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  unset AWS_CONTAINER_CREDENTIALS_FULL_URI
  unset AWS_WEB_IDENTITY_TOKEN_FILE
  unset AZURE_OPENAI_API_KEY
  unset AZURE_OPENAI_BASE_URL
  unset AZURE_OPENAI_RESOURCE_NAME
  echo "Running Prime Agent without API keys..."
fi

# --dist runs the bundled build (what users get; ~3x faster startup than tsx).
if [[ "$USE_DIST" == "true" ]]; then
  BUNDLE="$SCRIPT_DIR/packages/coding-agent/dist/bundle/cli.js"
  if [[ ! -f "$BUNDLE" ]]; then
    echo "Bundle not found at $BUNDLE. Run npm run build first." >&2
    exit 1
  fi
  exec node "$BUNDLE" ${ARGS[@]+"${ARGS[@]}"}
fi

TSX_BIN="$SCRIPT_DIR/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  echo "tsx not found at $TSX_BIN. Run npm install from the repo root first." >&2
  exit 1
fi

"$TSX_BIN" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
