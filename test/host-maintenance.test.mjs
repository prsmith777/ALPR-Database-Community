import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertFreshHostMaintenanceInventory, buildHostMaintenancePlan, candidateSetHash, canonicalHostInventoryRevision, HOST_MAINTENANCE_ACTIVATIONS,
  HOST_MAINTENANCE_CAPS, HOST_MAINTENANCE_CONFIRMATIONS, planForCategory,
} from "../lib/host-maintenance-policy.mjs";
import { inspectAndHeartbeatHostMaintenanceWorker, recoverStaleHostMaintenanceLeases, validateDatabaseBackupReceipt, validateHostMaintenanceReceipt } from "../lib/host-maintenance.mjs";
import { DisabledHostMaintenanceAdapter, InMemoryHostMaintenanceAdapter } from "../lib/host-maintenance-adapter.mjs";
import {
  getDatabaseBackupRequestStatus, getHostMaintenanceRequestStatus, hostMaintenanceControlInternals,
  requestHostMaintenanceExecution, setScheduledHostMaintenance,
} from "../lib/host-maintenance-control.mjs";

const GiB = 1024 ** 3;
function inventory(overrides={}) {
  const backup=(id,days,extra={})=>({id,identity:`identity-${id}`,bytes:GiB,createdAt:new Date(Date.UTC(2026,6,29)-days*86400000).toISOString(),
    checksumVerified:true,checksumSha256:"a".repeat(64),protected:false,currentRelease:false,rollbackChain:false,imageIds:[],
    environmentId:"staging",databaseIdentity:"db-staging",releaseId:`release-${id}`,schemaVersion:"schema-1",postgresFormat:"custom",
    device:"dev-1",inode:`inode-${id}`,modifiedAt:new Date(Date.UTC(2026,6,29)-days*86400000).toISOString(),partial:false,symlink:false,hardlinkCount:1,...extra});
  const result={healthy:true,revision:"temporary",environmentId:"staging",databaseIdentity:"db-staging",workerGeneration:"worker-1",
    measuredAt:"2026-07-29T00:00:00.000Z",hostLockAvailable:true,
    catalogComplete:true,releaseLedgerComplete:true,authoritativeCurrentReleaseCount:1,
    leases:{backupRestore:false,build:false,deploy:false,rollback:false},
    docker:{dedicatedNamespace:true,dedicatedHost:false,unknownImageCount:0,
      buildCache:[{id:"cache-1",identity:"cache-identity-1",bytes:100,unused:true,alprManaged:true,lastUsedAt:"2026-06-01T00:00:00Z",mutable:false,shared:false}],
      images:[{id:"image-1",identity:"image-identity-1",bytes:200,usedByContainer:false,currentRelease:false,preparedRelease:false,backupIds:[],
        alprManaged:true,knownInReleaseLedger:true,explicitlyRetired:true,retiredAt:"2026-07-01T00:00:00.000Z",buildLease:false,deployLease:false,
        stoppedContainerReference:false,rollbackReference:false},
        {id:"image-current",identity:"image-current-identity",bytes:200,usedByContainer:true,currentRelease:true,preparedRelease:false,backupIds:[],
        alprManaged:true,knownInReleaseLedger:true,explicitlyRetired:false,buildLease:false,deployLease:false,stoppedContainerReference:false,rollbackReference:false}]},
    backups:[backup("backup-1",60),backup("backup-2",55),backup("backup-3",50),backup("backup-4",45),backup("backup-5",40),backup("backup-6",35),
      backup("backup-current",90,{currentRelease:true})],...overrides};
  result.revision=canonicalHostInventoryRevision(result);return result;
}

test("host policy keeps newest five, all backups newer than 30 days, and protected chains",()=>{
  const plan=buildHostMaintenancePlan(inventory(),{now:new Date("2026-07-29T00:00:00Z")});
  assert.deepEqual(planForCategory(plan,"rollout-backups").items.map((item)=>item.id),["backup-1"]);
  assert.equal(planForCategory(plan,"unused-alpr-images").items.length,1);
  assert.equal(planForCategory(plan,"rollout-backups").items.some((item)=>item.kind==="unused-alpr-image"),false);
});

