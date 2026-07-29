import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizePlateValue,
  PlateReviewError,
  PlateReviewRepository,
  recordAliasApplicationWithClient,
  resolvePlateAliasWithClient,
} from "../lib/plate-review-repository.mjs";

function makeTransactionalRepository(handler) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql: String(sql), values });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      return await handler(String(sql), values, calls);
    },
    release() {
      calls.push({ sql: "RELEASE", values: [] });
    },
  };
  return {
    calls,
    repository: new PlateReviewRepository({
      getPool: async () => ({
        connect: async () => client,
        query: client.query,
      }),
    }),
  };
}

test("plate normalization preserves a bounded uppercase identity", () => {
  assert.equal(normalizePlateValue(" abc128 "), "ABC128");
  assert.throws(() => normalizePlateValue(""), PlateReviewError);
  assert.throws(() => normalizePlateValue("ABCDEFGHIJK"), { code: "INVALID_PLATE" });
});

test("single correction preserves observation and appends review plus audit", async () => {
  const { repository, calls } = makeTransactionalRepository(async (sql) => {
    if (sql.includes("FROM public.plate_reads") && sql.includes("FOR UPDATE")) {
      return {
        rowCount: 1,
        rows: [{
          id: 12,
          event_identity: "event-12",
          observed_plate: "ABC123",
          plate_number: "ABC123",
          review_status: "unreviewed",
          review_revision: 0,
        }],
      };
    }
    if (sql.includes("RETURNING id") && sql.includes("plate_read_reviews")) {
      return { rowCount: 1, rows: [{ id: 44 }] };
    }
    return { rowCount: 1, rows: [] };
  });

  const result = await repository.reviewRead({
    readId: 12,
    action: "correct",
    newPlate: "ABC128",
    reason: "ocr_character_error",
    actor: { id: 7, username: "paul", displayName: "Paul" },
  });

  assert.equal(result.observedPlate, "ABC123");
  assert.equal(result.effectivePlate, "ABC128");
  assert.equal(result.reviewStatus, "corrected");
  const update = calls.find((call) => call.sql.includes("UPDATE public.plate_reads SET plate_number"));
  assert.deepEqual(update.values.slice(0, 4), [12, "ABC128", true, "corrected"]);
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO public.plate_read_reviews")));
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO public.audit_events")));
  assert.ok(!calls.some((call) => /SET observed_plate/.test(call.sql)));
});

test("correction requires an explanation and never silently accepts an unchanged plate", async () => {
  const row = {
    id: 12,
    event_identity: "event-12",
    observed_plate: "ABC123",
    plate_number: "ABC123",
    review_status: "unreviewed",
    review_revision: 0,
  };
  const factory = () =>
    makeTransactionalRepository(async (sql) =>
      sql.includes("FROM public.plate_reads") ? { rowCount: 1, rows: [row] } : { rowCount: 1, rows: [] }
    ).repository;

  await assert.rejects(
    factory().reviewRead({ readId: 12, action: "correct", newPlate: "ABC128", reason: "" }),
    { code: "REASON_REQUIRED" }
  );
  await assert.rejects(
    factory().reviewRead({ readId: 12, action: "correct", newPlate: "ABC123", reason: "reviewed" }),
    { code: "PLATE_UNCHANGED" }
  );
});

