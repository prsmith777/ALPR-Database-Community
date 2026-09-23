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

test("migration endpoints require explicit credentials and validated ports", () => {
  assert.equal(internals.SOURCE_QUIESCED_ACKNOWLEDGEMENT, "PG13_SOURCE_QUIESCED");
  assert.equal(internals.RESTORE_ACKNOWLEDGEMENT, "PG13_TO_PG17_EMPTY_TARGET");
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
