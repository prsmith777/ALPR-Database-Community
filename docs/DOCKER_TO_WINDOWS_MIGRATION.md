# Move Docker ALPR data to native Windows

Use this procedure for either **Docker Desktop on Windows** or **Docker on
Linux**, with an Original ALPR v0.1.9-compatible database or Community v0.1.20+
on PostgreSQL 13 or 17. It creates the same verified folder that Windows Setup
imports. Do not update, replace or delete the old Docker database to export it.

These controls are part of the Docker migration exporter change; use a release
that includes them. Older releases, including v0.1.55, do not include this
graphical Docker exporter.

## Choose the correct backup tool

| Source | Export tool |
| --- | --- |
| Original or Community in Docker Desktop on Windows | Setup → Move an existing ALPR database and images → **Back up original Docker ALPR…** |
| Original or Community in Docker on Linux | On the Linux source host, from a prepared current Community checkout: `./alpr-community migrate export-docker` |
| Native Windows Community | Windows Start → **ALPR Migration Backup** |
| Linux PostgreSQL outside Docker | The advanced [Linux portable backup procedure](WINDOWS_NATIVE.md#create-the-backup-on-linux), using its actual endpoint and image paths |

The native Windows backup shortcut exports the native database only. Installing
an empty Community database and using that shortcut does **not** export the old
Docker database.

## Docker Desktop on Windows

1. Run Docker Desktop as the Windows account that owns the original installation.
   Keep it in Linux-container mode. Keep the original application, PostgreSQL
   container and all their volumes.
2. Open the new Windows Setup. Select **Move an existing ALPR database and
   images**, then **Back up original Docker ALPR…**. Export is available before
   installing Community; you do not need a temporary empty installation.
3. Select the old Docker application and its PostgreSQL container by name and
   image. The tool checks that the selected database matches the application's
   configured Docker network address. It never selects the native Windows service.
4. Select **Review source**. Check the source application type, PostgreSQL version
   and **plate-read count**. If the count is zero and you expected historical
   records, cancel and select the correct source. Unknown or incomplete schemas
   stop the export.
5. Pause Blue Iris ingestion and other jobs or applications that write to this
   database or image storage. Keep ingestion paused until the Windows import has
   been verified.
   Confirm the displayed source and choose a private local backup location.
   The tool stops only the selected Docker ALPR application, makes and verifies
   its logical dump, images, settings and authentication, then restarts it if it
   was running. An already stopped application stays stopped.
6. Wait for **Docker backup complete**. The installer selects the resulting
   folder automatically. Keep the entire folder, including `migration-backup.json`.
   A failure preserves source data and any partial export; keep the diagnostic
   folder. A partial export is not a usable migration backup.
7. Keep ingestion on the old source paused through import and verification.
   The exporter restarts the app but does not control Blue Iris senders; Setup's
   confirmation is deliberately reset. If ingestion resumed after export, create
   a fresh export for cutover so later reads are included. Continue below.

The tool uses PostgreSQL 17 client containers and may download the matching
official image. It connects within the selected database container's network
namespace using read-only database sessions. It does not publish a database port
or copy the physical PostgreSQL cluster. Docker's original ports and volumes
remain unchanged. Keep Docker running until export completes.

After installation, **ALPR Docker Migration Backup** in Windows Start opens the
same Docker exporter. The older **ALPR Migration Backup** shortcut clearly
identifies itself as a native Windows backup.

## Docker on Linux → Windows

1. On the Linux computer that owns the Docker containers, prepare a separate
   current Community checkout with its locked dependencies and Node.js 24
   (or use an existing current Community checkout). This prepares the exporter;
   it does not replace the old running application. Use the normal account with
   access to that Docker engine.
2. From that checkout run:

   ```bash
   ./alpr-community migrate export-docker
   ```

3. Select the original application and database from the numbered lists. Enter
   an absolute path to a private local backup directory. Review the displayed
   source type and plate-read count.
4. Pause Blue Iris ingestion and every other database/image writer, then type
   the confirmation shown by
   the exporter. The selected source application is briefly stopped and returned
   to its original running/stopped state. Wait for the verified backup path.
5. Copy the **entire completed backup folder** from Linux to Windows using your
   normal protected file transfer. Include hidden files and all manifests.
   Never copy `/var/lib/postgresql/data` into the Windows database directory.
6. Keep old-source ingestion paused until import is verified. If it resumed,
   export again before cutover to include later reads. In Windows Setup select
   **Move an existing ALPR database and images**, browse to the copied folder
   containing `migration-backup.json`, and continue below.

## Import and verify

Use a **fresh, empty native Windows target**. Keep Docker's application port
unchanged; if it uses 3000 on the same Windows computer, choose 3001 for native
Community. Normally keep the separate native database at 5433.

Setup verifies checksums, source schema, exact pre-upgrade table counts, migrated
records and referenced image files before starting the application. Review
integration destinations and then verify sign-in, historical records, tags,
representative images, settings and one controlled new read. Only then change
the intended Blue Iris destination to the new application address. A migrated
authentication file preserves the ingestion API key; otherwise obtain the new
key in Settings → Security. The setup administrator uses the password selected
during Setup. Windows creates separate protected PostgreSQL credentials.

Keep the original installation and completed backup until the move is accepted.
The two databases are independent after export; later records are not synchronized.

## If Community already contains new records

**Do not delete or reinstall it to make room for an import.** First make a
separate native Community backup and keep the original Docker export. The
importer refuses a populated target and does not merge old and new histories.
Use another clean Windows computer/VM to verify the old history, or plan a
replacement with the maintainer while retaining both datasets and backups.

## If source review fails

Keep the exact displayed error and container names/images. Do not share Docker
inspection output containing environment variables, passwords, API keys, images
or real plate data publicly. The exporter supports the documented ALPR mounts
`/app/storage`, `/app/config` and `/app/auth`, and a directly associated Docker
PostgreSQL container. External databases, secret-file credentials, renamed
application data paths and unsupported schemas require the advanced procedure
or maintainer help; the exporter does not guess or rewrite them.
