# Native Windows installation

This implementation belongs to ALPR Database Community. Windows and Linux use
the same application, version, database schema, authentication, integrations,
and AI models. Their installation and maintenance operations differ.

The native Windows package requires no Docker or WSL. Tagged Community releases
produce stable installers; branch builds are marked preview. Download the
Windows setup executable and its checksum from the matching GitHub release.

## Targets and current evidence

| Target | Build/model evidence | Additional coverage |
| --- | --- | --- |
| Windows 10 22H2 x64, build 19045 | Supervised Pro VM installation, sign-in, Settings, LAN access and Blue Iris ingestion across reboot; corrected build `03fd2c65a7e7` independently observed on Release; new post-repair reads, overview crops, embeddings and a repeat-sighting comparison verified | Service ACL review, LAN disable check and other integrations |
| Windows 11 x64 | Supervised Home installation and reboot; protected service accounts, directory ACLs, owned application listener and loopback-only database verified; same-version repair, credential preservation, normal automatic startup and installed portable backup verified | Camera integration |
| Home, Pro, Enterprise, Education | Same desktop installer; no edition-specific feature dependency | Enterprise and Education have not been separately tested |

Windows Server, ARM64, 32-bit Windows, and LTSC certification are outside this
initial target. The installer rejects Server, ARM64, 32-bit PowerShell, older
Windows 10 builds, network shares, reparse-point roots, and non-NTFS volumes.
Windows 10 compatibility does not extend Microsoft's Windows 10 support period.

New installers use normal automatic startup with a PostgreSQL readiness check
and verify the actual Windows service configuration. WinSW 2.12 treats the
presence of its `delayedAutoStart` XML element as enabled, including text
`false`; new installers omit that element. Preview repairs clear the delayed
startup flag on the existing owned application service. The corrected build
`03fd2c65a7e7` passed supervised restarts on Windows 10 and Windows 11; both
HTTP health endpoints responded afterward. Windows 11 also had a newer boot
time and both services running. No fixed two-minute startup delay is required.

### Acceptance recorded October 6, 2026

For application source `03fd2c65a7e7`, all application/platform CI jobs passed,
including native model probes, packaged startup, sign-in, all 28 Settings
routes, synthetic ingestion/images and authenticated Live Feed shutdown.
The graphical installer build also passed compiled wizard-startup and
disposable uninstall-event probes. CI uses Windows Server and does not replace
the desktop checks above.

A supervised Windows 11 repair selected the corrected release, preserved
settings, administrator credentials and the API key, and refreshed the
installed backup launcher. The application service stopped in 0.27 seconds
and returned healthy in 3.39 seconds while PostgreSQL stayed running.

A portable backup exported by that installed build was restored into an empty,
disposable PostgreSQL 17 database. Source schema/count validation, 141 restored
tables, API-key preservation, session invalidation, unchanged source backup,
and refusal of an occupied target passed. That laptop backup contained no
images; separate logical migration fixtures covered image checksums.

A disposable installation using real packages was updated from
`0.1.46-fa4799b7d1fd` to `0.1.47-03fd2c65a7e7`, then rolled back. Real PostgreSQL,
application health and owned listeners passed. Rollback reverted a changed row
and settings, removed a row added after updating, and preserved password/API
key and image checksums. That earlier test used an owned-process adapter. A later isolated Windows 11
acceptance run used actual Windows SCM, WinSW, LocalService/NetworkService
accounts and service SID ACLs with the `0.1.47-68adb715bfcd` application. It
verified selected-release listener ownership through version upgrade and
transactional rollback, including restoration of changed rows and settings.
The same run removed both temporary services and reinstalled against retained
data. Password/API key, the original read, settings and image checksums, custom
ports and the network preference survived; a cold-cluster recovery backup was
verified before reinstall. Fixed service names were substituted in copied test
scripts so existing ALPR services were excluded; SCM itself was not mocked.

Windows 10 also received new post-repair Blue Iris reads with saved direction
labels and produced canonical overview crops, embeddings and review attributes.
One visually consistent vehicle seen in opposite directions ranked first at
69.6% cosine similarity, with a 40.15 percentage-point margin. This is one
functional comparison, not a general ReID accuracy benchmark or an automatic
identity decision.

