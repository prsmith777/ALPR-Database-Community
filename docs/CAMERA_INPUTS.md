# Camera inputs

Open **Settings > Integrations > Camera Inputs**. Select a recognition source for each camera: **Blue Iris** or **AXIS License Plate Verifier**. Different cameras can use different sources. Existing Blue Iris cameras appear automatically after a read; their alert actions, API key, camera names and history continue to work without enrollment.

Recognition and recording are independent. An Axis camera may supply recognition directly while Blue Iris continues recording it. This integration does not manufacture Blue Iris alert/clip pointers for Axis events; playback pointers require an actual Blue Iris alert association. The existing Blue Iris recording setup remains available independently.

## Blue Iris

Use the exact camera name sent in the Blue Iris alert JSON. Send the existing alert body to `/api/plate-reads`, authenticated with the existing integration API key in `x-api-key` or `Authorization: Bearer`. Existing unregistered camera names continue to be accepted automatically.

Explicitly switching a camera name to Axis makes Axis its recognition source. Blue Iris recognition arriving for that configured camera name is then acknowledged without importing another read. Disabling an explicitly configured input stops its imports. History is preserved, and the recording configuration is not changed.

## Axis HTTP push

1. Add an input, choose Axis, enter a camera name (maximum 30 characters), and enter the camera's serial number or MAC address. Device identity must match the event; IP addresses are not identities.
2. Select HTTP push and save. Copy the destination URL and the generated source credential. A credential is displayed only when generated. It is stored as a hash, scoped to this input, and cannot authenticate to application administration.
3. In Axis License Plate Verifier, open **Integration > Push events** and select HTTP POST. Use the generated destination path with an ALPR hostname/IP and port reachable from the camera. A browser reverse-proxy address may need a different camera-facing host. Prefer HTTPS.
4. Configure HTTP Basic authentication: username is the source UUID displayed by ALPR; password is the generated source credential. ALPR also accepts that credential through `x-api-key` or `Authorization: Bearer`. These are incoming push credentials, not camera administrator credentials. URL query credentials are rejected.
5. Enable New, Update and Lost events. Include images and enable the camera **Event buffer**. ALPR accepts `application/json` with base64 images or `multipart/form-data` containing an event JSON part and image files. Where available, **Send two images** supplies a scene/vehicle image alongside a plate crop.
6. Use **Listen for event**, then Axis's Test button or a real passage. Camera Test events go through the real import path and may trigger configured notifications. Avoid test plate values on a production installation.

HTTP 200 means the event is durably stored for processing, including an idempotent duplicate; temporary storage failure receives 503 so the camera can retry. Buffer capacity and behavior depend on the installed ALPV version. Sending a second image does not automatically enable vehicle identification processing for that image.

## Axis MQTT

1. Keep the camera connected to an external MQTT broker. ALPR is a client, not an MQTT broker.
2. Enable the camera's **ALPV.AllPlates** publication. Copy its exact incoming topic, including device prefix and any namespace components. No separate image or payload topic is required when the JSON contains `message.data.lpImage`.
3. In Camera Inputs, select MQTT and select an existing broker or add one. Configure host/IP, port, credentials and TLS. TLS verifies the broker certificate using the host trust store.
4. Enter the topic or MQTT filter. `+` and a final `#` are supported. A dedicated broker account needs subscription/read access to that filter. The payload's camera identity must still match the configured serial/MAC.
5. Use QoS 1 for both the camera publication and ALPR subscription; keep retained publication disabled. ALPR deliberately ignores retained messages. The stable, automatically generated subscriber client ID is separate from outgoing notifications and camera/Home Assistant clients. The connection uses a persistent session.
6. Configure broker persistence and queue/message-size limits for the image-bearing payloads. A persistent broker can queue QoS 1 events during an ALPR outage. It does not recover events the camera never delivered to it, and broker limits can still cause loss.
7. Save, use **Test MQTT** to verify connection and topic permission, and **Listen for event** to inspect actual received events. Changes normally take effect within ten seconds. No ALPR API key or camera administrator password is needed for MQTT ingestion.

The subscriber saves a validated event to PostgreSQL before acknowledging QoS 1 delivery. Temporary database failures leave the publish unacknowledged and reconnect the client. Processing retries persist across application restarts. Invalid events are acknowledged and reported as input diagnostics so a malformed message cannot prevent later valid events.

## Passage processing

- **Immediate:** accept the first received New/Update/Lost event promptly, then apply later plate/image/direction corrections to the same passage. `observed_plate` remains the first immutable observation. Plate-read notifications use the first recognition and do not repeat when OCR changes.
- **Finalized:** retain events until Lost; if Lost is missing, finalize after 30 seconds without another received observation. This favors corrected recognition over latency.
- Correlation uses configured camera identity, Axis runtime `carID`, event state and a bounded capture-time window. An explicit newer New event starts a new occurrence when a runtime carID is reused. Delayed older events do not overwrite newer results.
- HTTP and MQTT payloads normalize to the same event identity, excluding transport-specific packet counters. **HTTP and MQTT (advanced)** can be used together for one configured input without duplicating the same event.
- Zero or absent plate confidence does not automatically discard a read. Vehicle confidence is not substituted for plate confidence. `Accepted`/`Denied` is an access-control decision, not an OCR validity flag.
- Camera in/out direction labels are configurable. Movement direction is kept separate from front/rear vehicle view. Later direction observations use the existing durable direction-notification pipeline.
- Human-reviewed plate corrections take precedence over automatic OCR changes. Original observations and subsequent camera metadata remain separate.
- An optional raw Axis ROI ID limits imports to one area of interest. Blank accepts every ROI; the raw event ID may differ from the camera UI's displayed AOI number.
- Receipt metadata is retained for seven days. Embedded image data is removed after import, including earlier buffered observations in finalized mode. Saved plate and scene images use application storage. Recent events display thumbnails only beside the latest observation for a passage, so an earlier plate value is not paired with a later corrected image. Pending finalization retains the required image-bearing receipt.

## Compatibility and validation

The integration targets documented ALPV AllPlates MQTT events and ALPV HTTP JSON/multipart push formats. Firmware/app versions can vary. No Axis hardware was available during implementation; transport emulation and automated tests do not replace camera-specific compatibility verification.

Run unit and regression checks with `yarn test`, `yarn lint`, and `yarn typecheck`. The wire-level MQTT test uses a local TCP broker fixture. The PostgreSQL verification creates and drops its own uniquely named database on an explicitly supplied isolated local server:

```text
ALPR_AXIS_TEST_SERVER_URL=postgresql://postgres@127.0.0.1:PORT/postgres
node --experimental-loader ./scripts/camera-inputs-test-loader.mjs scripts/test-camera-inputs-postgres.mjs
```

Do not point that verification at an application database. It exercises the actual shared ingestion service, migrations, images, source compatibility, deduplication, corrections, and rollback/retry behavior.

Sources: [Axis License Plate Verifier manual](https://help.axis.com/en-us/axis-license-plate-verifier), [ALPV event API](https://developer.axis.com/vapix/applications/license-plate-verifier-api/), [MQTT Event Bridge](https://developer.axis.com/vapix/network-video/mqtt-event-bridge/), [Axis OS MQTT behavior](https://help.axis.com/en-us/axis-os-knowledge-base).