test("alias replacement atomically retires the enabled mapping and preserves its audit trail", async () => {
  const { repository, calls } = makeTransactionalRepository(async (sql) => {
    if (sql.includes("FROM public.plate_aliases") && sql.includes("FOR UPDATE")) {
      return {
        rowCount: 1,
        rows: [{
          id: 8,
          source_plate: "U0777009",
          target_plate: "UC77008",
          camera_name: null,
          reason: "ocr_character_error",
        }],
      };
    }
    if (sql.includes("INSERT INTO public.plate_aliases") && sql.includes("RETURNING *")) {
      return {
        rowCount: 1,
        rows: [{ id: 9, source_plate: "U0777009", target_plate: "UC77009", camera_name: null }],
      };
    }
    return { rowCount: 1, rows: [] };
  });

  const result = await repository.createOrReplaceAlias({
    sourcePlate: "U0777009",
    targetPlate: "UC77009",
    reason: "ocr_character_error",
    actor: { id: 7, username: "paul", displayName: "Paul" },
    replaceExisting: true,
  });

  assert.equal(result.replacedAlias.id, 8);
  assert.equal(result.alias.id, 9);
  assert.ok(calls.some((call) =>
    call.sql.includes("UPDATE public.plate_aliases SET enabled = FALSE") && call.values[0] === 8
  ));
  assert.ok(calls.some((call) => call.values.includes("plate.alias_replaced")));
  assert.ok(calls.some((call) => call.values.some((value) =>
    typeof value === "string" && value.includes('"replacesAliasId":8')
  )));
});

