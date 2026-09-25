import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import { postgresMajorMigrationInternals as internals } from "../scripts/postgres-major-migration.mjs";

function endpointEnvironment() {
  return {
    ALPR_MIGRATION_SOURCE_HOST: "source-db.example.test",
    ALPR_MIGRATION_SOURCE_DATABASE: "alpr",
    ALPR_MIGRATION_SOURCE_USER: "migration_reader",
    ALPR_MIGRATION_SOURCE_PASSWORD: "source-secret",
  };
}

function legacyV019Signature() {
  const columnsByTable = {
    devmgmt: ["id", "training_last_record", "update1"],
    known_plates: ["ignore", "plate_number"],
    plate_notifications: ["enabled", "id", "plate_number", "priority"],
    plate_reads: [
      "bi_path",
      "bi_zone",
      "camera_name",
      "confidence",
      "crop_coordinates",
      "id",
      "image_data",
      "image_path",
      "ocr_annotation",
      "plate_annotation",
      "plate_number",
      "thumbnail_path",
      "timestamp",
      "validated",
    ],
    plate_tags: ["plate_number", "tag_id"],
    plates: ["flagged", "occurrence_count", "plate_number"],
    tags: ["id", "name"],
  };
  const primaryKeysByTable = {
    devmgmt: ["id"],
    known_plates: ["plate_number"],
    plate_notifications: ["id"],
    plate_reads: ["id"],
    plate_tags: ["plate_number", "tag_id"],
    tags: ["id"],
  };
  return {
    tables: Object.keys(columnsByTable).sort(),
    columns: Object.entries(columnsByTable).flatMap(([table, columns]) =>
      columns.map((column, index) => ({
        table,
        column,
        ordinal: index + 1,
        dataType: "fixture",
        udtName: "fixture",
        nullable: "YES",
      }))
    ),
    primaryKeys: Object.entries(primaryKeysByTable).flatMap(([table, columns]) =>
      columns.map((column, index) => ({ table, column, ordinal: index + 1 }))
    ),
    migrationVersions: [],
  };
}

test("migration endpoints require explicit credentials and validated ports", () => {
  assert.equal(internals.SOURCE_QUIESCED_ACKNOWLEDGEMENT, "ALPR_SOURCE_QUIESCED");
  assert.equal(internals.RESTORE_ACKNOWLEDGEMENT, "ALPR_TO_PG17_EMPTY_TARGET");
  assert.deepEqual(internals.SUPPORTED_SOURCE_MAJORS, [13, 17]);
  assert.equal(internals.TARGET_SERVER_MAJOR, 17);
  const source = internals.readEndpoint(endpointEnvironment(), "ALPR_MIGRATION_SOURCE");
  assert.deepEqual(source, {
    host: "source-db.example.test",
    port: 5432,
    database: "alpr",
    user: "migration_reader",
    password: "source-secret",
    sslMode: "prefer",
  });
  assert.throws(
    () => internals.readEndpoint({ ...endpointEnvironment(), ALPR_MIGRATION_SOURCE_PORT: "0" }, "ALPR_MIGRATION_SOURCE"),
    /TCP port/
  );
  const withoutPassword = endpointEnvironment();
  delete withoutPassword.ALPR_MIGRATION_SOURCE_PASSWORD;
  assert.throws(() => internals.readEndpoint(withoutPassword, "ALPR_MIGRATION_SOURCE"), /PASSWORD is required/);
});

test("source and target may not identify the same database", () => {
  const source = {
    host: "DB.EXAMPLE.TEST",
    port: 5432,
    database: "ALPR",
  };
  assert.throws(
    () => internals.assertDistinctEndpoints(source, { host: "db.example.test", port: 5432, database: "alpr" }),
    /same PostgreSQL endpoint/
  );
  assert.doesNotThrow(
    () => internals.assertDistinctEndpoints(source, { host: "db.example.test", port: 55432, database: "alpr" })
  );
});

test("dump artifacts must use an absolute path outside the repository", () => {
  const root = resolve("fixture-repository");
  assert.throws(
    () => internals.resolveArtifactPath({ ALPR_MIGRATION_DUMP_PATH: "relative.dump" }, root),
    /absolute path/
  );
  assert.throws(
    () => internals.resolveArtifactPath({ ALPR_MIGRATION_DUMP_PATH: join(root, "backups", "alpr.dump") }, root),
    /outside the repository/
  );
  const outside = resolve(root, "..", "migration-artifacts", "alpr.dump");
  assert.equal(internals.resolveArtifactPath({ ALPR_MIGRATION_DUMP_PATH: outside }, root), outside);
});

test("PostgreSQL client and server majors are parsed strictly", () => {
  assert.equal(internals.parseClientMajor("pg_dump (PostgreSQL) 17.10"), 17);
  assert.equal(internals.parseClientMajor("psql (PostgreSQL) 18.1"), 18);
  assert.equal(internals.parseServerMajor("130021"), 13);
  assert.equal(internals.parseServerMajor("170010"), 17);
  assert.throws(() => internals.parseClientMajor("unknown client"), /could not parse/);
  assert.throws(() => internals.parseServerMajor("17.10"), /unexpected/);
});

test("only validated source PostgreSQL versions are accepted", () => {
  assert.equal(internals.assertSupportedSourceMajor(13), 13);
  assert.equal(internals.assertSupportedSourceMajor(17), 17);
  assert.throws(
    () => internals.assertSupportedSourceMajor(16),
    /supported PostgreSQL major \(13 or 17\)/
  );
});