An overnight availability check is optional and is not a release gate. It
cannot by itself establish memory stability or image-matching accuracy.

The release branch replaces Tailwind 3 with Tailwind 4 and resolves the
Next.js lint plugin's directory globbing to tinyglobby 0.2.17, removing
`braces` and `micromatch` from the dependency graph without disabling lint
rules or adding security exceptions. A compatibility test exercises the
plugin's actual root-directory discovery API. Next.js is updated to 15.5.27.
The build-only compiled NFT tracer is excluded from both standalone runtimes;
Windows packaging and the Linux runtime-image check reject its presence.
The dependency security gate passed after these changes. The same application
build was reported working on both Windows 10 and Windows 11. A subsequent
PostgreSQL concurrency gate found an image registration race between its two
unique constraints; untargeted conflict handling retains complete content and
metadata validation, and passed three guarded runs with eight simultaneous
duplicate registrations each.

The shared UI now requires Chrome/Edge 111 or newer or Firefox 128 or newer,
consistent with Tailwind 4's browser requirements. Current Chrome and Edge
on both Windows 10 and 11 meet this requirement.

## Graphical setup

The Windows setup executable is the user-facing installation path. It includes
the Community application, Node, WinSW, recognition models, and a graphical
password screen. Users do not need a terminal, Docker, WSL, or developer tools.

For a clean test computer:

1. Copy the maintainer-provided `ALPR-Community-...-Setup.exe` into Windows.
2. Double-click it and approve the Windows administrator prompt.
3. Choose **Start with an empty database**, or choose **Move an existing ALPR
   database and images** and select its verified migration backup folder.
   For migration, pause ingestion on the old installation before continuing.
4. Choose and confirm an ALPR administrator password, then click **Install**.
   Select **Allow access from other devices on my local network** if cameras
   or another computer will connect to ALPR.
5. Wait for setup to finish. Click **Finish** to open ALPR in the browser.
   Sign in with that password; leave the username blank on the initial login.

An internet connection is required. Setup downloads PostgreSQL 17.10 and FFmpeg
8.1.2 directly from their publishers using fixed versions and SHA-256 checksums.
It installs the Microsoft Visual C++ x64 runtime when needed, verifying its
checksum and Microsoft signature. If that component requires a reboot, restart
Windows and run setup again. PostgreSQL and FFmpeg are copied into the protected
application directory, so users do not need to maintain separate tool folders.

Setup checks the OS, package inventory, ports, and all three recognition models
before creating ALPR services or its database. Download/extraction scratch space
is private to the installer and removed when it exits. The chosen password is
passed through a private temporary file rather than a command-line argument.
Downloads show their actual percentage when the server supplies a size.
Extraction, database restore, service startup, and removal show animated progress
with the current operation because those steps have no reliable percentage.

An **ALPR Database Community** shortcut opens the application. Windows **Apps &
features** can remove the app and its services while preserving plate records,
images, settings, and backups in `C:\ProgramData\ALPR Community`. Run Setup again
and select **Restore the ALPR data already on this computer** to reconnect data
kept after uninstall. Setup selects this option automatically when protected
recovery metadata is present and program files have been removed. Existing
passwords, API key, image files, settings, ports and network preference are kept.
The password and migration pages are skipped for this mode.

Before recovery, Setup verifies ownership, local paths, PostgreSQL 17, a cleanly
stopped database and available ports. It refuses an older application version.
A checksum-verified cold database copy, authentication, settings and installation
metadata are kept under `management\reinstall-backups` before database migrations
or service registration. Allow free disk space for this backup. Images stay in
their existing storage directory. A failed setup preserves the data and backup
for diagnosis; do not delete either to work around an error.

For an existing installation, Setup selects **Update ALPR already installed on
this computer**. This creates a verified recovery backup, updates the application
in place, and enables **Settings → Software Updates**. Keep your existing password;
no uninstall, manual database export, or new API key is required. This mode
requires a newer application version and refuses unrelated services or data.

