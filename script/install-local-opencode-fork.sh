#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESET=0

while (($# > 0)); do
  case "$1" in
    --reset)
      RESET=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./script/install-local-opencode-fork.sh [--reset]

Installs OpenCode plus this local oh-my-openagent fork into the live runtime
workspace, syncs the managed config, imports Codex OAuth into OpenCode auth,
and verifies the final runtime.
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

say() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

ensure_brew_formula() {
  local installed_name="$1"
  local install_ref="$2"
  if ! brew list "$installed_name" >/dev/null 2>&1; then
    say "Installing Homebrew package: $install_ref"
    brew install "$install_ref"
  fi
}

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
CACHE_DIR="$HOME/.cache/opencode"
DATA_DIR="$HOME/.local/share/opencode"
AUTH_DIR="$DATA_DIR"
AUTH_FILE="$AUTH_DIR/auth.json"

if (( RESET )); then
  say "Resetting existing OpenCode install while preserving auth"
  opencode uninstall -f >/dev/null 2>&1 || true
  brew uninstall --force opencode >/dev/null 2>&1 || true
  rm -rf "$CONFIG_DIR" "$CACHE_DIR"
  if [[ -d "$DATA_DIR" ]]; then
    find "$DATA_DIR" -mindepth 1 -maxdepth 1 ! -name "$(basename "$AUTH_FILE")" -exec rm -rf {} +
  fi
fi

require_cmd brew
ensure_brew_formula bun oven-sh/bun/bun
ensure_brew_formula opencode opencode

say "Installing repo dependencies"
cd "$ROOT_DIR"
bun install

say "Building local fork"
bun run build

say "Preparing OpenCode runtime workspace"
mkdir -p "$CACHE_DIR"
RUNTIME_DEPS_JSON="$(bun --eval "import { MANAGED_RUNTIME_PLUGIN_DEPENDENCIES } from '$ROOT_DIR/src/shared/managed-opencode-runtime.ts'; process.stdout.write(JSON.stringify(MANAGED_RUNTIME_PLUGIN_DEPENDENCIES));")"
cat >"$CACHE_DIR/package.json" <<EOF
{
  "name": "opencode-local-runtime",
  "private": true,
  "dependencies": $RUNTIME_DEPS_JSON
}
EOF
rm -rf "$CACHE_DIR/node_modules" "$CACHE_DIR/bun.lock"
(cd "$CACHE_DIR" && bun install)

mkdir -p "$CONFIG_DIR/node_modules"
rm -rf "$CONFIG_DIR/node_modules/oh-my-openagent" "$CONFIG_DIR/node_modules/oh-my-opencode"
ln -sfn "$ROOT_DIR" "$CONFIG_DIR/node_modules/oh-my-openagent"

say "Syncing managed OpenCode config"
bun run script/sync-custom-opencode-assets.ts --target "$CONFIG_DIR"

say "Pinning OpenCode host config to the local fork"
LIVE_PLUGIN_JSON="$(bun --eval "import { getManagedLivePluginEntries } from '$ROOT_DIR/src/shared/managed-opencode-runtime.ts'; process.stdout.write(JSON.stringify(getManagedLivePluginEntries('$ROOT_DIR')));")"
node -e "
const fs = require('node:fs');
const configPath = process.argv[1];
const livePluginJson = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.plugin = JSON.parse(livePluginJson);
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
" "$CONFIG_DIR/opencode.json" "$LIVE_PLUGIN_JSON"

say "Importing Codex OAuth into OpenCode auth"
bun --eval "import { syncCodexCliAuthToOpenCodeAuth } from '$ROOT_DIR/src/shared/codex-auth-bootstrap.ts'; syncCodexCliAuthToOpenCodeAuth();"

say "Verifying live runtime"
bun run script/verify-local-opencode-install.ts

say "Install complete"