test("the pinned Original ALPR v0.1.9 schema is a supported source profile", () => {
  assert.equal(
    internals.LEGACY_BASELINE_COMMIT,
    "aeb72baf6f0435c8d42ed07422f1b2f3a703e6ac"
  );
  const signature = legacyV019Signature();
  assert.deepEqual(internals.missingLegacyV019Requirements(signature), []);
  assert.equal(
    internals.classifySourceApplication(signature).id,
    "original-alpr-v0.1.9"
  );
});

test("incomplete and unrecognized legacy schemas are rejected before dumping", () => {
  const signature = legacyV019Signature();
  signature.columns = signature.columns.filter(
    (entry) => !(entry.table === "plate_reads" && entry.column === "image_path")
  );
  assert.throws(
    () => internals.classifySourceApplication(signature),
    /missing the supported ALPR database foundation: column public\.plate_reads\.image_path/
  );
});

test("a Community source requires its baseline migration marker", () => {
  const signature = legacyV019Signature();
  signature.tables.push("schema_migrations");
  signature.columns.push({
    table: "schema_migrations",
    column: "version",
    ordinal: 1,
    dataType: "character varying",
    udtName: "varchar",
    nullable: "NO",
  });
  assert.throws(
    () => internals.classifySourceApplication(signature),
    /lacks the supported Community baseline/
  );
  signature.migrationVersions.push(internals.COMMUNITY_BASELINE_MIGRATION);
  assert.equal(
    internals.classifySourceApplication(signature).id,
    "alpr-community-v0.1.20-plus"
  );

  signature.columns = signature.columns.filter(
    (entry) => !(entry.table === "plate_reads" && entry.column === "plate_number")
  );
  assert.throws(
    () => internals.classifySourceApplication(signature),
    /missing the supported ALPR database foundation: column public\.plate_reads\.plate_number/
  );
});

test("schema fingerprints are deterministic and detect structural changes", () => {
  const signature = legacyV019Signature();
  const first = internals.fingerprintSourceSchema(signature);
  const reordered = {
    ...signature,
    tables: [...signature.tables].reverse(),
    columns: [...signature.columns].reverse(),
    primaryKeys: [...signature.primaryKeys].reverse(),
  };
  assert.match(first, /^[A-F0-9]{64}$/);
  assert.equal(internals.fingerprintSourceSchema(reordered), first);
  reordered.columns[0] = { ...reordered.columns[0], nullable: "NO" };
  assert.notEqual(internals.fingerprintSourceSchema(reordered), first);
});

test("connection arguments never contain passwords and identifiers are quoted", () => {
  const endpoint = internals.readEndpoint(endpointEnvironment(), "ALPR_MIGRATION_SOURCE");
  const args = internals.connectionArguments(endpoint);
  assert.deepEqual(args, [
    "--host", "source-db.example.test",
    "--port", "5432",
    "--username", "migration_reader",
    "--dbname", "alpr",
  ]);
  assert.equal(args.includes("source-secret"), false);
  assert.equal(internals.quoteIdentifier('reads"archive'), '"reads""archive"');
});

test("row-count comparison reports missing and changed tables", () => {
  assert.deepEqual(
    internals.compareCounts({ plate_reads: "12", users: "3", tags: "4" }, { plate_reads: "12", users: "2" }),
    [
      { table: "users", source: "3", target: "2" },
      { table: "tags", source: "4", target: "missing" },
    ]
  );
  assert.deepEqual(internals.compareCounts({ plate_reads: "12" }, { plate_reads: "12", new_table: "0" }), []);
});

test("post-migration validation permits seeds but rejects row loss", () => {
  assert.deepEqual(
    internals.compareMinimumCounts(
      { plate_reads: "12", camera_visual_profiles: "0" },
      { plate_reads: "12", camera_visual_profiles: "1" }
    ),
    []
  );
  assert.deepEqual(
    internals.compareMinimumCounts(
      { plate_reads: "12", tags: "4" },
      { plate_reads: "11" }
    ),
    [
      { table: "plate_reads", source: "12", target: "11" },
      { table: "tags", source: "4", target: "missing" },
    ]
  );
  assert.deepEqual(
    internals.listMigrationAdditions(
      { camera_visual_profiles: "0", plates: "12" },
      { camera_visual_profiles: "1", plates: "12" }
    ),
    [
      {
        table: "camera_visual_profiles",
        source: "0",
        target: "1",
        added: "1",
      },
    ]
  );
});

test("post-migration reconciliation rebuilds plate occurrence counts", () => {
  assert.match(
    internals.POST_MIGRATION_RECONCILIATION_SQL,
    /INSERT INTO public\.plates \(plate_number, occurrence_count\)/
  );
  assert.match(
    internals.POST_MIGRATION_RECONCILIATION_SQL,
    /COUNT\(\*\)::integer/
  );
  assert.match(
    internals.POST_MIGRATION_RECONCILIATION_SQL,
    /SET occurrence_count = 0/
  );
});

test("dump identity must match the live source before restore", () => {
  const source = {
    database: "alpr",
  };
  const manifest = {
    source: {
      database: "alpr",
      serverMajor: 17,
    },
  };

  assert.doesNotThrow(() =>
    internals.assertManifestSourceIdentity(manifest, source, 17)
  );
  assert.throws(
    () => internals.assertManifestSourceIdentity(manifest, source, 13),
    /does not match live source PostgreSQL/
  );
  assert.throws(
    () =>
      internals.assertManifestSourceIdentity(
        manifest,
        { database: "different" },
        17
      ),
    /does not match live source database/
  );
});