The setup executable is currently unsigned. Windows may show an unknown-publisher
or SmartScreen prompt. Verify the download against the published SHA-256 checksum.
Signing is separate from the preview/stable release channel.

The setup build executes a compiled startup probe before producing the installer.
It creates the real password controls and temporary workspace name, then exits
before installation. The probe includes no payload or installation actions and
requires no administrator privileges. It also runs on Windows Server CI without
changing the desktop OS requirements of the delivered installer. This catches
script runtime errors that successful Inno compilation alone cannot detect;
actual VM installation, service, reboot, and uninstall acceptance remain separate.

The setup build also installs and removes a disposable, non-elevated fixture
using the actual uninstall event handlers. It waits for Inno's second phase and
checks the log for runtime errors as well as checking file removal and retained
data. Regression coverage reproduces the former progress-window error after
removal, and checks that failed ownership or service-removal checks preserve
program files. Uninstall returns to normal file-removal progress before Inno
destroys the window; post-uninstall events do not access its controls.

The runtime test signs in with the chosen password and requests every Settings
page with the build checkout made unavailable. Release metadata uses a static
JSON import so the standalone bundle carries its version rather than resolving
package.json from the maintainer's machine.

### Supervised Settings repair

For an already-installed preview with the Settings packaging defect, a maintainer
can build a separate graphical repair from a verified fixed package and the exact
previous package:

~~~powershell
node scripts/build-windows-repair.mjs 'dist\FIXED_PACKAGE' 'dist\INSTALLED_PACKAGE'
~~~

Users double-click that repair executable, approve elevation, and click **Repair**.
It verifies the exact installed source commit and every target checksum, requires
an unchanged version, schema, and migration file, stages the new code, records the
previous protected installation metadata, and restarts only the application.
It preserves the password, configuration, images and database. It runs no schema
migration or database restore. A failed startup restores the previous application
selection and checks that its service owns the listener. Both code releases and
the protected repair record remain available. This supervised repair does not
replace the planned general upgrade, reinstallation, or repair workflow.

## Local network access

Localhost is the default. Selecting network access listens on all IPv4 interfaces
and creates one owned Windows firewall rule for the application port (normally
3000), TCP, with remote addresses restricted to `LocalSubnet` and edge traversal
blocked. It applies to all Windows network profiles so the same home network
works even when Windows labels it Public; it does not change that profile.
The database remains on loopback and no database firewall rule is created.
This option is for a local network; it does not set up internet access or HTTPS.

For an already-installed supervised preview, the maintainer can build the small
graphical tool with `node scripts/build-windows-network.mjs` from clean source.
It requires the original preview commit in Git history to pin the existing
uninstaller checksum. Users double-click `ALPR-Network-Access-...exe`, approve
elevation, leave **Allow other computers and cameras on my local network**
selected, and click **Apply**. The tool displays the addresses to open from
other devices. Choose **Only this computer** and apply again to disable access.

The tool verifies release checksums and service ownership under the shared
maintenance lock. It refuses pending updates and unexpected firewall rules,
preserves credentials and stored data, and restarts only the application.
It verifies health, process ownership and listener binding after the change.
If the change fails, it restores the previous binding and firewall state.
It also upgrades the exact original preview's uninstall script so uninstall
removes the owned LAN rule. No database migration or restore runs.

Automated tests use isolated fixtures and mocked service/firewall commands;
compiled wizard startup also runs without installation or elevation. Actual
desktop elevation, firewall enforcement and access from another LAN device
remain acceptance checks on Windows 10 and Windows 11.

## Build a preview

On Windows x64 with Node.js 24 and Yarn Classic:

~~~powershell
yarn install --frozen-lockfile --ignore-scripts
node scripts/install-openvino-runtime.mjs
yarn test
yarn typecheck
yarn lint
yarn test:sanitize
yarn package:windows --preview
yarn package:windows:setup --package 'dist\alpr-community-VERSION-COMMIT-windows-x64' --preview
~~~

Replace the setup command's package path with the directory printed by the native
package build. The setup builder downloads a checksum-pinned Inno Setup 6.7.3
compiler in portable mode into the build cache. It does not install a compiler
or ALPR services on the build machine. The output in `dist\setup` includes the
single setup executable, its SHA-256 sidecar, and a build record identifying the
payload commit and prerequisite pins. Build setup from the same clean source
commit as its native package.

