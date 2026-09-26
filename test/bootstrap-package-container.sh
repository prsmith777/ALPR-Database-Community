#!/usr/bin/env bash
# shellcheck disable=SC1091
# Run only inside a disposable distribution container. This intentionally
# installs the bootstrap base packages into that throwaway container.
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../bootstrap.sh
source "${repository_root}/bootstrap.sh"

[[ "$(id -u)" == 0 ]] || {
  printf 'bootstrap-package-container.sh requires a disposable root container\n' >&2
  exit 1
}

sudo() { "$@"; }
load_os_release
automatic_packages_supported || {
  printf 'Container platform is not in the automatic matrix: %s %s\n' "${OS_ID}" "${OS_VERSION_ID}" >&2
  exit 1
}
install_base_packages

for program in curl git; do
  command -v "${program}" >/dev/null 2>&1 || {
    printf 'Base package install did not provide %s\n' "${program}" >&2
    exit 1
  }
done

printf 'Bootstrap base packages installed on %s.\n' "${SUPPORTED_PLATFORM_LABEL}"
