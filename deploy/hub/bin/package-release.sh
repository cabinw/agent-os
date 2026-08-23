#!/bin/bash -p
set -Eeuo pipefail

if ((EUID == 0)); then
  printf '%s\n' 'Hub deployment failed: release packaging must run without root' >&2
  exit 1
fi

if [[ -n "${AGENT_OS_DEPLOY_TEST_ROOT:-}" || -n "${AGENT_OS_DEPLOY_TEST_MODE:-}" ||
  -n "${AGENT_OS_DEPLOY_TEST_NONCE:-}" ]]; then
  printf '%s\n' 'Hub deployment failed: release packaging forbids deployment test mode' >&2
  exit 1
fi
for influence in \
  NODE_OPTIONS \
  NODE_PATH \
  NODE_EXTRA_CA_CERTS \
  NODE_TLS_REJECT_UNAUTHORIZED \
  OPENSSL_CONF \
  OPENSSL_CONF_INCLUDE \
  OPENSSL_ENGINES \
  OPENSSL_MODULES \
  SSL_CERT_FILE \
  SSL_CERT_DIR \
  COREPACK_HOME \
  COREPACK_DEFAULT_TO_LATEST \
  COREPACK_ENABLE_AUTO_PIN \
  COREPACK_ENABLE_DOWNLOAD_PROMPT \
  COREPACK_ENABLE_NETWORK \
  COREPACK_ENABLE_PROJECT_SPEC \
  COREPACK_ENABLE_STRICT \
  COREPACK_ENV_FILE \
  COREPACK_INTEGRITY_KEYS \
  COREPACK_NPM_REGISTRY \
  COREPACK_NPM_TOKEN \
  COREPACK_NPM_USERNAME \
  COREPACK_NPM_PASSWORD \
  COREPACK_ROOT \
  COREPACK_USE_LATEST; do
  if [[ -n "${!influence:-}" ]]; then
    printf 'Hub deployment failed: release packaging rejects inherited variable %s\n' \
      "$influence" >&2
    exit 1
  fi
done
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

source_root=
source_root_input=
output=
temporary=
temporary_parent=
corepack_bin=

cleanup() {
  [[ -n "$temporary" && -d "$temporary" ]] || return 0
  [[ "$(dirname -- "$temporary")" == "$temporary_parent" ]] || {
    printf '%s\n' 'refusing release-build cleanup outside the owned temporary parent' >&2
    return 1
  }
  case "$(basename -- "$temporary")" in
    agent-os-hub-release.*) ;;
    *)
      printf '%s\n' 'refusing release-build cleanup for an unowned directory name' >&2
      return 1
      ;;
  esac
  rm -rf -- "$temporary" || return 1
  [[ ! -e "$temporary" ]] || return 1
  temporary=
}

finish() {
  local result=$?
  trap - EXIT
  cleanup || result=1
  exit "$result"
}
trap finish EXIT

usage() {
  printf '%s\n' 'usage: package-release.sh --source REPOSITORY --output ARCHIVE.tar.gz' >&2
}

while (($# > 0)); do
  case "$1" in
    --source | --output)
      (($# >= 2)) || { usage; exit 2; }
      case "$1" in
        --source) source_root=$2 ;;
        --output) output=$2 ;;
      esac
      shift 2
      ;;
    *) usage; exit 2 ;;
  esac
done

[[ -n "$source_root" && -n "$output" ]] || { usage; exit 2; }
require_commands install cp tar mktemp find rm dirname
require_pinned_node
if [[ -n "${AGENT_OS_COREPACK_BIN:-}" && \
  "$AGENT_OS_COREPACK_BIN" != "$PRODUCTION_COREPACK_BIN" ]]; then
  die 'production release packaging rejects AGENT_OS_COREPACK_BIN override'
fi
corepack_bin=$PRODUCTION_COREPACK_BIN
resolve_trusted_executable Corepack "$corepack_bin"
readonly corepack_bin
corepack_version="$($NODE_BIN "$corepack_bin" --version 2>/dev/null)" ||
  die 'Corepack version check failed'
[[ "$corepack_version" == "$EXPECTED_COREPACK_VERSION" ]] ||
  die "Corepack $EXPECTED_COREPACK_VERSION is required"