Packaging always rebuilds the application and embeds the exact source commit
and preview/stable channel. Stable packages require a clean exact version tag.
The preview records its base commit and the checksums of all shipped files;
uncommitted development changes are explicitly labeled preview.

The output under dist contains the standalone app, the build's Node.exe,
checksum-pinned WinSW 2.12.0, native OpenVINO DLLs, all three AI models,
the installer, fixed service control, schema, migrations, and maintenance CLI.
The packaging gate runs CPU inference for detection, embedding, and attributes
using the final bundled Node.exe and loads Sharp, bcrypt, pg, and MQTT there.
Dependency licenses and third-party source links accompany the package.

The graphical installer acquires PostgreSQL and FFmpeg automatically. The
unwrapped native package also supports the operator workflow below with existing
prerequisites. Signed distribution and release asset publishing remain release
work.

## Operator installation from the native package

Use a clean test VM initially. Install PostgreSQL 17 command-line tools and an
FFmpeg distribution containing ffmpeg.exe and ffprobe.exe. Install the Microsoft
Visual C++ x64 runtime required by OpenVINO if its DLL loading probe reports it
missing. PostgreSQL's installer may create its own database service; ALPR creates
a separate cluster and service, defaulting to loopback port 5433.

Open a 64-bit PowerShell window in the verified package directory:

Extract the package into a short path, such as C:\ALPR-downloads. The installer
refuses file paths beyond inbox PowerShell's legacy path limit before mutation.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -CheckOnly -AllowPreview -FfmpegBin 'C:\Tools\ffmpeg\bin'
~~~

CheckOnly verifies OS, files, package hashes, prerequisites, unused installation
locations, available ports, and model inference. It does not initialize a
database, create directories, register services, or modify firewall rules.

This execution policy applies only to the installer process. It does not change
the machine or user policy.

After those checks pass, run the same command in an elevated PowerShell window
without CheckOnly. Use AllowPreview only for an explicitly trusted development
package. Verify a distributed package against its maintainer-provided checksum
before running any installer or bundled executable.

Defaults:

| Resource | Location |
| --- | --- |
| Application and replaceable releases | C:\Program Files\ALPR Community |
| Authentication/configuration/images/logs | C:\ProgramData\ALPR Community |
| Private database, backups, initial login | Data root\management |
| Application service | ALPRCommunityApp, LocalService with service SID |
| Database service | ALPRCommunityDatabase, NetworkService with service SID |
| Application listener | 127.0.0.1:3000 |
| Database listener | 127.0.0.1:5433 |

InstallRoot, DataRoot, PgBin, FfmpegBin, AppPort, and DatabasePort are configurable.
The release and data roots must be separate and unused. The app service has read
access to code and modification rights only on its own runtime directories.
Database files and rollback backups exclude the app service. Secrets are
generated locally and stored under protected NTFS ACLs, never in source.

The app uses normal automatic startup with a dependency on the database service.
Its launcher immediately tests an authenticated, read-only PostgreSQL query and
starts ALPR as soon as that succeeds. A failed check is retried once per second,
with connection/query timeouts and a total startup budget of 60 seconds. Failure
exits the launcher so Windows can retry the application service after 10 seconds.
Stopping during readiness cancels the wait without launching ALPR. There is no
unconditional boot delay.
WinSW sends Ctrl+C and allows 60 seconds for Next.js to shut down. Application/service
logs and PostgreSQL logs have bounded rotation. Initial administrator login is
saved in management\initial-login.txt, accessible to Administrators; store the
password and delete that file after first sign-in.

Localhost is the default. `ListenOnNetwork` deliberately changes the app listener
to `0.0.0.0` and creates the local-subnet application firewall rule described
above. Network access requires this explicit installer selection. An operator
must separately configure HTTPS and access controls for use beyond a local LAN.

A failed install stops only services it registered and preserves its data and
private installer-error.txt for diagnosis. It does not delete an existing
installation or database. CheckOnly refuses an already-used installation.

## Native maintenance

