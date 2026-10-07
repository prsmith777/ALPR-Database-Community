# ALPR Database Community

ALPR Database Community is a self-hosted web application for collecting,
reviewing, searching, and automating license-plate recognition events from Blue
Iris and CodeProject AI Server.

This repository is the clean-history Community edition. It contains no prior
Git history, deployment credentials, production data, personal screenshots, or
operator-specific infrastructure configuration.

## Features

- Authenticated multi-user dashboard with role-based access
- Plate ingestion through API-key-protected integration endpoints
- Searchable recognition history, corrections, tags, and known vehicles
- Live recognition feed and CSV/JSON exports
- MQTT, Pushover, email, and signed webhook notifications
- Blue Iris playback links and optional image retrieval
- Native ReID V2 vehicle similarity search, evidence-backed profiles, and automatic image analysis
- Configurable application storage monitoring and guarded cleanup
- PostgreSQL 17 with persistent data on native Windows or Docker Compose on Linux

For slow Recognition Feed records after an import, see
[feed performance and troubleshooting](docs/REID_FEED_PERFORMANCE.md).
Community uses ReID V2 exclusively. Whole-vehicle images are processed in the
background; no identity-mode selection or conversion campaign is needed.
See [Vehicle identity and upgrades](docs/VEHICLE_IDENTITY.md).

Private deployment tooling, host-level Docker or backup maintenance, fixed
camera workflows, experimental radar traffic correlation, AI-assistant routes,
and prototype TPMS screens are intentionally not included.

## Quick start

### Windows 10 and Windows 11

