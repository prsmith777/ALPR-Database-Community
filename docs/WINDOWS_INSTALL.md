# Install ALPR on Windows

ALPR Database Community runs natively on **Windows 10 22H2, 64-bit (build
19045)** and **Windows 11, 64-bit**. The same Community application runs on
Linux. Windows Setup installs the application and required components and
starts ALPR automatically after Windows boots. You do not need Docker, WSL,
Python, Node.js, or a terminal to use the installer.

## Before you start

- Use an x64 Windows computer or VM, a local NTFS drive, an internet connection,
  and a Windows account that can approve an administrator prompt.
- Use a current Chrome, Edge, or Firefox browser. Home and Pro installations
  have been exercised; Enterprise and Education have no separate edition
  dependency but have not been tested separately. Windows Server, ARM64,
  32-bit Windows, and LTSC are outside the supported target.
- Keep enough free disk space for your image library and a recovery backup as
  it grows. A VM works normally; its guest needs access to the cameras and
  other configured integrations.
- Decide whether you want a fresh database, a move from another computer, an
  update, or recovery of data retained after uninstalling.

Windows 10 compatibility does not extend Microsoft's Windows 10 support period.

## Download and install

1. Open the [latest stable Community release](https://github.com/prsmith777/ALPR-Database-Community/releases/latest)
   **inside the Windows computer or VM where ALPR will run**.
2. Under **Assets**, download `ALPR-Community-VERSION-Windows-x64-Setup.exe`,
   where `VERSION` is the release number. The **Source code** downloads and
   Windows **Update.zip** are not the graphical installer. The matching
   `.sha256` file is available to verify your download.
3. Open the downloaded Setup file and approve the Windows administrator prompt.
   If Windows requests an administrator account, use that account's Windows
   credentials. These are separate from the ALPR password chosen below.
4. On **Choose how to start**, select the option that matches your situation:

   | Your situation | Setup option |
   | --- | --- |
   | First installation with no old data to import | **Start with an empty database** |
   | Moving a verified backup from Linux or another Windows computer | **Move an existing ALPR database and images** |
   | ALPR was uninstalled and its data remains on this computer | **Restore the ALPR data already on this computer** |
   | ALPR is already installed on this computer | **Update ALPR already installed on this computer** |

5. On **Connection ports**, normally keep **Application port: 3000** and
   **Local database port: 5433**. If an existing Docker ALPR uses 3000 on this
   computer, choose an unused application port such as **3001**. Choose another
   unused database port if 5433 is occupied. Setup checks both before installing;
   it does not automatically renumber them. Updates and retained-data recovery
   preserve their saved ports and skip this page.
6. For a fresh installation or migration, choose an ALPR administrator password
   of **12–128 characters** and confirm it. Save it in your password manager.
   Updates and retained-data recovery keep the existing ALPR password and skip
   this page.
7. For a fresh installation or migration, select **Allow access from other
   devices on my local network** if Blue Iris, a camera, or another computer
   will connect. Leave it off for use only on this computer. An update or
   retained-data recovery preserves the previous network preference.
8. Continue through Setup and wait until it reaches **Finish**. It downloads
   verified prerequisites, checks the recognition models, creates the services,
   and verifies the running application. If a prerequisite requests a Windows
   restart, restart Windows and run Setup again.
9. Leave **Open ALPR** selected and click **Finish**. The desktop shortcut also
   opens ALPR at your selected application port. The default local address is
   `http://localhost:3000`; a selection of 3001 opens `http://localhost:3001`.

The current installer is unsigned, so Windows may identify an unknown publisher.
Use the official release and its checksum. If antivirus blocks a file, retain
the product's warning and the exact filename for support; keep antivirus enabled.

## Keep Docker ALPR while verifying native Windows

On the same Windows computer, keep Docker's web/API mapping at 3000 and choose
3001 (or another unused port) for native Community in Setup. Keep the new local
database port at 5433 unless it is occupied. Community creates a separate
PostgreSQL 17 cluster at
`C:\ProgramData\ALPR Community\management\postgres`; the application code
is under `C:\Program Files\ALPR Community` and private data is under
`C:\ProgramData\ALPR Community`.

Import a **verified logical migration backup**, including images and manifests,
using **Move an existing ALPR database and images**. Do not copy a PostgreSQL
13 physical data directory into PostgreSQL 17. Pause source ingestion for the
backup and migration as directed by the backup guide. Importing does not change
the source Docker database, containers, volumes, ports or Blue Iris URLs.

After import the databases are independent; later records are not synchronized.
Verify the native installation at `http://localhost:3001` (or the computer's
LAN address with that port) before changing camera traffic. For a controlled
ingestion test, point only the intended Blue Iris destination at the new
application port and use the native installation's API key. Keep the old
installation and backup until you accept the migration. See the
[migration guide](MIGRATION_GUIDE.md) for supported source versions and export.

## Change the application port later

On native Windows, open **Settings → General → Windows connection port**.
Enter an unused port from 1024 through 65535 and select **Change port and
restart**. Finish any pending software update first. ALPR checks for conflicts,
keeps the existing local-network preference, adjusts its owned firewall rule
and shortcuts, restarts and verifies the listener. A failure or interrupted
change restores the previous port.

Use **Open ALPR at the new address** after the restart and update every Blue
Iris destination URL to the new port. The API key and local database connection
stay the same. If the setting says it needs activation after an update from an
older release, restart Windows once; graphical Setup starts the new updater
automatically. Database fields marked **Managed by Windows Setup** are
read-only protected service settings, not a request to edit a Linux .env file.

## First sign-in and camera setup

1. During first-time setup, leave **Username** blank and enter the **ALPR
   administrator password you chose in Setup**. An existing named account
   continues to use its username and password. The database password is not
   a browser login password.
2. Open **Settings → Release** and confirm the version matches the release you
   installed. A new database has no sample plates or camera images.
3. Configure Blue Iris and other integrations using **Help → User Guide**.
   Obtain the ingestion API key under **Settings → Security** and configure the
   sender to use it. Updates keep this key; regenerate it only when you intend
   to replace it on every sender.
4. For another computer or Blue Iris, use the ALPR computer's LAN address and
   configured application port. `localhost` always refers to the computer
   using the browser, so it cannot reach a different VM. See
   [network access](WINDOWS_NATIVE.md#local-network-access).
5. For vehicle direction and ReID, save the camera's front/rear direction
   profile first, then configure the recorded whole-vehicle source for each
   direction in **Settings → Vehicle Setup**. This can be the LPR camera or
   an overview camera. Save timing offsets and tolerances and use the frame
   diagnostics to verify the selected vehicle. Plate-only images cannot supply
   usable whole-vehicle ReID evidence. See [vehicle identity](VEHICLE_IDENTITY.md).

## Update an existing Windows installation

Open **Settings → Software Updates**, select **Check for updates**, review the
stable version, and confirm **Install**. Leave the page open while it reconnects
after the application restarts. Complete the listed real-use checks and select
**Accept update**. This completes the current update so the next can be installed.

The updater creates and verifies a recovery backup automatically. You do not
need to uninstall ALPR, export a migration backup, or replace the API key for
each update. Keep separate periodic backups for disaster recovery. Rollback
returns to the pre-update snapshot and discards records written afterward.

If **Software Updates** says the Windows update service is unavailable, use
the latest graphical Setup once and select **Update ALPR already installed on
this computer**. This preserves the existing data and enables the service.
Keep all existing data and recovery copies if an update reports an error.
See [Windows maintenance and recovery](WINDOWS_NATIVE.md#native-maintenance).

## Back up or move your data

Open **ALPR Migration Backup** from Windows Start, approve the administrator
prompt, choose a private backup location, and confirm the brief ingestion
pause. ALPR creates and verifies a portable backup folder and restarts its
service. Keep the **entire folder**, including its manifests. Store it on a
separate disk or another protected destination. It contains private records,
images, settings, and authentication data.

For a move from Linux, have the source administrator create the verified
portable folder using the [Linux backup procedure](WINDOWS_NATIVE.md#create-the-backup-on-linux).
Copy the entire completed folder to Windows; a SQL dump alone is not the
complete installer migration bundle. PostgreSQL's physical database directory
cannot be copied between operating systems.

On a new Windows target, select **Move an existing ALPR database and images**,
choose the folder containing `migration-backup.json`, and confirm that source
ingestion is paused. Verify sign-in, existing records, representative images,
settings, and a controlled new read before changing the Blue Iris destination.
Retain the old installation and backup until you accept the move. The installer
does not shut down the source or switch camera traffic for you.

## If something does not work

- **ALPR does not open:** allow the services to finish starting, then reopen the
  desktop shortcut. Services use normal automatic startup and database
  readiness checks; there is no fixed two-minute delay.
- **It opens locally but not from another computer:** check the ALPR computer's
  current LAN address, application port, and saved network-access preference.
  Follow the network guide rather than opening the PostgreSQL port.
- **Setup finishes but the old version is displayed:** reload **Settings →
  Release** on the target computer. Keep the setup log and existing backup if
  it still shows the old build. The installer window's title alone does not
  establish the running version.
- **Backup or update fails:** keep the existing installation, data, recovery
  folders, and indicated support log. Use the [recovery guide](WINDOWS_NATIVE.md#retrying-an-interrupted-windows-update).
- **Installing in a VM:** download Setup in the VM's browser to avoid VNC file
  transfer and clipboard issues. For Linux migration, use a file-sharing or
  transfer method that copies the complete backup folder.

Use [GitHub Discussions](https://github.com/prsmith777/ALPR-Database-Community/discussions)
for setup questions or the [bug report form](https://github.com/prsmith777/ALPR-Database-Community/issues/new?template=bug_report.yml)
for a reproducible problem. Include the version from **Settings → Release** and
the exact message. Remove passwords, API keys, real plates, images, private
addresses, and database contents from public reports.

For advanced administrator and maintainer details, see
[Native Windows architecture and maintenance](WINDOWS_NATIVE.md).