Starting with v0.1.48, Windows uses the shared **Settings → Software Updates**
workflow:

1. Select **Check for updates** and review the stable Community release.
2. Confirm **Install** for that version. ALPR downloads and verifies its Windows
   package while the current application keeps running, then pauses ALPR to
   create and verify a recovery backup before migrating and restarting.
3. Leave the page open; it reconnects after restart. Complete the real-use checks
   and select **Accept update**. Rollback remains available with an explicit
   warning that it discards writes made after the backup.

Older installations need to run the latest graphical installer (v0.1.49 or newer) once
using its existing-installation update option. Fresh installs include the updater.
An offline updater is reported on the page, with Windows-specific instructions.

`ALPRCommunityUpdater` runs separately from the application, starts automatically
at boot, and continues publishing progress while the application is stopped.
Only authenticated ALPR administrators can submit browser requests. The service
accepts the same fixed operations and exact confirmations as Linux; requests
cannot specify executables, command arguments, download URLs, or filesystem paths.
Code, backups, updater logs, locks, and claimed requests are protected from the
application account. Its inbox permits request-file creation but no subdirectories;
the application can read service-owned status and heartbeat files.

Only newer, published, stable releases from this Community repository are accepted.
Windows update ZIPs and metadata have GitHub-provided SHA-256 digests; metadata
also pins the source tag's commit, package manifest, and archive. Downloads are
bounded and restricted to GitHub HTTPS hosts. Extraction rejects traversal,
links, case collisions, and oversized archives before writing package files.
The complete package is checked and its native models probed before stopping ALPR.

When migration or technical validation fails, the UI updater attempts verified
automatic rollback. Writes during an unsuccessful update may be discarded.
Private recovery records allow interrupted operations to be recovered after a
service restart without replaying the original install request. A live maintenance
process is never replaced. Preserve all data and recovery files if recovery fails.

Accepted backups are kept for at least 14 days. A subsequent update archives the
previous backup record without deleting its files, so another release does not
require uninstalling or manually discarding a recovery copy. The current update
must still be accepted or rolled back before another installation.

Maintainers publish the `ALPR-Community-VERSION-Windows-x64-Update.zip` and `.json`
assets generated by `yarn package:windows:update --package VERIFIED_PACKAGE`
alongside the graphical installer. These assets are required before publishing
the release; preview packages are refused by browser discovery.

For administrator troubleshooting, local maintenance commands remain available
from an elevated PowerShell window:

~~~powershell
$env:ALPR_WINDOWS_INSTALLATION = 'C:\Program Files\ALPR Community\installation.json'
$node = 'C:\Program Files\ALPR Community\runtime\node.exe'
$maintenance = 'C:\Program Files\ALPR Community\host\windows-maintenance.mjs'
& $node $maintenance status
~~~

A Windows update requires an already-extracted, newer, trusted package and the
independently obtained SHA-256 of its windows-package.json. It verifies every
file and stages/probes the package before stopping the existing app.

~~~powershell
$env:ALPR_UPDATE_ACKNOWLEDGE = 'ALPR_UPDATE_APPROVED'
& $node $maintenance update --package 'C:\ALPR-downloads\verified-package' --manifest-sha256 'MAINTAINER_PROVIDED_64_HEX_MANIFEST_HASH'
& $node $maintenance validate
~~~

The update records a custom-format PostgreSQL dump, dump checksum, exact table
counts, auth/configuration checksums, and each stored image's checksum before
migration. Auth/configuration and images stay outside releases. Technical checks
require healthy startup, the target version/commit, nondecreasing table counts,
and preservation of every pre-update stored image.
The controller also verifies the Windows service process tree and TCP listener
owner against the target release's Node.exe.

After verifying sign-in, search, ingestion, images, integrations, and restart:

~~~powershell
$env:ALPR_UPDATE_ACCEPTANCE = 'ALPR_UPDATE_ACCEPTED'
& $node $maintenance accept
~~~

Rollback discards database writes made after the pre-update dump. Confirm that
decision before setting its acknowledgement:

~~~powershell
$env:ALPR_UPDATE_ROLLBACK = 'ALPR_UPDATE_ROLLBACK'
& $node $maintenance rollback
~~~

