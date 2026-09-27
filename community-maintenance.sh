#!/usr/bin/env bash
set -Eeuo pipefail

# One-time bridge for installations whose already-loaded updater predates native
# identity retirement. Download this release asset outside the checkout.
release_tag="v0.1.44"
if [[ "${1:-}" == "--help" ]]; then
  echo "Run from the existing ALPR Community checkout as its installation owner."
  echo "Loads verified $release_tag maintenance tools separately, then asks before updating."
  echo "Does not roll back, accept, clean up, or bypass validation."
  exit 0
fi
[[ $# == 0 ]] || { echo "This launcher accepts only --help." >&2; exit 1; }
installation_dir="$(git rev-parse --show-toplevel)"
origin="$(git -C "$installation_dir" remote get-url origin)"
case "$origin" in
  https://github.com/prsmith777/ALPR-Database-Community|https://github.com/prsmith777/ALPR-Database-Community.git|git@github.com:prsmith777/ALPR-Database-Community.git) ;;
  *) echo "Refusing a noncanonical Community checkout." >&2; exit 1 ;;
esac
[[ -z "$(git -C "$installation_dir" status --porcelain --untracked-files=no)" ]] || {
  echo "Tracked changes exist. Preserve them and restore a clean checkout first." >&2; exit 1;
}
node_binary="${ALPR_NODE_BINARY:-}"
if [[ -z "$node_binary" ]] && command -v node >/dev/null && [[ "$(node --version)" == v24.* ]]; then
  node_binary="$(command -v node)"
fi
if [[ -z "$node_binary" ]]; then
  runtime_root="${ALPR_BOOTSTRAP_RUNTIME_ROOT:-${XDG_DATA_HOME:-${HOME}/.local/share}/alpr-community/runtime}"
  node_binary="$runtime_root/node-current/bin/node"
fi
[[ -x "$node_binary" && "$("$node_binary" --version)" == v24.* ]] || {
  echo "Node.js 24 is required; the bootstrap's private runtime is supported." >&2; exit 1;
}
git -C "$installation_dir" fetch origin \
  "+refs/heads/main:refs/remotes/origin/main" "refs/tags/$release_tag:refs/tags/$release_tag"
release_commit="$(git -C "$installation_dir" rev-parse "$release_tag^{commit}")"
git -C "$installation_dir" merge-base --is-ancestor "$release_commit" origin/main
git -C "$installation_dir" show "$release_commit:package.json" |
  "$node_binary" -e 'let s=""; process.stdin.on("data", x=>s+=x); process.stdin.on("end",()=>{if("v"+JSON.parse(s).version!==process.argv[1]) process.exit(1)});' "$release_tag"
temporary_parent="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
case "$temporary_parent/" in
  "$installation_dir/"*) echo "TMPDIR must be outside the installation checkout." >&2; exit 1 ;;
esac
tool_dir="$(mktemp -d "$temporary_parent/alpr-community-maintenance.XXXXXX")"
cleanup() {
  case "$tool_dir" in
    "$temporary_parent"/alpr-community-maintenance.*) rm -rf -- "$tool_dir" ;;
    *) echo "Refusing unexpected temporary cleanup path." >&2 ;;
  esac
}
trap cleanup EXIT
mkdir "$tool_dir/source"
git -C "$installation_dir" archive --format=tar "$release_commit" > "$tool_dir/source.tar"
tar -xf "$tool_dir/source.tar" -C "$tool_dir/source"
echo "Verified $release_tag ($release_commit). The installed checkout has not been changed."
"$node_binary" "$tool_dir/source/scripts/community-maintenance.mjs" "$installation_dir" "$release_tag"