test("backup catalog anomalies and foreign database identities fail closed",()=>{
  const value=inventory();
  value.backups[0].symlink=true;
  const plan=planForCategory(buildHostMaintenancePlan(value,{now:new Date("2026-07-29T00:00:00Z")}),"rollout-backups");
  assert.equal(plan.items.length,0);
});

test("backup hard-link evidence must be explicit and valid",()=>{
  const missing=inventory();delete missing.backups[0].hardlinkCount;assert.throws(()=>buildHostMaintenancePlan(missing),/explicit positive integer/);
  const invalid=inventory();invalid.backups[0].hardlinkCount=0;assert.throws(()=>buildHostMaintenancePlan(invalid),/explicit positive integer/);
});

test("cache needs a dedicated namespace/host and unknown images fail closed",()=>{
  const value=inventory();value.docker.dedicatedNamespace=false;value.docker.unknownImageCount=1;
  const plan=buildHostMaintenancePlan(value,{now:new Date("2026-07-29T00:00:00Z")});
  assert.equal(planForCategory(plan,"docker-build-cache").candidateCount,0);
  assert.equal(planForCategory(plan,"unused-alpr-images").candidateCount,0);
});

test("cache eligibility requires age, immutability, exclusivity, and ALPR ownership",()=>{
  const base=inventory();
  assert.equal(planForCategory(buildHostMaintenancePlan(base,{minimumAgeDays:7,now:new Date("2026-07-29T00:00:00Z")}),"docker-build-cache").candidateCount,1);
  for(const change of[{lastUsedAt:"2026-07-28T00:00:00Z"},{mutable:true},{shared:true},{alprManaged:false},{unused:false}]){
    const value=inventory();Object.assign(value.docker.buildCache[0],change);value.revision=canonicalHostInventoryRevision(value);
    assert.equal(planForCategory(buildHostMaintenancePlan(value,{minimumAgeDays:7,now:new Date("2026-07-29T00:00:00Z")}),"docker-build-cache").candidateCount,0);
  }
});

test("canonical inventory revision is stable across measurement time but changes with protection state",()=>{
  const value=inventory();const first=value.revision;value.measuredAt="2026-07-29T00:01:00Z";
  assert.equal(canonicalHostInventoryRevision(value),first);
  value.leases.deploy=true;assert.notEqual(canonicalHostInventoryRevision(value),first);
});

test("categories have distinct confirmations, activations, and bounded caps",()=>{
  assert.equal(new Set(Object.values(HOST_MAINTENANCE_CONFIRMATIONS)).size,3);
  assert.equal(new Set(Object.values(HOST_MAINTENANCE_ACTIVATIONS)).size,3);
  assert.deepEqual(Object.keys(HOST_MAINTENANCE_CAPS).sort(),["docker-build-cache","rollout-backups","unused-alpr-images"]);
  for(const cap of Object.values(HOST_MAINTENANCE_CAPS)){assert.ok(cap.maxItems>0);assert.ok(cap.maxBytes>0);assert.ok(cap.maxDurationSeconds<=300);}
});

test("candidate hash binds backup filesystem and checksum evidence",()=>{
  const plan=planForCategory(buildHostMaintenancePlan(inventory(),{now:new Date("2026-07-29T00:00:00Z")}),"rollout-backups");
  const changed=structuredClone(plan);changed.items[0].inode="different";
  assert.notEqual(candidateSetHash(plan),candidateSetHash(changed));
  const foreign={...plan,databaseIdentity:"other-db"};
  assert.notEqual(candidateSetHash(plan),candidateSetHash(foreign));
});