Rollback verifies the dump/private files before stopping the app, restores the
public schema in one PostgreSQL transaction, preserves native directory ACLs,
restores auth/configuration and installation metadata, selects the previous
release, and checks exact table counts and retained images.

The local CLI requires cleaning the previous generation before another update.
The UI preserves that generation separately, as described above. Cleanup removes
only updater-owned recovery artifacts; it leaves releases and live data in place.

~~~powershell
$env:ALPR_UPDATE_CLEANUP = 'ALPR_UPDATE_CLEANUP'
& $node $maintenance cleanup
~~~

A failed backup restarts the existing app when possible. Local CLI updates require
explicit validation or rollback after migration failure; browser updates also
attempt automatic recovery. Concurrent maintenance is refused. Do not delete
maintenance locks or backup state while a process may still be running.

## Cross-platform import

The graphical setup imports a portable **folder**, containing:

- `postgres.dump` and its source-schema, PostgreSQL-version, row-count, and
  SHA-256 verification manifest;
- `storage/images`, `storage/thumbnails`, and `storage/derived`, where present;
- optional `config/settings.yaml` and `auth/auth.json`;
- `migration-backup.json`, sealing the exact file inventory and checksums.

Supported sources match the Linux wizard: Original ALPR v0.1.9-compatible or
Community v0.1.20 and later, on PostgreSQL 13 or 17. Unknown schemas, links,
Windows-invalid filenames, changed backups, and existing destination data are
refused. Copy the entire completed folder to Windows, including the manifests.
Do not copy PostgreSQL's physical data directory between operating systems.

### Create the backup on Linux

This step is performed by the source administrator. Keep the original database
and storage, stop its ALPR app, ingestion, jobs, and other writers, and leave
PostgreSQL running. Use a separate current Community checkout with Node.js 24
and PostgreSQL 17 client tools. Confirm the actual source endpoint and mounted
storage/config/auth paths before running the export. The database password
must be supplied privately through the environment, never in a command argument.

~~~bash
export ALPR_MIGRATION_SOURCE_HOST='SOURCE_DATABASE_HOST'
export ALPR_MIGRATION_SOURCE_PORT='SOURCE_DATABASE_PORT'
export ALPR_MIGRATION_SOURCE_DATABASE='postgres'
export ALPR_MIGRATION_SOURCE_USER='postgres'
read -rsp 'Source database password: ' ALPR_MIGRATION_SOURCE_PASSWORD; echo
export ALPR_MIGRATION_SOURCE_PASSWORD
export ALPR_MIGRATION_SOURCE_SSLMODE='prefer'
export ALPR_MIGRATION_SOURCE_QUIESCED='ALPR_SOURCE_QUIESCED'
export ALPR_MIGRATION_DUMP_PATH='/PRIVATE_BACKUP_PARENT/postgres.dump'
node scripts/postgres-major-migration.mjs dump
node scripts/community-migration-bundle.mjs create \
  --dump "$ALPR_MIGRATION_DUMP_PATH" \
  --storage '/ABSOLUTE_SOURCE_STORAGE' \
  --config '/ABSOLUTE_SOURCE_CONFIG/settings.yaml' \
  --auth '/ABSOLUTE_SOURCE_AUTH/auth.json' \
  --output '/PRIVATE_BACKUP_PARENT/alpr-windows-migration'
unset ALPR_MIGRATION_SOURCE_PASSWORD
~~~

Use a new, private backup parent outside the checkout. Replace the endpoint and
absolute path placeholders; omit `--config` or `--auth` only when that file does
not exist. If the Linux app uses `BLUEIRIS_*` environment overrides, supply those
same effective values privately to the bundle command so its connection and
password are preserved. Supply the source's IANA `TZ` value to preserve its
installation time zone. The Linux `.env` and old database credentials are not
copied into the Windows installation. Treat the completed backup as private:
it contains plate data, credentials, integration keys, and password hashes.

### Create the backup on Windows

