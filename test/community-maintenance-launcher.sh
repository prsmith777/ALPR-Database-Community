#!/usr/bin/env bash
set -Eeuo pipefail
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture="$(mktemp -d /tmp/alpr-maintenance-test.XXXXXX)"
trap 'case "$fixture" in /tmp/alpr-maintenance-test.*) rm -rf -- "$fixture" ;; esac' EXIT
mkdir -p "$fixture/bin" "$fixture/installation" "$fixture/source/scripts"
export MAINTENANCE_FIXTURE_ROOT="$fixture"
export ALPR_NODE_BINARY="$(command -v node)"
export PATH="$fixture/bin:$PATH"
export FIXTURE_MODE=success
cat > "$fixture/bin/git" <<'STUB'
#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == -C ]]; then shift 2; fi
case "$*" in
  'rev-parse --show-toplevel') printf '%s\n' "$MAINTENANCE_FIXTURE_ROOT/installation" ;;
  'remote get-url origin')
    if [[ "$FIXTURE_MODE" == wrong-origin ]]; then echo https://example.invalid/other.git
    else echo https://github.com/prsmith777/ALPR-Database-Community.git; fi ;;
  'status --porcelain --untracked-files=no') [[ "$FIXTURE_MODE" != dirty ]] || echo ' M tracked-file'; true ;;
  'fetch origin '* ) [[ "$FIXTURE_MODE" != fetch-failed ]] ;;
  'rev-parse v0.1.46^{commit}') printf '%040d\n' 2 ;;
  'merge-base --is-ancestor '* ) [[ "$FIXTURE_MODE" != wrong-branch ]] ;;
  'show '*':package.json')
    if [[ "$FIXTURE_MODE" == wrong-version ]]; then echo '{"version":"0.1.42"}'
    else echo '{"version":"0.1.46"}'; fi ;;
  'archive --format=tar '*) tar -cf - -C "$MAINTENANCE_FIXTURE_ROOT/source" . ;;
  *) echo "Unexpected Git mutation: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$fixture/bin/git"
cat > "$fixture/source/scripts/community-maintenance.mjs" <<'STUB'
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const fixture = process.env.MAINTENANCE_FIXTURE_ROOT;
assert.equal(process.argv[2], join(fixture, "installation"));
assert.equal(process.argv[3], "v0.1.46");
assert.ok(!fileURLToPath(import.meta.url).startsWith(join(fixture, "installation")));
writeFileSync(join(fixture, "called"), "verified isolated driver");
STUB
cd "$fixture/installation"
for FIXTURE_MODE in wrong-origin dirty fetch-failed wrong-branch wrong-version; do
  export FIXTURE_MODE
  if bash "$repository_root/community-maintenance.sh"; then
    echo "Expected refusal for $FIXTURE_MODE" >&2; exit 1
  fi
  [[ ! -e "$fixture/called" ]]
done
export FIXTURE_MODE=success
if TMPDIR="$fixture/installation" bash "$repository_root/community-maintenance.sh"; then
  echo "Expected refusal of temporary source inside checkout" >&2; exit 1
fi
[[ ! -e "$fixture/called" ]]
bash "$repository_root/community-maintenance.sh" --help
[[ ! -e "$fixture/called" ]]
bash "$repository_root/community-maintenance.sh"
[[ -f "$fixture/called" ]]
[[ -z "$(find "$fixture/installation" -mindepth 1 -print -quit)" ]]
echo 'maintenance_launcher_origin_tag_cleanliness_isolation=passed'
