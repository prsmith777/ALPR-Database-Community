# Host compatibility and recovery paths

ALPR Database Community is supported on Linux x86-64. The automatic package
installer has a deliberately narrower first release so that package names,
repositories, service control, and rollback behavior are predictable.

| Host situation | Supported path |
| --- | --- |
| New Ubuntu Server 24.04 LTS x86-64 | Run the automated bootstrap in new-install mode. |
| Existing ALPR moving to a new Ubuntu 24.04 VM | Run migration preparation on the new VM, then use the guided migration. This is the recommended migration path. |
| Existing ALPR already on Ubuntu 24.04 x86-64 | Run the read-only migration compatibility check first. In-place preparation is possible only when it passes, but a separate target remains safer. |
| Other x86-64 Linux distribution | Run the read-only check. Install equivalent prerequisites manually, then use the exact-tag installer or migration assistant. Automatic package changes are not performed. |
| Older Ubuntu release | Prefer a new Ubuntu 24.04 VM. Manual operating-system and dependency upgrades are operator-owned and must pass the compatibility check afterward. |
| Native Windows Docker, WSL controlling Windows Docker, or appliance container UI | Not supported by the current installer/updater. Use an Ubuntu 24.04 x86-64 VM. |
| ARM/AArch64 | Not currently supported. |

## If a compatibility check fails

The check does not repair or modify the host. Read the reported failures and
choose one of these paths:

1. Create a supported Ubuntu 24.04 x86-64 destination VM and rerun the
   bootstrap. This is the lowest-risk choice.
2. On another x86-64 Linux distribution, manually install Docker Engine,
   Compose v2, Buildx, Git, and Node.js 24. Migration hosts also need
   PostgreSQL 17 clients, `rsync`, and OpenSSH. Rerun the check before ALPR.
3. Upgrade the guest operating system and dependencies using that
   distribution's documented process, then rerun the check. Back up the host
   first; ALPR does not automate operating-system upgrades.

Do not remove or replace an existing Docker installation merely to satisfy the
bootstrap. It deliberately refuses conflicting packages and leaves that
decision to the host operator.

## Runtime components versus host tools

The host runs Git, Node.js 24, Docker Engine, Compose, and Buildx. PostgreSQL 17
client utilities are host requirements only for database migration. The ALPR
application, PostgreSQL server, OpenVINO 2025.4 runtime, ReID code, and pinned
models run inside versioned Docker images. Optional Blue Iris, MQTT, email,
Pushover, and webhook connections require credentials and endpoints in
Settings, but no additional ALPR host packages.

## Capacity guidance

The enforced bootstrap floor is 2 logical CPUs, 4 GiB RAM, and 20 GiB free
before application data. For normal use, allocate at least 4 vCPU, 8 GiB RAM,
and 100 GiB disk. Image retention, database growth, and backup policy determine
long-term storage needs. Heavy visual search or large image libraries may need
more CPU, RAM, and disk.
