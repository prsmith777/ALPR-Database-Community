# Vehicle identity in Community

Community v0.1.43 and later use ReID V2 exclusively. There is no identity-mode
selector, conversion preview, cutover, or alternate identity engine.

## New installations

No separate ReID installation is needed. OpenVINO and the pinned detection,
embedding, and body-type models are bundled in the application image. The
bootstrap prepares the host and installer; the application handles vehicle
processing after startup.

Eligible whole-vehicle images move through automatic background cataloging,
canonical cropping, embedding, and attribute analysis. Work is bounded and does
not run in page requests. Plate-only images and display fallbacks are not
identity evidence. Configure your image integration to provide a usable vehicle
view and detection box; merely receiving plate text does not create a vehicle
image or searchable identity.

Settings > Vehicle Setup shows crop-analysis counts after usable crops exist.
Use **Refresh status**, **Pause image processing**, **Resume image processing**,
or **Retry failed jobs (up to 100)**. A pause prevents new image work; work already
in progress can finish. Retries are bounded; repeated failures require diagnosis.
All-zero counts can mean no eligible image has reached the crop stage, not a
failure of plate ingestion.

### Recorded image source on Windows and Linux

In **Settings > Vehicle Setup**, save the camera's front/rear travel labels and
Blue Iris crossing mappings first. Connect Blue Iris and use **Test connection**
to populate its camera list. The selected image camera must have recordings.

Under **Vehicle images for ReID**, choose a source for each saved direction:

- **This LPR camera** uses recordings from the same camera near the plate event.
  It needs no separate overview camera, but the recording must show the complete
  vehicle in color with one unambiguous tracked detection. A tight plate view
  cannot supply identity evidence. Clipped vehicles and monochrome views are
  rejected.
- **Overview camera** uses the selected other Blue Iris camera. Set its timing
  offset in seconds; positive means the vehicle reaches that view after the
  plate read.

Enable the source and save each direction separately. Changing a primary source
disables the previous primary mapping for that camera/direction transactionally.
Reload the page to verify it, then inspect a new plate read. Existing plate reads
are not automatically retried by changing the source. A usable recorded frame
still passes the normal crop, provenance, current-evidence, and ReID checks.
Receiving a plate thumbnail or direction alone does not create an identity.

## Search, profiles, and reviews

Vehicle Search ranks canonical crop embeddings locally. Similarity is evidence
for human review, not proof that two captures are the same vehicle. Profiles
use exact-current image links, reviewed plate evidence, shared assets, and
audited pair reviews. Different or Unsure evidence must not be overridden by a
high similarity score. Changing source images or review evidence can temporarily
remove an assignment until it is reconsidered.

Profiles show the associated observations. Needs Review lists identity-processing
exceptions. Vehicle Search provides Same vehicle, Different vehicle, and Unsure
controls for users with plate-review permission. Same may merge exact-current
profiles; Different or Unsure withdraws a prior merge made from that pair.
Recognition Feed links to a profile when assigned and enables Find similar only
when the read has a current eligible search source. Missing identity does not
mean the plate read has been deleted.

## Direction and attributes

Color and body type come from the current canonical crop, not a separate plate
image index. Camera direction labels retain their meanings, but image-based
Front/Rear calibration is tied to the exact crop that was reviewed. A changed
crop cannot inherit an old orientation label. Blue Iris ordered-zone crossing
direction remains a separate source of evidence. Monochrome or ambiguous images
must not produce confident guessed labels.

## Updating or importing an existing database

Use the normal [update](UPDATES.md) or [migration](MIGRATION_GUIDE.md) procedure.
The updater stops the application and verifies a database backup before applying
the transactional schema upgrade. The migration wizard builds a separate target.

Original reads, plate-image and vehicle-image references, users, tags, and plate
corrections are retained. Obsolete derived indexes and incompatible image-based
calibration are retired; eligible vehicle views are reprocessed automatically.
No old grouping is treated as verified identity. Existing canonical evidence
remains subject to current-source validation.

Do not point an older application at the upgraded database. If rollback is needed,
use the supported updater recovery bundle; database rollback discards records
added since that backup. Retain the backup until technical checks and real-use
acceptance have passed.

After upgrade, verify new ingestion, plate and vehicle image display, filtered
and unfiltered feed navigation, Vehicle Search, Profiles, and Vehicle Setup.
Processing a large image history can take time; processing completion is separate
from the update's technical checks and acceptance.

## Maintainer checks

CI uses synthetic, sentinel-guarded PostgreSQL 17 databases to test repeated schema
application, upgrading the prior published Community schema, original-record
preservation, native initialization, current-evidence identity behavior, and the
set-based feed performance regression. Test fixtures are not included in the
runtime image and are not new-user demonstration data.
