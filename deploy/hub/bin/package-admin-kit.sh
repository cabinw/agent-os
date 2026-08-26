#!/bin/bash -p
set -Eeuo pipefail

if ((EUID == 0)); then
  printf '%s\n' 'Hub admin-kit packaging failed: packaging must run without root' >&2
  exit 1
fi

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077

fail() {
  printf 'Hub admin-kit packaging failed: %s\n' "$1" >&2
  exit 1
}

source_root=
output=
temporary=
temporary_parent=

cleanup() {
  [[ -n "$temporary" && -d "$temporary" ]] || return 0
  [[ "$(dirname -- "$temporary")" == "$temporary_parent" ]] ||
    fail 'temporary cleanup escaped its owned parent'
  case "$(basename -- "$temporary")" in
    agent-os-admin-kit.*) ;;
    *) fail 'temporary cleanup target is not owned' ;;
  esac
  rm -rf -- "$temporary"
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
  printf '%s\n' 'usage: package-admin-kit.sh --source HUB_DEPLOY_ROOT --output ADMIN-KIT.tar.gz' >&2
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
[[ "$source_root" == /* && "$output" == /* ]] ||
  fail 'source and output must be absolute paths'
[[ ! -e "$output" && ! -L "$output" && ! -e "$output.sha256" && ! -L "$output.sha256" ]] ||
  fail 'output already exists'

source_root="$(CDPATH= cd -P -- "$source_root" 2>/dev/null && pwd -P)" ||
  fail 'source is inaccessible'
[[ -f "$source_root/bootstrap-admin.sh" && -d "$source_root/bin" ]] ||
  fail 'source is not an Agent OS Hub deploy root'

readonly files=(
  bootstrap-admin.sh
  bin/admin-entry-guard.sh
  bin/capacity-check.mjs
  bin/copy-artifact.mjs
  bin/extract-release.mjs
  bin/health-check.sh
  bin/install.sh
  bin/lib.sh
  bin/recovery-start-gate.sh
  bin/rollback.sh
  bin/state-admin.sh
  bin/state-forensic.mjs
  bin/state-hash.mjs
  bin/state-open-files.mjs
  bin/state-snapshot.mjs
  bin/tree-digest.mjs
  bin/upgrade.sh
  bin/validate-config.mjs
  bin/validate-config.sh
  bin/verify-release.mjs
  env.example
  nginx/agent-os-hub-limits.conf
  nginx/agent-os-hub.conf
  pre-upgrade-snapshot
  systemd/agent-os-hub-candidate@.service
  systemd/agent-os-hub.service
)

for relative in "${files[@]}"; do
  path="$source_root/$relative"
  [[ -f "$path" && ! -L "$path" ]] || fail "source file is missing or not regular: $relative"
  links="$(/usr/bin/stat -c '%h' "$path" 2>/dev/null || /usr/bin/stat -f '%l' "$path")" ||
    fail "source link count cannot be read: $relative"
  [[ "$links" == 1 ]] || fail "source file is multiply linked: $relative"
done

temporary_parent="$(CDPATH= cd -P -- "${TMPDIR:-/tmp}" && pwd -P)"
temporary="$(mktemp -d "$temporary_parent/agent-os-admin-kit.XXXXXX")"
bundle="$temporary/bundle"
install -d -m 0700 "$bundle"
for relative in "${files[@]}"; do
  destination="$bundle/$relative"
  install -d -m 0700 "$(dirname -- "$destination")"
  install -m 0600 "$source_root/$relative" "$destination"
done

actual_count="$(find "$bundle" -type f | wc -l | tr -d ' ')"
[[ "$actual_count" == "${#files[@]}" ]] || fail 'bundle file count is invalid'
[[ -z "$(find "$bundle" -type l -print -quit)" ]] || fail 'bundle contains a symbolic link'
[[ -z "$(find "$bundle" ! -type d ! -type f -print -quit)" ]] || fail 'bundle contains a special object'

COPYFILE_DISABLE=1 tar --format=ustar -czf "$output" -C "$bundle" .
if command -v sha256sum >/dev/null 2>&1; then
  checksum="$(sha256sum "$output" | awk '{print $1}')"
else
  checksum="$(shasum -a 256 "$output" | awk '{print $1}')"
fi
printf '%s  %s\n' "$checksum" "$(basename -- "$output")" >"$output.sha256"
chmod 0600 "$output" "$output.sha256"
cleanup
printf 'admin_kit status=ok sha256=%s files=%d\n' "$checksum" "${#files[@]}"