Native Windows is available in stable Community releases. On **Windows 10 22H2
x64 (build 19045)** or **Windows 11 x64**, open the
[latest stable release](https://github.com/prsmith777/ALPR-Database-Community/releases/latest)
on the computer or VM where ALPR will run. Under **Assets**, download
`ALPR-Community-VERSION-Windows-x64-Setup.exe`, run it, and choose the fresh-install,
migration, retained-data recovery, or existing-installation update option.
Setup installs prerequisites and starts ALPR automatically; Docker, WSL and
developer tools are not required. An existing installation keeps its password,
API key, records, images and settings.

Follow the **[step-by-step Windows installation guide](docs/WINDOWS_INSTALL.md)**
for setup choices, first sign-in, access from another computer, backups and
Linux-to-Windows migration. After installation, use **Settings → Software Updates**
for later releases. [Native Windows maintenance](docs/WINDOWS_NATIVE.md) covers
technical details and recovery.

### Linux

For the simplest Linux path, start with Ubuntu Server 24.04 LTS x86-64,
internet access, and a normal account with `sudo`. The automatic bootstrap also
supports selected maintained Ubuntu, Debian, RHEL, Rocky Linux, AlmaLinux,
CentOS Stream, and Fedora releases listed in
[Host compatibility](docs/COMPATIBILITY.md). Copy the complete block below into
the new Linux system. It verifies the latest release before starting the guided
new-installation process:

```bash
alpr_bootstrap() (
  set -Eeuo pipefail
  command -v curl >/dev/null || {
    if command -v apt-get >/dev/null; then sudo apt-get update && sudo apt-get install -y curl
    elif command -v dnf >/dev/null; then sudo dnf -y install curl
    else echo "Install curl with this distribution's package manager first." >&2; exit 1; fi
  }
  release_url="$(curl -fLsS -o /dev/null -w '%{url_effective}' \
    https://github.com/prsmith777/ALPR-Database-Community/releases/latest)"
  release_tag="${release_url##*/}"
  [[ "${release_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
  download_dir="$(mktemp -d)"
  trap 'rm -rf -- "${download_dir}"' EXIT
  asset_base="https://github.com/prsmith777/ALPR-Database-Community/releases/download/${release_tag}"
  curl -fLsS --retry 3 "${asset_base}/alpr-community-bootstrap.sh" -o "${download_dir}/alpr-community-bootstrap.sh"
  curl -fLsS --retry 3 "${asset_base}/alpr-community-bootstrap.sh.sha256" -o "${download_dir}/alpr-community-bootstrap.sh.sha256"
  (cd "${download_dir}" && sha256sum --check --strict alpr-community-bootstrap.sh.sha256)
  bash "${download_dir}/alpr-community-bootstrap.sh" --release "${release_tag}" "$@"
)
alpr_bootstrap --new
unset -f alpr_bootstrap
```

The bootstrap labels each stage, installs and validates Git, Docker Engine,
Compose, Buildx, and a private Node.js 24 runtime, then checks out the newest
exact stable release. The guided installer explains each prompt, retries
invalid entries, asks you to choose the administrator password, and generates
the database password automatically. Press Enter to accept displayed defaults.
It creates new persistent directories, builds a commit-qualified image, starts
an empty PostgreSQL 17 database, and refuses to finish until the application is
healthy and the database is proven to contain no test data. It never overwrites
an existing installation. OpenVINO, ReID, and the visual models are already in
the image and are verified with real CPU inference during the build. The first
image build and model verification can take several minutes; leave the terminal
open until it prints **installed successfully** and the browser address. See
[Automated bootstrap](docs/BOOTSTRAP.md),
[Host compatibility](docs/COMPATIBILITY.md), and
[Fresh installation](docs/INSTALL.md) for all paths and recovery steps.

Migrating an existing ALPR system is a separate workflow. Start with the
[automated migration guide](docs/MIGRATION_GUIDE.md); do not use the new-install
command above for an existing database.

Install a stable release tag rather than deploying moving `main`. Starting
with v0.1.29, administrators can use **Settings → Software Updates**. Fresh
Linux installations and activated migration targets from v0.1.53 set up the
restricted helper automatically on systemd hosts, including startup after reboot.
Existing matching helpers are preserved. For an older installation or recovery,
run this as the installation owner:

```bash
./alpr-community agent install
```

**Upgrading from v0.1.43 or earlier:** use the [one-time native-update recovery
launcher](docs/UPDATES.md#one-time-upgrade-from-v0143-or-earlier). Do not retry the
native transition through an already-loaded older updater.

The terminal maintenance menu remains available through `./alpr-community`.
Both interfaces use the same exact-tag updater, verified backup, Technical
system checks, separate real-use acceptance, rollback, and one-generation
retention policy. After installation and Technical system checks finish, the
administrator must complete the five checks shown on the page and select
**Accept update** before another release can be installed.
Image builds retry bounded transient OpenVINO download failures. A failure
before database migration automatically restores the exact previous release
and app without replacing the unchanged database.
The web container never receives the Docker socket or arbitrary host command
access.

The guest operating system and Docker environment determine compatibility;
the physical server or hypervisor does not. This supports ordinary Linux hosts
and Linux VMs on platforms such as Proxmox, VMware, Hyper-V, VirtualBox,
Unraid, TrueNAS, and others. See [Community updates](docs/UPDATES.md) for the
safety checks, one-generation rollback policy, platform boundary, and
non-interactive commands.

Open the address printed by the installer. For the first sign-in, leave the
username blank and use the administrator password you chose. The generated
database password stays in the private `.env` file and is not a login password.
Then create a named administrator under Settings and configure Blue Iris.

See [Community deployment](docs/DEPLOYMENT.md) for persistent storage,
guarded PostgreSQL 13 or 17 database import, image-storage transfer, external
database configuration, validation, and rollback guidance. Original ALPR
Database imports use the pinned v0.1.9 database schema as their supported
baseline; the preflight rejects unknown or partially updated schemas before it
creates a dump.

Existing-system operators should begin with the
[automated migration runbook](docs/MIGRATION_GUIDE.md). The resumable wizard
creates a separate target, performs the guarded dump/restore, copies and
checksums local or SSH image storage, and starts an outbound-isolated target
for browser review. It stores no passwords in state and never stops, switches,
or deletes the retained source.

## Blue Iris ingestion

Send ALPR JSON to `/api/plate-reads`. Authenticate with either of these HTTP
headers:

```http
x-api-key: YOUR_API_KEY
Authorization: Bearer YOUR_API_KEY
```

Do not put credentials in a URL or query string. A typical Blue Iris alert body
can use the built-in macros:

```json
{"ai_dump":&JSON,"Image":"&ALERT_JPEG","camera":"&CAM","ALERT_PATH":"&ALERT_PATH","ALERT_CLIP":"&ALERT_CLIP","timestamp":"&ALERT_TIME","trigger_type":"&TYPE"}
```

## Development

The project uses Node.js 24 and Yarn 1:

```bash
corepack yarn install --frozen-lockfile
yarn test
yarn test:sanitize
yarn lint
yarn build
```

The sanitation check rejects private-network literals, audited sensitive
paths, runtime data, database dumps, and private-only feature paths.

## Project status

The sanitized clean-history Community repository is public. Install supported
stable builds from [GitHub Releases](https://github.com/prsmith777/ALPR-Database-Community/releases)
rather than deploying moving `main`. See the
[Community product roadmap](docs/COMMUNITY_PRODUCT_ROADMAP.md) for the current
release boundary and later work, and the [changelog](CHANGELOG.md) for shipped
changes. Maintainers should use the
[release documentation checklist](docs/RELEASING.md) so the versioned manual,
roadmap, install and migration guidance, GitHub forms, and release assets stay
synchronized.

## Support and feedback

Start with the [documentation wiki](https://github.com/prsmith777/ALPR-Database-Community/wiki)
for installation, backups, migration and troubleshooting links. Detailed guides
remain versioned in this repository and in the in-app Help Center.

- [Ask a question or leave general feedback](https://github.com/prsmith777/ALPR-Database-Community/discussions)
  in GitHub Discussions.
- [Report a reproducible bug](https://github.com/prsmith777/ALPR-Database-Community/issues/new?template=bug_report.yml)
  with the guided form.
- [Request a feature](https://github.com/prsmith777/ALPR-Database-Community/issues/new?template=feature_request.yml)
  after reviewing the Community roadmap.
- [Report a security vulnerability privately](https://github.com/prsmith777/ALPR-Database-Community/security/advisories/new).

Issues and discussions are public. Remove credentials, real license plates,
camera images, private addresses, and other identifying data before posting.
See [Contributing and getting help](CONTRIBUTING.md) for the full reporting and
sanitization guidance.

## Security and privacy

- Keep `.env`, `auth/`, `config/`, `storage/`, logs, and database backups out of
  source control.
- Rotate any credential that may have appeared in an earlier public history.
- Review retained images before sharing diagnostics or screenshots.
- Use HTTPS and `SESSION_COOKIE_SECURE=true` when the application is exposed
  through a TLS reverse proxy.

See [security baseline](docs/security-baseline.md) for authentication and
failure-handling details.

## License

See [LICENSE](LICENSE).
