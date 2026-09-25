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
- Basic local visual search and vehicle profiles
- Configurable application storage monitoring and guarded cleanup
- PostgreSQL 17 database with persistent Docker volumes

Private deployment tooling, host-level Docker or backup maintenance, fixed
camera workflows, experimental radar traffic correlation, AI-assistant routes,
and prototype TPMS screens are intentionally not included.

## Quick start

Requirements:

- x86-64 host
- Docker Engine
- Docker Compose
- Git
- Node.js 24
- A working Blue Iris ALPR configuration

Clone your copy of the repository and enter it:

```bash
git clone https://github.com/prsmith777/ALPR-Database-Community.git
cd ALPR-Database-Community
git checkout --detach v0.1.29
```

Run the guided fresh installer:

```bash
./alpr-community install
```

The installer verifies the exact release and canonical repository, checks the
host, free space, ports, and existing Docker resources, asks you to choose the
administrator password, and generates the database password automatically. It
creates new persistent directories, builds a commit-qualified image, starts an
empty PostgreSQL 17 database, and refuses to finish until the application is
healthy and the database is proven to contain no test data. It never overwrites
an existing installation. See [Fresh installation](docs/INSTALL.md) for the
complete prerequisites, non-interactive mode, validation, and recovery steps.

Install a stable release tag rather than deploying moving `main`. Starting
with v0.1.29, administrators can use **Settings → Software Updates** after a
one-time restricted host-agent setup:

```bash
./alpr-community agent install
```

The terminal maintenance menu remains available through `./alpr-community`.
Both interfaces use the same exact-tag updater, verified backup, automated
validation, manual acceptance, rollback, and one-generation retention policy.
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
[guided migration runbook](docs/MIGRATION_GUIDE.md). Its resumable assistant
records only redacted workflow state, stops at every destructive boundary, and
never switches traffic or deletes the retained source.

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
changes.

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