test("application graph imports control plane only and control plane has no host adapter",async()=>{
  const [service,monitor,control,worker,workerEntry,actions]=await Promise.all([
    readFile(new URL("../lib/storage-maintenance-service.mjs",import.meta.url),"utf8"),
    readFile(new URL("../lib/storage-maintenance-monitor.mjs",import.meta.url),"utf8"),
    readFile(new URL("../lib/host-maintenance-control.mjs",import.meta.url),"utf8"),
    readFile(new URL("../lib/host-maintenance.mjs",import.meta.url),"utf8"),
    readFile(new URL("../lib/host-maintenance-worker.mjs",import.meta.url),"utf8"),
    readFile(new URL("../app/actions.js",import.meta.url),"utf8"),
  ]);
  assert.match(service,/host-maintenance-control\.mjs/);assert.doesNotMatch(service,/from "\.\/host-maintenance\.mjs"/);
  assert.match(monitor,/host-maintenance-control\.mjs/);assert.doesNotMatch(monitor,/from "\.\/host-maintenance\.mjs"/);
  assert.doesNotMatch(control,/host-maintenance-adapter|child_process|exec\(|spawn\(|docker\.sock|Remove-Item|rm -rf/);
  assert.match(worker,/host-maintenance-adapter\.mjs/);assert.doesNotMatch(actions,/host-maintenance-adapter|host-maintenance\.mjs/);
  assert.match(workerEntry,/processNextHostMaintenanceIntent/);
});

test("schema uses append-only evidence and three restrictive category boundaries",async()=>{
  const [schema,migrations]=await Promise.all([readFile(new URL("../schema.sql",import.meta.url),"utf8"),readFile(new URL("../migrations.sql",import.meta.url),"utf8")]);
  for(const source of [schema,migrations]){
    for(const table of ["host_maintenance_environment_identity","host_maintenance_approvals","host_maintenance_previews","host_maintenance_preview_consumptions","host_maintenance_receipts","host_maintenance_acknowledgements","host_maintenance_worker_state"])assert.match(source,new RegExp(table));
    assert.match(source,/unused-alpr-images/);assert.match(source,/unused-alpr-image/);assert.match(source,/ON DELETE RESTRICT/);
  }
  assert.match(migrations,/conrelid='public\.host_maintenance_approvals'::regclass/);
});

test("plaintext preview tokens are delivered once from an ephemeral row while immutable hash remains",async()=>{
  const [control,schema]=await Promise.all([readFile(new URL("../lib/host-maintenance-control.mjs",import.meta.url),"utf8"),readFile(new URL("../schema.sql",import.meta.url),"utf8")]);
  assert.match(control,/DELETE FROM public\.host_maintenance_preview_deliveries/);
  assert.match(control,/token_hash/);
  assert.match(control,/preview\.actor_user_id=\$2|p\.actor_user_id=\$2/);
  const previewDefinition=schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS public.host_maintenance_previews"),schema.indexOf("CREATE TABLE IF NOT EXISTS public.host_maintenance_preview_deliveries"));
  assert.doesNotMatch(previewDefinition,/opaque_token|delivered_at/);
  assert.match(schema,/Plaintext tokens are ephemeral here, never in immutable previews/);
  assert.match(schema,/'host_maintenance_approvals','host_maintenance_previews'/);
  assert.match(schema,/CREATE TRIGGER host_maintenance_append_only BEFORE UPDATE OR DELETE/);
});

test("inventory rejects stale, future, environment, and database mismatches",()=>{
  const value=inventory();
  assert.equal(assertFreshHostMaintenanceInventory(value,{now:new Date("2026-07-29T00:01:00Z"),expectedEnvironmentId:"staging",expectedDatabaseIdentity:"db-staging"}).revision,value.revision);
  assert.throws(()=>assertFreshHostMaintenanceInventory(value,{now:new Date("2026-07-29T00:03:00Z"),expectedEnvironmentId:"staging",expectedDatabaseIdentity:"db-staging"}),/stale/);
  assert.throws(()=>assertFreshHostMaintenanceInventory(value,{now:new Date("2026-07-28T23:59:00Z"),expectedEnvironmentId:"staging",expectedDatabaseIdentity:"db-staging"}),/future/);
  assert.throws(()=>assertFreshHostMaintenanceInventory(value,{now:new Date("2026-07-29T00:01:00Z"),expectedEnvironmentId:"production",expectedDatabaseIdentity:"db-staging"}),/environment mismatch/);
  assert.throws(()=>assertFreshHostMaintenanceInventory(value,{now:new Date("2026-07-29T00:01:00Z"),expectedEnvironmentId:"staging",expectedDatabaseIdentity:"other-db"}),/database identity mismatch/);
});

test("backup retention requires complete catalogs, one current release, and no active host leases",()=>{
  for(const mutate of [
    (value)=>{value.catalogComplete=false;},(value)=>{value.releaseLedgerComplete=false;},
    (value)=>{value.authoritativeCurrentReleaseCount=0;},(value)=>{value.authoritativeCurrentReleaseCount=2;},
    (value)=>{value.leases.backupRestore=true;},(value)=>{value.leases.build=true;},
    (value)=>{value.leases.deploy=true;},(value)=>{value.leases.rollback=true;},
  ]){const value=inventory();mutate(value);const plan=planForCategory(buildHostMaintenancePlan(value,{now:new Date("2026-07-29T00:00:00Z")}),"rollout-backups");assert.equal(plan.candidateCount,0);}
});

test("image eligibility requires both authoritative catalogs and worker hard-disables its schedule",async()=>{
  for(const key of["catalogComplete","releaseLedgerComplete"]){const value=inventory();value[key]=false;value.revision=canonicalHostInventoryRevision(value);
    assert.equal(planForCategory(buildHostMaintenancePlan(value,{now:new Date("2026-07-29T00:00:00Z")}),"unused-alpr-images").candidateCount,0);}
  const worker=await readFile(new URL("../lib/host-maintenance.mjs",import.meta.url),"utf8");
  assert.match(worker,/intent_type==="scheduled"&&intent\.category==="unused-alpr-images"/);
  assert.match(worker,/Scheduled unused-image pruning is hard-disabled by the worker/);
  const none=inventory();none.docker.images.find((image)=>image.currentRelease).currentRelease=false;none.revision=canonicalHostInventoryRevision(none);
  assert.equal(planForCategory(buildHostMaintenancePlan(none,{now:new Date("2026-07-29T00:00:00Z")}),"unused-alpr-images").candidateCount,0);
  const two=inventory();two.docker.images[0].currentRelease=true;two.revision=canonicalHostInventoryRevision(two);
  assert.equal(planForCategory(buildHostMaintenancePlan(two,{now:new Date("2026-07-29T00:00:00Z")}),"unused-alpr-images").candidateCount,0);
});

test("receipt validation enforces exact bindings, set equality, totals, and caps",()=>{
  const request={environmentId:"staging",databaseIdentity:"db-staging",workerGeneration:"worker-1",inventoryRevision:"revision-1",candidateSetHash:"a".repeat(64),
    maxDurationSeconds:300,maxBytes:1000,candidateBytes:300,items:[{kind:"rollout-backup",id:"one",identity:"identity-one",bytes:100},{kind:"rollout-backup",id:"two",identity:"identity-two",bytes:200}]};
  const valid={hostLockHeld:true,environmentId:"staging",databaseIdentity:"db-staging",workerGeneration:"worker-1",inventoryRevision:"revision-1",candidateSetHash:"a".repeat(64),durationMs:10,reclaimedBytes:300,
    results:[{kind:"rollout-backup",id:"one",identity:"identity-one",status:"deleted",reclaimedBytes:100},{kind:"rollout-backup",id:"two",identity:"identity-two",status:"quarantined",reclaimedBytes:200}]};
  assert.equal(validateHostMaintenanceReceipt(valid,request).reclaimedBytes,300);
  assert.throws(()=>validateHostMaintenanceReceipt({...valid,environmentId:"production"},request),/binding/);
  assert.throws(()=>validateHostMaintenanceReceipt({...valid,results:[valid.results[0],valid.results[0]]},request),/extra, duplicate/);
  assert.throws(()=>validateHostMaintenanceReceipt({...valid,results:[valid.results[0]]},request),/set size/);
  assert.throws(()=>validateHostMaintenanceReceipt({...valid,results:[...valid.results,{kind:"rollout-backup",id:"extra",status:"deleted",reclaimedBytes:0}]},request),/set size/);
  assert.throws(()=>validateHostMaintenanceReceipt({...valid,reclaimedBytes:299},request),/total/);
  assert.throws(()=>validateHostMaintenanceReceipt({...valid,durationMs:300001},request),/duration/);
  assert.throws(()=>validateHostMaintenanceReceipt({...valid,results:[{...valid.results[0],reclaimedBytes:-1},valid.results[1]]},request),/bytes/);
});

test("database backup uses an explicit versioned capability and a bound verified receipt",async()=>{
  assert.deepEqual(new DisabledHostMaintenanceAdapter().capabilities,[]);
  const adapter=new InMemoryHostMaintenanceAdapter(inventory());
  assert.deepEqual(adapter.capabilities,["database-backup-create-v1"]);
  const request={operation:"postgres-database-backup",format:"custom",environmentId:"staging",databaseIdentity:"db-staging",workerGeneration:"worker-1",requestId:42,
    maxBytes:50*1024**3,deadline:new Date(Date.now()+60_000).toISOString()};
  const receipt=await adapter.backup(request);
  const validated=validateDatabaseBackupReceipt(receipt,request);
  assert.match(validated.filename,/^alpr-postgres-[0-9]{8}T[0-9]{6}Z-42[.]dump$/);
  assert.equal(validated.sizeBytes,1024);
  for(const invalid of[
    {...receipt,filename:"../escape.dump"},{...receipt,format:"plain"},{...receipt,verified:false},
    {...receipt,checksumSha256:"bad"},{...receipt,requestId:43},{...receipt,sizeBytes:0},{...receipt,sizeBytes:request.maxBytes+1},
  ])assert.throws(()=>validateDatabaseBackupReceipt(invalid,request),/Database-backup receipt/);
});

test("manual database backup is a distinct no-input fail-closed control plane",async()=>{
  const [schema,migrations,control,worker,actions,panel]=await Promise.all([
    readFile(new URL("../schema.sql",import.meta.url),"utf8"),readFile(new URL("../migrations.sql",import.meta.url),"utf8"),
    readFile(new URL("../lib/host-maintenance-control.mjs",import.meta.url),"utf8"),readFile(new URL("../lib/host-maintenance.mjs",import.meta.url),"utf8"),
    readFile(new URL("../app/actions.js",import.meta.url),"utf8"),readFile(new URL("../app/settings/HostMaintenancePanel.jsx",import.meta.url),"utf8"),
  ]);
  for(const source of[schema,migrations]){
    assert.match(source,/host_database_backup_requests/);
    assert.match(source,/idx_host_database_backup_requests_one_active/);
    assert.match(source,/WHERE status IN \('pending', 'processing'\)|WHERE status IN \('pending','processing'\)/);
    assert.match(source,/database-backup-create-v1/);
    assert.match(source,/database_backup_capability_at/);
    assert.match(source,/replay_count INTEGER NOT NULL DEFAULT 0 CHECK\s*\(replay_count BETWEEN 0 AND 2\)/);
    assert.match(source,/checksum_sha256/);
    assert.match(source,/verified BOOLEAN NOT NULL DEFAULT FALSE/);
  }
  assert.match(control,/databaseBackupRequired:true/);
  assert.match(control,/database_backup_capability!=="database-backup-create-v1"/);
  assert.match(control,/database_backup_capability_at/);
  assert.match(control,/actor_user_id=\$4/);
  assert.match(control,/scheduled:false,restoreSupported:false/);
  assert.match(worker,/operation:"postgres-database-backup",format:"custom"/);
  const backupBranch=worker.slice(worker.indexOf("const backup=databaseBackupSupported"),worker.indexOf("const intent=await claimIntent"));
  assert.doesNotMatch(backupBranch,/recordWorkerError/);
  assert.match(worker,/maxBytes:DATABASE_BACKUP_MAX_BYTES/);
  assert.match(worker,/switch\(intent\.intent_type\)/);
  assert.match(worker,/default:throw new Error\("Unknown host-maintenance intent type"\)/);
  assert.doesNotMatch(control,/child_process|exec\(|spawn\(|pg_dump|backupRoot|backupPath/);
  assert.match(actions,/createDatabaseBackup[\s\S]*requirePermission\("maintenance\.manage"\)/);
  assert.match(panel,/Create database backup/);
  assert.match(panel,/database-backup-create-v1 capability/);
  assert.match(panel,/accepts no command, path, filename, schedule, or restore input/);
  assert.doesNotMatch(panel,/checksumSha256|backupPath|commandArgs/);
});

test("database-backup capability expires immediately when an old worker refreshes only the general heartbeat",async()=>{
  const now=new Date("2026-07-30T18:00:00Z");
  const bindings={environmentId:"staging",databaseIdentity:"db-staging"};
  const database={query:async(sql)=>{
    if(sql.includes("host_maintenance_environment_identity"))return{rowCount:1,rows:[{}]};
    return{rowCount:1,rows:[{database_identity:"db-staging",heartbeat_at:now,inventory_measured_at:now,
      worker_generation:"worker-old",inventory_revision:"revision-old",database_backup_capability:"database-backup-create-v1",
      database_backup_capability_at:new Date(now.getTime()-60_000)}]};
  }};
  await assert.rejects(()=>hostMaintenanceControlInternals.assertHealthyWorker(database,now,bindings,{databaseBackupRequired:true}),/adapter is not installed/);
});

test("database-backup status polling is actor and environment bound",async()=>{
  const queries=[];const executor={query:async(sql,params)=>{queries.push({sql,params});
    if(sql.includes("host_maintenance_environment_identity"))return{rowCount:1,rows:[{}]};
    return{rowCount:0,rows:[]};
  }};
  const previousEnvironment=process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;
  const previousIdentity=process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;
  process.env.HOST_MAINTENANCE_ENVIRONMENT_ID="staging";process.env.HOST_MAINTENANCE_DATABASE_IDENTITY="db-staging";
  try{await assert.rejects(()=>getDatabaseBackupRequestStatus({executor,requestId:9,actor:{id:22}}),/request is invalid/);}
  finally{
    if(previousEnvironment===undefined)delete process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;else process.env.HOST_MAINTENANCE_ENVIRONMENT_ID=previousEnvironment;
    if(previousIdentity===undefined)delete process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;else process.env.HOST_MAINTENANCE_DATABASE_IDENTITY=previousIdentity;
  }
  const statusQuery=queries.find(({sql})=>sql.includes("host_database_backup_requests"));
  assert.match(statusQuery.sql,/actor_user_id=\$4/);assert.deepEqual(statusQuery.params,[9,"staging","db-staging",22]);
});

test("worker failure, recovery, and completion SQL preserve atomic lease ownership",async()=>{
  const worker=await readFile(new URL("../lib/host-maintenance.mjs",import.meta.url),"utf8");
  assert.match(worker,/async function failIntentAtomic[\s\S]*BEGIN[\s\S]*writeFailure[\s\S]*COMMIT/);
  assert.match(worker,/HOST_MAINTENANCE_FATAL_INVARIANT: unable to persist authoritative failure/);
  assert.match(worker,/FOR UPDATE SKIP LOCKED/);
  assert.match(worker,/status='processing' AND locked_by=\$2 RETURNING id/);
  assert.match(worker,/assertOwned\(intentDone,"intent completion"\)/);
  assert.match(worker,/circuit_breaker_generation=circuit_breaker_generation\+1/);
  assert.match(worker,/host_maintenance_receipts/);
  assert.match(worker,/audit_events/);
  assert.match(worker,/maintenance[.]database_backup_replayed/);
  assert.match(worker,/status='pending',started_at=NULL,completed_at=NULL,worker_generation=NULL/);
  assert.match(worker,/if\(attempts>=2\)/);
  assert.doesNotMatch(worker,/SELECT count\(\*\)::int AS count FROM public[.]audit_events/);
  assert.match(worker,/cleanupDatabaseBackupRequest/);
  assert.match(worker,/databaseBackupReplayRequired/);
});

test("stale manual database backup replays the same bounded request row",async()=>{
  const queries=[];
  const client={query:async(sql,params)=>{queries.push({sql,params});
    if(sql.includes("host_maintenance_environment_identity"))return{rowCount:1,rows:[{}]};
    if(sql.includes("FROM public.host_maintenance_intents"))return{rowCount:0,rows:[]};
    if(sql.includes("FROM public.host_database_backup_requests"))return{rowCount:1,rows:[{id:42,actor_user_id:9,replay_count:0}]};
    return{rowCount:1,rows:[{}]};},release(){}};
  const executor={connect:async()=>client};
  const result=await recoverStaleHostMaintenanceLeases({executor,now:new Date("2026-07-30T20:00:00Z"),leaseSeconds:600,
    databaseBackupSupported:true,expectedEnvironmentId:"staging",expectedDatabaseIdentity:"db-staging"});
  assert.deepEqual(result,{recovered:1});
  const replay=queries.find(({sql})=>sql.includes("SET status='pending'"));
  assert.ok(replay);assert.equal(replay.params[0],42);
  assert.ok(queries.some(({sql})=>sql.includes("maintenance.database_backup_replayed")));
  assert.ok(!queries.some(({sql})=>/SELECT[\s\S]*FROM public[.]audit_events/.test(sql)));
});

test("exhausted stale database backup cleans its exact artifact before failure",async()=>{
  const queries=[];let cleaned=false;
  const client={query:async(sql,params)=>{queries.push({sql,params});
    if(sql.includes("host_maintenance_environment_identity"))return{rowCount:1,rows:[{}]};
    if(sql.includes("FROM public.host_maintenance_intents"))return{rowCount:0,rows:[]};
    if(sql.includes("FROM public.host_database_backup_requests"))return{rowCount:1,rows:[{id:43,actor_user_id:9,replay_count:2}]};
    return{rowCount:1,rows:[{}]};},release(){}};
  const adapter={cleanupDatabaseBackupRequest:async(request)=>{cleaned=request.requestId===43;return{status:"cleaned"};}};
  const result=await recoverStaleHostMaintenanceLeases({executor:{connect:async()=>client},adapter,now:new Date("2026-07-30T20:00:00Z"),
    databaseBackupSupported:true,expectedEnvironmentId:"staging",expectedDatabaseIdentity:"db-staging"});
  assert.deepEqual(result,{recovered:1});assert.equal(cleaned,true);
  assert.ok(queries.some(({sql})=>sql.includes("SET status='failed'")));
});

test("schema evidence tables are append-only and environment bindings are durable",async()=>{
  const [schema,migrations]=await Promise.all([readFile(new URL("../schema.sql",import.meta.url),"utf8"),readFile(new URL("../migrations.sql",import.meta.url),"utf8")]);
  for(const source of[schema,migrations]){
    assert.match(source,/reject_host_maintenance_evidence_mutation/);
    assert.match(source,/BEFORE UPDATE OR DELETE/);
    assert.match(source,/host_maintenance_preview_intent_binding_fkey/);
    assert.match(source,/environment_id VARCHAR\(200\) NOT NULL/);
    assert.match(source,/inventory_measured_at TIMESTAMPTZ NOT NULL/);
    assert.match(source,/'host_maintenance_environment_identity','host_maintenance_approvals'/);
  }
});

test("control plane requires explicit environment and uses worker-owned ack evidence",async()=>{
  const [control,actions,compose,example]=await Promise.all([
    readFile(new URL("../lib/host-maintenance-control.mjs",import.meta.url),"utf8"),readFile(new URL("../app/actions.js",import.meta.url),"utf8"),
    readFile(new URL("../docker-compose.yml",import.meta.url),"utf8"),readFile(new URL("../.env.example",import.meta.url),"utf8")]);
  assert.match(control,/HOST_MAINTENANCE_ENVIRONMENT_ID/);assert.match(control,/last_error IS NULL/);assert.match(control,/inventoryMeasuredAt:worker\.inventory_measured_at/);
  assert.match(control,/SELECT 1 FROM public\.host_maintenance_environment_identity/);
  const worker=await readFile(new URL("../lib/host-maintenance.mjs",import.meta.url),"utf8");
  assert.match(worker,/Host worker database identity mismatch/);
  assert.match(worker,/await assertDatabaseIdentity\(pool,bindings\)/);
  assert.doesNotMatch(actions,/evidence: input\.evidence/);assert.match(control,/HOST_MAINTENANCE_FAILED/);
  assert.match(compose,/HOST_MAINTENANCE_DATABASE_IDENTITY/);assert.match(example,/HOST_MAINTENANCE_ENVIRONMENT_ID=/);
});

test("database identity mismatch prevents token delivery, mutations, and worker-state writes",async()=>{
  const priorEnvironment=process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;
  const priorDatabase=process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;
  process.env.HOST_MAINTENANCE_ENVIRONMENT_ID="staging";
  process.env.HOST_MAINTENANCE_DATABASE_IDENTITY="db-staging";
  try{
    const directQueries=[];
    const direct={query:async(sql)=>{directQueries.push(sql);return{rowCount:0,rows:[]};}};
    await assert.rejects(()=>getHostMaintenanceRequestStatus({executor:direct,requestId:1,actor:{id:1}}),/identity/);
    assert.equal(directQueries.length,1);
    assert.doesNotMatch(directQueries.join("\n"),/DELETE FROM public\.host_maintenance_preview_deliveries/);

    for(const operation of[
      (executor)=>requestHostMaintenanceExecution({executor,actor:{id:1},previewToken:"token",confirmation:"no"}),
      (executor)=>setScheduledHostMaintenance({executor,actor:{id:1},category:"docker-build-cache",enabled:false}),
    ]){
      const queries=[];
      const client={query:async(sql)=>{queries.push(sql);return /host_maintenance_environment_identity/.test(sql)?{rowCount:0,rows:[]}:{rowCount:0,rows:[]};},release(){}};
      await assert.rejects(()=>operation({connect:async()=>client}),/identity/);
      assert.doesNotMatch(queries.join("\n"),/INSERT INTO public\.host_maintenance_intents|UPDATE public\.host_maintenance_config|INSERT INTO public\.host_maintenance_preview_consumptions/);
    }

    const workerQueries=[];
    const workerExecutor={query:async(sql)=>{workerQueries.push(sql);return{rowCount:0,rows:[]};}};
    let inspected=false;
    await assert.rejects(()=>inspectAndHeartbeatHostMaintenanceWorker({executor:workerExecutor,adapter:{inspect:async()=>{inspected=true;}},now:new Date()}),/identity/);
    assert.equal(inspected,false);
    assert.doesNotMatch(workerQueries.join("\n"),/UPDATE public\.host_maintenance_worker_state/);
  }finally{
    if(priorEnvironment===undefined)delete process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;else process.env.HOST_MAINTENANCE_ENVIRONMENT_ID=priorEnvironment;
    if(priorDatabase===undefined)delete process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;else process.env.HOST_MAINTENANCE_DATABASE_IDENTITY=priorDatabase;
  }
});

test("worker-only entry exports idle heartbeat and worker operations only",async()=>{
  const entry=await readFile(new URL("../lib/host-maintenance-worker.mjs",import.meta.url),"utf8");
  assert.match(entry,/inspectAndHeartbeatHostMaintenanceWorker/);
  assert.doesNotMatch(entry,/requestHostMaintenancePreview|getHostMaintenanceOverview|setScheduledHostMaintenance/);
});

test("monitor trusts sanitized worker health status for stale and recovery alerts",async()=>{
  const monitor=await readFile(new URL("../lib/storage-maintenance-monitor.mjs",import.meta.url),"utf8");
  assert.match(monitor,/workerRequired && hostMaintenance\.worker\?\.status !== "healthy"/);
  assert.doesNotMatch(monitor,/this\.now\(\)\.getTime\(\) - workerHeartbeat\.getTime\(\)/);
  assert.match(monitor,/workerStatus: hostMaintenance\.worker\?\.status/);
});

test("host maintenance UI keeps categories separate and fails controls closed",async()=>{
  const [panel,container]=await Promise.all([
    readFile(new URL("../app/settings/HostMaintenancePanel.jsx",import.meta.url),"utf8"),
    readFile(new URL("../app/settings/StorageMaintenancePanel.jsx",import.meta.url),"utf8"),
  ]);
  for(const label of ["Docker build cache","Unused ALPR release images","Verified rollout backups"])assert.match(panel,new RegExp(label));
  assert.match(panel,/Candidate counts are unavailable, not zero/);
  assert.match(panel,/Preview complete: 0 candidates \(0 B\)/);
  assert.match(panel,/confirmationPhrases\?\.\[definition\.key\]/);
  assert.match(panel,/activationPhrases\?\.\[definition\.key\]/);
  assert.match(panel,/retainedVerifiedCount: String\(config\.retainedVerifiedCount \?\? 5\)/);
  assert.match(panel,/minimumAgeDays: String\(config\.minimumAgeDays \?\? \(key === "docker-build-cache" \? 7 : 30\)\)/);
  assert.match(panel,/Automation unsupported: retired release images remain preview-and-confirm manual only/);
  assert.match(panel,/non-mutable, non-shared cache unused for at least seven days/);
  assert.match(panel,/fixed seven-day worker grace/);
  assert.match(panel,/id="host-backup-age" type="number" min="30"/);
  assert.match(panel,/!workerHealthy \|\| !configured \|\| effectiveConfig\.circuitBreakerOpen \|\| isPending/);
  assert.match(panel,/candidateCount > 0/);
  assert.match(panel,/!previewExpired/);
  assert.match(panel,/never prune Docker volumes, containers, or networks/);
  assert.doesNotMatch(panel,/Request \{request\.requestId\}/);
  assert.doesNotMatch(panel,/circuitBreakerReason/);
  assert.doesNotMatch(panel,/lastError\}/);
  assert.match(container,/<HostMaintenancePanel/);
});