[[ "$output" == /* ]] || die 'release output must be an absolute path'
[[ ! -e "$output" && ! -L "$output" && ! -e "$output.sha256" && ! -L "$output.sha256" ]] ||
  die 'release output already exists'
source_root_input=$source_root
source_root="$(CDPATH= cd -- "$source_root_input" 2>/dev/null && pwd -P)" ||
  die "release source root is inaccessible: $source_root_input"
[[ -f "$source_root/package.json" && -d "$source_root/apps/chat-spike/src" ]] ||
  die "release source root is not an Agent OS repository: $source_root"
package_manager="$(
  "$NODE_BIN" -e \
    'const value = require(process.argv[1]).packageManager; process.stdout.write(typeof value === "string" ? value : "");' \
    "$source_root/package.json"
)" || die 'root package manager declaration is unreadable'
[[ "$package_manager" == pnpm@11.17.0 ]] ||
  die "release packaging requires packageManager pnpm@11.17.0 in source root: $source_root"
temporary_parent="$(CDPATH= cd -- "${TMPDIR:-/tmp}" && pwd -P)"
temporary="$(mktemp -d "$temporary_parent/agent-os-hub-release.XXXXXX")"
umask 077
install -d \
  "$temporary/corepack-home" \
  "$temporary/home" \
  "$temporary/xdg-cache" \
  "$temporary/xdg-config" \
  "$temporary/xdg-data" \
  "$temporary/pnpm-home" \
  "$temporary/pnpm-store"
corepack_environment=(
  /usr/bin/env -i
  PATH=/usr/bin:/bin:/usr/sbin:/sbin
  LANG=C.UTF-8
  HOME="$temporary/home"
  CI=1
  COREPACK_HOME="$temporary/corepack-home"
  COREPACK_DEFAULT_TO_LATEST=0
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  COREPACK_ENABLE_NETWORK=1
  COREPACK_ENABLE_PROJECT_SPEC=1
  COREPACK_ENABLE_STRICT=1
  COREPACK_ENV_FILE=0
  COREPACK_NPM_REGISTRY=https://registry.npmjs.org
  XDG_CACHE_HOME="$temporary/xdg-cache"
  XDG_CONFIG_HOME="$temporary/xdg-config"
  XDG_DATA_HOME="$temporary/xdg-data"
  PNPM_HOME="$temporary/pnpm-home"
  NPM_CONFIG_USERCONFIG=/dev/null
  NPM_CONFIG_GLOBALCONFIG=/dev/null
  npm_config_store_dir="$temporary/pnpm-store"
)
pnpm_version="$(
  cd "$source_root"
  "${corepack_environment[@]}" "$NODE_BIN" "$corepack_bin" pnpm --version 2>/dev/null
)" || die "Corepack pnpm resolution failed from release source root: $source_root"
[[ "$pnpm_version" == 11.17.0 ]] ||
  die "release packaging requires Corepack pnpm 11.17.0 resolved from source root: $source_root"

bundle="$temporary/bundle"
workspace="$temporary/workspace"
closure="$workspace/node_modules"
install -d "$bundle/apps/chat-spike" "$workspace/apps/chat-spike"
cp -a \
  "$source_root/package.json" \
  "$source_root/pnpm-lock.yaml" \
  "$source_root/pnpm-workspace.yaml" \
  "$bundle/"
cp -a \
  "$source_root/package.json" \
  "$source_root/pnpm-lock.yaml" \
  "$source_root/pnpm-workspace.yaml" \
  "$workspace/"
cp -a "$source_root/apps/chat-spike/package.json" "$workspace/apps/chat-spike/"

# Resolve a frozen, production-only and script-free closure in a minimal
# workspace. Hoisting makes package export resolution portable; copy import
# mode prevents store hardlinks from entering the release.
(
  cd "$workspace"
  "${corepack_environment[@]}" "$NODE_BIN" "$corepack_bin" pnpm install \
    --filter @agent-os/chat-spike \
    --prod \
    --frozen-lockfile \
    --ignore-scripts \
    --config.node-linker=hoisted \
    --config.package-import-method=copy
)
[[ -d "$closure" && ! -L "$closure" ]] ||
  die 'pnpm did not produce a production dependency closure'
for metadata in .bin .pnpm .modules.yaml .package-map.json .pnpm-workspace-state-v1.json; do
  path="$closure/$metadata"
  [[ "$(dirname -- "$path")" == "$closure" ]] ||
    die 'internal dependency metadata path escaped its closure'
  rm -rf -- "$path"
done
if [[ -n "$(find "$closure" -type l -print -quit)" ]]; then
  die 'production dependency closure contains a symbolic link'
fi
if [[ -n "$(find "$closure" -type f -links +1 -print -quit)" ]]; then
  die 'production dependency closure contains a multiply-linked file'
fi
if [[ -n "$(find "$closure" ! -type d ! -type f -print -quit)" ]]; then
  die 'production dependency closure contains a special object'
fi

cp -a \
  "$source_root/apps/chat-spike/package.json" \
  "$source_root/apps/chat-spike/src" \
  "$source_root/apps/chat-spike/public" \
  "$source_root/apps/chat-spike/bin" \
  "$bundle/apps/chat-spike/"
cp -R "$closure" "$bundle/apps/chat-spike/node_modules"

"$NODE_BIN" "$SCRIPT_DIR/verify-release.mjs" "$bundle"
"$NODE_BIN" --check "$bundle/apps/chat-spike/src/server.mjs" >/dev/null
(
  cd "$bundle/apps/chat-spike"
  "$NODE_BIN" --input-type=module --eval \
    'await import("@modelcontextprotocol/sdk/server"); await import("zod");'
)
COPYFILE_DISABLE=1 tar --format=ustar -czf "$output" -C "$bundle" .
checksum="$(sha256_file "$output")"
printf '%s  %s\n' "$checksum" "$(basename -- "$output")" >"$output.sha256"
chmod 0600 "$output" "$output.sha256"
cleanup || die 'release-build temporary directory could not be removed'
printf 'hub_release status=ok sha256=%s\n' "$checksum"