On a native installation that includes this feature, open **ALPR Migration
Backup** from Start, approve elevation, choose the backup location, and confirm
the brief ingestion pause. The tool stops the owned ALPR service, creates and
verifies the dump and file bundle under the shared maintenance lock, and restarts
the source service. Before importing elsewhere, pause source ingestion again.
Never run both targets as live ingestion destinations during the move.

### Restore and cut over

Run Setup on a fresh Windows target. Select **Move an existing ALPR database and
images**, choose the completed backup folder, and confirm source ingestion is
paused. Choose the destination administrator password and network access.
Setup stages and re-verifies the folder before creating its local database.

Import restores the dump transactionally, checks exact table inventories/counts
and source schema before upgrading, applies current migrations, and validates
record preservation using the normal native ReID retirement policy. It copies
and checks image hashes, normalizes legacy display paths, and refuses missing
referenced image files. Stored integration keys and named accounts are preserved;
the setup administrator password becomes the one chosen in Setup. Old browser
sessions are invalidated. Windows owns fresh database credentials and NTFS ACLs.
ALPR starts only after validation. A failed import preserves target data and its
private `management/migration-state.json` diagnostic without starting the app.

Check sign-in, representative images, reads/tags, camera settings, and a controlled
new ingestion on Windows. Review integration destinations before permitting
notifications. Switch Blue Iris's ALPR destination only after those checks;
keep the Linux source and backup until you have accepted the Windows installation.
The Windows import does not change the Linux system or switch camera traffic.
Records written to Windows after cutover are not present in the old Linux source.

## Release acceptance gates

For BOTH a clean Windows 10 22H2 x64 VM and a maintained Windows 11 x64 VM:

1. Install with unused paths, including paths containing spaces. Confirm
   non-admin prerequisite checking, invalid-platform refusal, dependency
   failure refusal, and port-conflict refusal before mutation.
   Exercise the graphical setup with a normal Windows account, administrator
   elevation, chosen-password login, component downloads, cancellation,
   restart-required handling, shortcuts, and uninstall with retained data.
2. Verify app and database service accounts, service SIDs, NTFS ACL inheritance,
   protected secrets/backups, and absence of write access to code from the app.
3. Reboot; confirm database/app startup order, health, and graceful stop/restart.
   Enable local network access and verify signed-in use from another device;
   disable it and verify remote refusal with localhost still working. Confirm
   uninstall removes only the owned firewall rule and preserves stored data.
4. Sign in and ingest synthetic reads with images. Exercise search, dashboard,
   exports, all three AI models, and file/media retrieval.
5. Exercise a real Blue Iris camera, MQTT, and FFmpeg timeline export against
   operator-authorized test endpoints. Validate a Linux-to-Windows logical import.
6. Apply a newer Windows package. Verify backup, migration, acceptance/retention,
   corrupted-package refusal, interrupted backup, migration/start failure,
   transactional rollback, and preservation of protected data.
7. Pass the unchanged Linux CI and Docker runtime gates.

Windows CI provides build/unit/package evidence; its Windows Server runner does
not replace either desktop VM acceptance target. Do not publish a certified
Windows installer until these gates have recorded results.

## Isolated Windows service acceptance

Run `scripts/test-windows-scm-runtime.mjs` in an elevated Windows desktop session
with a new package, an actual prior-version package, PostgreSQL 17 binaries,
FFmpeg binaries and an output JSON path. The test copies installer scripts into
a UUID-owned fixture and substitutes only fixed service identifiers. It uses
actual SCM, WinSW, LocalService and NetworkService accounts, service SID ACLs,
random loopback ports, protected installation metadata and the production
controller for start/stop and listener attestation. Working ALPR services and
data are excluded. It exercises version upgrade, transactional rollback,
uninstall, retained-data reinstall, password/API-key and settings preservation,
image checksums and verified recovery backups. Failed fixtures are kept for
diagnosis; cleanup checks service executable ownership before removing them.

### Retrying an interrupted Windows update

Use graphical Setup v0.1.49 or newer and keep the existing installation and data. A verified complete release copy is reused; an incomplete copy is preserved in the private releases directory before a replacement is prepared. Setup stops on reported update errors and requires the expected release and its owned running listener before showing completion. Do not treat the version in the setup window title alone as proof that the application was updated; verify Settings → Release afterward.
