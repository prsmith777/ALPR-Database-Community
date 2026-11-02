import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { compileMigrations } from "./build-migrations.mjs";
import { BlueIrisVehicleFrameRepository } from "../lib/blue-iris-vehicle-frame-repository.mjs";
import { HomeAssistantDisplayService, createDisplayReadHandler } from "../lib/home-assistant-display.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const releaseFile = (tag, name) => execFileSync("git", ["show", `${tag}:${name}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true });
async function transaction(pool, sql) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query(sql); await client.query("COMMIT"); }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
function assertPreservedRows(actual, before, message) {
  assert.equal(actual.length,before.length,message);
  for (let i=0;i<before.length;i++) {
    const existing = Object.fromEntries(Object.keys(before[i].value).map(key=>[key,actual[i].value[key]]));
    assert.deepEqual(existing,before[i].value,message);
  }
}

export async function exerciseCommunityBugfixes(server, { browserTest } = {}) {
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(server.host), "tests require a loopback PostgreSQL server");
  const admin = new pg.Pool({ ...server, database: "postgres", max: 1 });
  const databases = [];
  const { sql, manifest } = await compileMigrations();
  const known = new Set(manifest.map(unit=>unit.version));
  try {
    for (const tag of ["v0.1.42", "v0.1.55", "v0.1.58", "v0.1.59", "fresh"]) {
      const database = "codex_community_bugfix_" + randomBytes(8).toString("hex");
      assert.match(database, /^codex_community_bugfix_[0-9a-f]{16}$/);
      await admin.query(`CREATE DATABASE "${database}"`);
      databases.push(database);
      const pool = new pg.Pool({ ...server, database, max: 3 });
      try {
        await pool.query(tag === "fresh" ? await readFile(new URL("../schema.sql", import.meta.url), "utf8") : releaseFile(tag,"schema.sql"));
        await pool.query("SET search_path TO public");
        if (tag !== "fresh") await transaction(pool, releaseFile(tag,"migrations.sql"));
        if (tag === "fresh") await transaction(pool, sql);
        await pool.query(`INSERT INTO public.plate_reads(plate_number,camera_name,timestamp,image_path)
          VALUES ('TST5701','eastlpr',CURRENT_TIMESTAMP,'images/fixture.jpg'),
                 ('TST5702','Other Camera',CURRENT_TIMESTAMP,'images/other.jpg')`);
        const read = (await pool.query("SELECT * FROM public.plate_reads WHERE plate_number='TST5701'")).rows[0];
        await pool.query(`INSERT INTO public.vehicle_direction_observations
          (read_id,camera_key,embedding_model,classifier_version,profile_version,status,orientation,orientation_confidence,direction_label)
          VALUES ($1,'eastlpr','blue-iris-zone-crossing','blue-iris-zone-crossing-v2-primary',1,'ready','front',1,'Westbound')`, [read.id]);
        const snapshot = (await pool.query("SELECT row_to_json(observation) AS value FROM public.vehicle_direction_observations observation ORDER BY read_id")).rows;
        const originalRead = (await pool.query("SELECT row_to_json(reads) AS value FROM public.plate_reads reads ORDER BY id")).rows;
        await transaction(pool, sql);
        assertPreservedRows((await pool.query("SELECT row_to_json(observation) AS value FROM public.vehicle_direction_observations observation ORDER BY read_id")).rows, snapshot, tag + " preserves complete v2 observations");
        assert.equal((await pool.query("SELECT classifier_version FROM public.current_vehicle_direction_observations WHERE read_id=$1",[read.id])).rows[0].classifier_version,"blue-iris-zone-crossing-v2-primary");
        assertPreservedRows((await pool.query("SELECT row_to_json(reads) AS value FROM public.plate_reads reads ORDER BY id")).rows,originalRead, tag + " preserves complete plate reads");
        const ledger = (await pool.query("SELECT version,sql_sha256,applied_at FROM public.schema_migrations ORDER BY version")).rows;
        assert.ok(ledger.filter(row=>known.has(row.version)).every(row => /^[0-9a-f]{64}$/.test(row.sql_sha256 || "")));
        // A deliberately invalid retained label must survive replay of the old cleanup.
        await pool.query(`INSERT INTO public.vehicle_orientation_labels(read_id,camera_key,embedding_model,orientation,actor_username,actor_display_name)
          VALUES ($1,'eastlpr','fixture','front','fixture','Fixture')`,[read.id]);
        await transaction(pool, sql);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.vehicle_orientation_labels WHERE read_id=$1",[read.id])).rows[0].count,1);
        await Promise.all([transaction(pool,sql),transaction(pool,sql)]);
        assert.deepEqual((await pool.query("SELECT version,sql_sha256,applied_at FROM public.schema_migrations ORDER BY version")).rows,ledger);
        await pool.query("UPDATE public.schema_migrations SET sql_sha256=repeat('0',64) WHERE version='2026110103_preserve_event_directions'");
        await assert.rejects(transaction(pool,sql),/Applied migration checksum differs/);
        await pool.query("UPDATE public.schema_migrations SET sql_sha256=$1 WHERE version='2026110103_preserve_event_directions'",[ledger.find(row=>row.version==='2026110103_preserve_event_directions').sql_sha256]);
        await assert.rejects(transaction(pool, sql + "; INSERT INTO public.schema_migrations(version,description) VALUES ('test_pending_migration','transaction rollback fixture'); CREATE TABLE public.deliberate_failure_fixture(id int); SELECT 1/0;"),/division by zero/);
        assert.equal((await pool.query("SELECT to_regclass('public.deliberate_failure_fixture') AS relation")).rows[0].relation,null);
        assert.equal((await pool.query("SELECT 1 FROM public.schema_migrations WHERE version='test_pending_migration'")).rows.length,0);
        await pool.query("ALTER TABLE public.vehicle_reid_control RENAME TO fixture_authority_control");
        await assert.rejects(transaction(pool,sql),/Legacy migration baseline is incomplete/);
        await pool.query("ALTER TABLE public.fixture_authority_control RENAME TO vehicle_reid_control");

        const repository = new BlueIrisVehicleFrameRepository(pool);
        await repository.syncBlueIrisCameraInventory([{id:"eastlpr",name:"East LPR",enabled:true}]);
        const input = {camera:"eastlpr",cameraName:"East LPR",timestamp:read.timestamp,toleranceSeconds:3};
        assert.equal((await repository.findNearestRead(input)).id,read.id,"short-name ALPR read matches the selected display-name camera");
        await repository.syncBlueIrisCameraInventory([{id:"eastlpr",name:"East LPR",enabled:true},{id:"collision",name:"eastlpr",enabled:true}]);
        assert.equal(await repository.findNearestRead(input),null,"cross-colliding short/display aliases cannot silently select an owner");
        await repository.syncBlueIrisCameraInventory([{id:"eastlpr",name:"East LPR",enabled:true}]);
        assert.equal((await repository.findNearestRead({...input,timestamp:new Date(read.timestamp.getTime()+5000)})),null);
        await pool.query("INSERT INTO public.plate_reads(plate_number,camera_name,timestamp) VALUES ('TST5703','eastlpr',$1)",[read.timestamp]);
        assert.equal(await repository.findNearestRead(input),null,"multiple candidate owners require an explicit choice");
        assert.equal((await repository.findNearestRead({...input,readId:read.id})).id,read.id);
        const other = (await pool.query("SELECT id FROM public.plate_reads WHERE camera_name='Other Camera' LIMIT 1")).rows[0];
        assert.equal(await repository.findNearestRead({...input,readId:other.id}),null,"an explicit ID cannot cross camera bindings");
        const profile=await repository.saveOverviewPairProfile({sourceMode:"lpr_camera",sourceCameraName:"East LPR",sourceCameraShortName:"eastlpr",
          plateCameraName:"Logical ALPR",directionLabel:"Westbound",sourceRole:"primary",overviewContext:"street",expectedDeltaMs:0,toleranceMs:1500,priority:0,enabled:true});
        const queued=(await pool.query(`INSERT INTO public.plate_reads(plate_number,camera_name,timestamp,bi_trigger_direction_status,bi_trigger_direction_label,
          bi_trigger_direction_profile_version,bi_trigger_direction_algorithm,vehicle_image_queue_kind,vehicle_image_status,vehicle_image_updated_at)
          VALUES ('TST5704','Logical ALPR',CURRENT_TIMESTAMP-INTERVAL '30 seconds','ready','Westbound',1,'blue-iris-zone-crossing-v2-primary','overview','pending',CURRENT_TIMESTAMP) RETURNING id`)).rows[0];
        const claim=await repository.claimNextOverviewRead();
        assert.equal(claim.id,queued.id,"an LPR alias with a distinct recording display name can enter the automatic queue");
        assert.equal(claim.overview_source_mode,"lpr_camera");assert.equal(claim.overview_source_camera_short_name,"eastlpr");
        await pool.query("DELETE FROM public.plate_reads WHERE id=$1",[queued.id]);
        await pool.query("DELETE FROM public.vehicle_overview_pair_profiles WHERE id=$1",[profile.id]);

        const displays = new HomeAssistantDisplayService(pool);
        const grant = await displays.create({label:"Fixture display",allowedOrigin:"http://127.0.0.1:8123",cameraName:"eastlpr",days:1},{username:"fixture"});
        const stored = (await pool.query("SELECT * FROM public.home_assistant_display_grants WHERE id=$1",[grant.id])).rows[0];
        assert.notEqual(stored.token_hash,grant.token);
        assert.ok(!(JSON.stringify(await displays.list())).includes(grant.token));
        const auth = await displays.authorize(grant.id,"Bearer "+grant.token);
        assert.ok(auth);
        const visible = await displays.reads(auth);
        assert.ok(visible.reads.length > 0 && visible.reads.every(row=>row.camera_name==='eastlpr'));
        assert.equal(await displays.imagePath(auth,other.id),null);
        const handler = createDisplayReadHandler({service:displays,readImage:async()=>Buffer.from("fixture-image")});
        assert.equal((await handler(new Request("http://fixture",{headers:{authorization:"Bearer "+grant.token}}),{params:{grantId:grant.id,readId:read.id}})).status,200);
        await displays.revoke(grant.id);
        assert.equal(await displays.authorize(grant.id,"Bearer "+grant.token),null);
        assert.equal(await displays.publicGrant(grant.id),null);
        const expired = await displays.create({label:"Expired fixture",allowedOrigin:"http://127.0.0.1:8123",days:1},{username:"fixture"});
        await pool.query("UPDATE public.home_assistant_display_grants SET created_at=CURRENT_TIMESTAMP-INTERVAL '2 days',expires_at=CURRENT_TIMESTAMP-INTERVAL '1 day' WHERE id=$1",[expired.id]);
        assert.equal(await displays.authorize(expired.id,"Bearer "+expired.token),null);
        if (tag === "fresh" && browserTest) await browserTest({ ...server, database, pool, read });
        console.log(`${tag}: upgrade, preservation, visibility, replay, checksum rejection, atomic failure, camera binding, ambiguity, display scope, expiration and revocation passed`);
      } finally { await pool.end(); }
    }
  } finally {
    for (const database of databases.reverse()) {
      assert.match(database,/^codex_community_bugfix_[0-9a-f]{16}$/);
      await admin.query(`DROP DATABASE "${database}"`);
    }
    await admin.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = new URL(process.env.ALPR_COMMUNITY_TEST_SERVER_URL || "invalid:");
  if (url.protocol !== "postgresql:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname)) throw new Error("Use an explicitly configured disposable loopback PostgreSQL test server.");
  await exerciseCommunityBugfixes({ host:url.hostname.replace(/^\[|\]$/g,""),port:Number(url.port || 5432),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password) });
}