test("review reversal can disable only the active alias associated with that review", async () => {
  const { repository, calls } = makeTransactionalRepository(async (sql) => {
    if (sql.includes("FROM public.plate_reads") && sql.includes("FOR UPDATE")) {
      return {
        rowCount: 1,
        rows: [{
          id: 12,
          event_identity: "event-12",
          observed_plate: "U0777009",
          plate_number: "UC77009",
          camera_name: "Entry LPR 2",
          review_status: "corrected",
        }],
      };
    }
    if (sql.includes("SELECT review.*") && sql.includes("FOR UPDATE")) {
      return {
        rowCount: 1,
        rows: [{
          id: 44,
          previous_plate: "U0777009",
          new_plate: "UC77009",
          previous_status: "unreviewed",
        }],
      };
    }
    if (sql.includes("plate_read_reviews") && sql.includes("RETURNING id")) {
      return { rowCount: 1, rows: [{ id: 45 }] };
    }
    if (sql.includes("FROM public.plate_aliases") && sql.includes("FOR UPDATE")) {
      return {
        rowCount: 1,
        rows: [{
          id: 8,
          source_plate: "U0777009",
          target_plate: "UC77009",
          camera_name: null,
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  });

  const result = await repository.reverseLatestReview({
    readId: 12,
    reason: "administrator_reversal",
    actor: { id: 7, username: "paul", displayName: "Paul" },
    disableAliasId: 8,
  });

  assert.equal(result.disabledAliasId, 8);
  assert.ok(calls.some((call) =>
    call.sql.includes("UPDATE public.plate_aliases SET enabled = FALSE") && call.values[0] === 8
  ));
  assert.ok(calls.some((call) => call.values.includes("plate.alias_disabled_on_review_reversal")));
  assert.equal(calls.at(-2).sql, "COMMIT");
});

test("camera-scoped alias lookup is exact and alias application is auditable", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (String(sql).includes("FROM public.plate_aliases")) {
        return {
          rowCount: 1,
          rows: [{
            id: 3,
            source_plate: "ABC123",
            target_plate: "ABC128",
            camera_name: "Driveway",
            reason: "reviewed_recurring_ocr_misread",
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const alias = await resolvePlateAliasWithClient(client, {
    observedPlate: "abc123",
    cameraName: "Driveway",
  });
  assert.equal(alias.target_plate, "ABC128");
  assert.deepEqual(calls[0].values, ["ABC123", "Driveway"]);

  await recordAliasApplicationWithClient(client, {
    readId: 99,
    eventIdentity: "event-99",
    alias,
    observedPlate: "ABC123",
  });
  assert.ok(calls.some((call) => String(call.sql).includes("'alias_applied'")));
  assert.ok(calls.some((call) => String(call.sql).includes("use_count = use_count + 1")));
  assert.ok(calls.some((call) => call.values.includes("plate.alias_applied")));
});

test("migration enforces immutable observations, append-only reviews, and disable-only aliases", async () => {
  const migration = await readFile(new URL("../migrations.sql", import.meta.url), "utf8");
  assert.match(migration, /observed_plate VARCHAR\(10\)/);
  assert.match(migration, /plate_reads\.observed_plate is immutable/);
  assert.match(migration, /plate_read_reviews is append-only/);
  assert.match(migration, /plate aliases must be disabled, not deleted/);
  assert.match(migration, /uq_plate_aliases_enabled_scope/);
  assert.match(migration, /plate\.review\.batch/);
  assert.match(migration, /plate\.alias\.manage/);
  assert.match(migration, /2026071903_immutable_plate_reviews/);
});

test("ingestion resolves aliases before known-plate behavior and durable notification handoff", async () => {
  const route = await readFile(new URL("../app/api/plate-reads/route.js", import.meta.url), "utf8");
  const resolveIndex = route.indexOf("resolvePlateAliasWithClient");
  const ignoredIndex = route.indexOf("isPlateIgnored(effectivePlate)");
  const recordIndex = route.indexOf("recordAliasApplicationWithClient");
  const mqttIndex = route.indexOf("mqttService.processAcceptedRead");
  assert.ok(resolveIndex >= 0 && resolveIndex < ignoredIndex);
  assert.ok(recordIndex >= 0 && recordIndex < mqttIndex);
  assert.match(route, /plateNumber: observedPlate/);
  assert.match(route, /plate_number:\s*effectivePlate/);
  assert.match(route, /observed_plate,/);
  assert.match(route, /alias_resolved/);
});

test("correction UI exposes previewed batch scope, recurring alias, and append-only history", async () => {
  const [feed, wrapper, database, settings, actions] = await Promise.all([
    readFile(new URL("../components/PlateTable.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/PlateTableWrapper.jsx", import.meta.url), "utf8"),
    readFile(new URL("../components/plateDbTable.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/PlateReviewSettings.jsx", import.meta.url), "utf8"),
    readFile(new URL("../app/actions.js", import.meta.url), "utf8"),
  ]);
  assert.match(feed, /Camera observed/);
  assert.match(feed, /Current effective plate/);
  assert.match(feed, /Remember .* as a recurring misread/);
  assert.match(feed, /Save recurring alias/);
  assert.match(feed, /Replace existing recurring alias/);
  assert.match(feed, /Reverse and disable alias/);
  assert.match(feed, /\{correction\?\.image && \(/);
  assert.match(feed, /image=\{correction\.image\}/);
  assert.doesNotMatch(feed, /selectedImage && selectedImage\.id === correction\?\.id/);
  assert.equal((feed.match(/setCorrection\(correctionDraft\(\{/g) || []).length, 3);
  assert.equal((feed.match(/aliasScope: "all"/g) || []).length, 1);
  assert.doesNotMatch(feed, /aliasScope: "camera"/);
  assert.match(feed, /Preview affected reads/);
  assert.match(feed, /Review History/);
  assert.doesNotMatch(feed, /Remove previous plate number from database/);
  assert.doesNotMatch(feed, /Confirm AI Label/);
  assert.match(wrapper, /previewPlateCorrection/);
  assert.match(wrapper, /getPlateReviewHistory/);
  assert.match(database, /Review individual reads/);
  assert.match(settings, /Aliases are disabled, never deleted/);
  assert.match(actions, /requirePermission\("plate\.review\.batch"\)/);
  assert.match(actions, /requirePermission\("plate\.alias\.manage"\)/);
  assert.match(actions, /ALIAS_REPLACE_CONFIRMATION_REQUIRED/);
  assert.match(actions, /aliasOnly: true/);
  assert.doesNotMatch(actions.match(/export async function correctPlateRead[\s\S]*?\n}/)[0], /removePlate/);
});

test("administrator Review & Corrections navigation renders the review settings component", async () => {
  const settingsForm = await readFile(
    new URL("../app/settings/SettingsForm.jsx", import.meta.url),
    "utf8"
  );
  const renderSection = settingsForm.match(
    /const renderSection = \(\) => \{[\s\S]*?\n  \};/
  )?.[0];

  assert.ok(renderSection, "expected the settings section renderer");
  assert.match(
    renderSection,
    /case "plateReview":\s*return <PlateReviewSettings \/>;/
  );
});
