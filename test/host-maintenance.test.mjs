import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertFreshHostMaintenanceInventory, buildHostMaintenancePlan, candidateSetHash, canonicalHostInventoryRevision, HOST_MAINTENANCE_ACTIVATIONS,
  HOST_MAINTENANCE_ACKNOWLEDGEMENTS, HOST_MAINTENANCE_CAPS, HOST_MAINTENANCE_CONFIRMATIONS, HOST_MAINTENANCE_IMAGE_POLICY_CONFIRMATION, planForCategory,
} from "../lib/host-maintenance-policy.mjs";
import { hostMaintenanceWorkerInternals, inspectAndHeartbeatHostMaintenanceWorker, recoverStaleHostMaintenanceLeases, validateDatabaseBackupReceipt, validateHostMaintenanceReceipt } from "../lib/host-maintenance.mjs";
import { DisabledHostMaintenanceAdapter, InMemoryHostMaintenanceAdapter } from "../lib/host-maintenance-adapter.mjs";
import {
  acknowledgeHostMaintenanceBreaker, getDatabaseBackupRequestStatus, getHostMaintenanceRequestStatus, hostMaintenanceControlInternals,
  requestDatabaseBackup, requestHostMaintenanceExecution, setManualImageRetentionPolicy, setScheduledHostMaintenance,
} from "../lib/host-maintenance-control.mjs";

const GiB = 1024 ** 3;
function inventory(overrides={}) {
  const backup=(id,days,extra={})=>({id,identity:`identity-${id}`,bytes:GiB,createdAt:new Date(Date.UTC(2026,6,29)-days*86400000).toISOString(),
    checksumVerified:true,checksumSha256:"a".repeat(64),protected:false,currentRelease:false,rollbackChain:false,imageIds:[],
    environmentId:"staging",databaseIdentity:"db-staging",releaseId:`release-${id}`,schemaVersion:"schema-1",postgresFormat:"custom",
    device:"dev-1",inode:`inode-${id}`,modifiedAt:new Date(Date.UTC(2026,6,29)-days*86400000).toISOString(),partial:false,symlink:false,hardlinkCount:1,...extra});
  const result={healthy:true,revision:"temporary",environmentId:"staging",databaseIdentity:"db-staging",workerGeneration:"worker-1",
    measuredAt:"2026-07-29T00:00:00.000Z",hostLockAvailable:true,
    catalogComplete:true,releaseLedgerComplete:true,workerImageLedgerComplete:true,authoritativeCurrentReleaseCount:1,authoritativeCurrentWorkerCount:1,
    leases:{backupRestore:false,build:false,deploy:false,rollback:false},
    docker:{dedicatedNamespace:true,dedicatedHost:false,unknownImageCount:0,
      buildCache:[{id:"cache-1",identity:"cache-identity-1",bytes:100,unused:true,alprManaged:true,lastUsedAt:"2026-06-01T00:00:00Z",mutable:false,shared:false}],
      images:[{id:"image-1",identity:"image-identity-1",bytes:200,usedByContainer:false,currentRelease:false,preparedRelease:false,backupIds:[],
        alprManaged:true,knownInReleaseLedger:true,explicitlyRetired:true,retiredAt:"2026-07-01T00:00:00.000Z",buildLease:false,deployLease:false,
        stoppedContainerReference:false,rollbackReference:false},
        {id:"image-current",identity:"image-current-identity",bytes:200,usedByContainer:true,currentRelease:true,preparedRelease:false,backupIds:[],
        alprManaged:true,knownInReleaseLedger:true,explicitlyRetired:false,buildLease:false,deployLease:false,stoppedContainerReference:false,rollbackReference:false},
        {id:"worker-current",identity:"worker-current-identity",bytes:250,usedByContainer:false,currentRelease:false,currentWorker:true,preparedRelease:false,backupIds:[],
        alprManaged:true,knownInReleaseLedger:true,explicitlyRetired:false,buildLease:false,deployLease:false,stoppedContainerReference:false,rollbackReference:false,imageClass:"host-worker"}]},
    backups:[backup("backup-1",60),backup("backup-2",55),backup("backup-3",50),backup("backup-4",45),backup("backup-5",40),backup("backup-6",35),
      backup("backup-current",90,{currentRelease:true})],...overrides};
  result.revision=canonicalHostInventoryRevision(result);return result;
}

function bindHostMaintenanceTestEnvironment(t) {
  const previousEnvironment=process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;
  const previousIdentity=process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;
  process.env.HOST_MAINTENANCE_ENVIRONMENT_ID="staging";
  process.env.HOST_MAINTENANCE_DATABASE_IDENTITY="db-staging";
  t.after(()=>{
    if(previousEnvironment===undefined)delete process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;
    else process.env.HOST_MAINTENANCE_ENVIRONMENT_ID=previousEnvironment;
    if(previousIdentity===undefined)delete process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;
    else process.env.HOST_MAINTENANCE_DATABASE_IDENTITY=previousIdentity;
  });
}

function hostAcknowledgementHarness({
  category="unused-alpr-images",
  configOverrides={},
  workerOverrides={},
  failedRows,
  filterFailedRowsByBreaker=false,
  insertError=null,
  clearRowCount=1,
}={}) {
  const breakerOpenedAt="2026-08-10T12:00:00.000Z";
  const states=new Map([
    ["unused-alpr-images",{category:"unused-alpr-images",scheduled_enabled:false,next_run_at:null,circuit_breaker_open:true,
      circuit_breaker_opened_at:breakerOpenedAt,circuit_breaker_reason:"failed",circuit_breaker_generation:7}],
    ["docker-build-cache",{category:"docker-build-cache",scheduled_enabled:false,next_run_at:null,circuit_breaker_open:true,
      circuit_breaker_opened_at:breakerOpenedAt,circuit_breaker_reason:"failed",circuit_breaker_generation:8}],
  ]);
  Object.assign(states.get(category),configOverrides);
  const worker={database_identity:"db-staging",heartbeat_at:"2026-08-10T12:04:00.000Z",inventory_measured_at:"2026-08-10T12:03:00.000Z",
    worker_generation:"worker-fixed",inventory_revision:"inventory-after-failure",...workerOverrides};
  const rows=failedRows===undefined?[{id:42,failed_worker_generation:"worker-old",failure_receipt_at:breakerOpenedAt}]:failedRows;
  const calls=[];let released=false;let connects=0;
  const client={query:async(sql,params=[])=>{calls.push({sql,params});
    if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return{rowCount:0,rows:[]};
    if(sql.includes("host_maintenance_environment_identity"))return{rowCount:1,rows:[{}]};
    if(sql.includes("SELECT * FROM public.host_maintenance_config")){
      const state=states.get(params[0]);return{rowCount:state?1:0,rows:state?[{...state}]:[]};
    }
    if(sql.includes("host_maintenance_worker_state"))return{rowCount:1,rows:[{...worker}]};
    if(sql.includes("FROM public.host_maintenance_intents i JOIN public.host_maintenance_receipts")){
      const selected=filterFailedRowsByBreaker?rows.filter((row)=>new Date(row.failure_receipt_at).getTime()===new Date(params[3]).getTime()):rows;
      return{rowCount:selected.length,rows:selected};
    }
    if(sql.includes("INSERT INTO public.host_maintenance_acknowledgements")){
      if(insertError)throw insertError;return{rowCount:1,rows:[]};
    }
    if(sql.includes("UPDATE public.host_maintenance_config")){
      if(clearRowCount===1){const state=states.get(params[0]);state.circuit_breaker_open=false;state.circuit_breaker_opened_at=null;
        state.circuit_breaker_reason=null;state.scheduled_enabled=false;state.next_run_at=null;}
      return{rowCount:clearRowCount,rows:clearRowCount?[{category:params[0]}]:[]};
    }
    throw new Error(`Unexpected acknowledgement query: ${sql}`);
  },release(){released=true;}};
  return{calls,client,states,get connects(){return connects;},get released(){return released;},executor:{connect:async()=>{connects+=1;return client;}}};
}

function hostExecutionHarness({
  previewCreatedAt="2026-08-10T12:01:00.000Z",
  breakerOpen=false,
  breakerGeneration=0,
  acknowledgement=null,
}={}) {
  const calls=[];let released=false;
  const preview={id:201,intent_id:101,category:"unused-alpr-images",created_at:previewCreatedAt};
  const client={query:async(sql,params=[])=>{calls.push({sql,params});
    if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return{rowCount:0,rows:[]};
    if(sql.includes("host_maintenance_environment_identity"))return{rowCount:1,rows:[{}]};
    if(sql.includes("FROM public.host_maintenance_previews p JOIN public.host_maintenance_intents"))return{rowCount:1,rows:[preview]};
    if(sql.includes("SELECT circuit_breaker_open,circuit_breaker_generation FROM public.host_maintenance_config"))
      return{rowCount:1,rows:[{circuit_breaker_open:breakerOpen,circuit_breaker_generation:breakerGeneration}]};
    if(sql.includes("FROM public.host_maintenance_acknowledgements"))return{rowCount:acknowledgement?1:0,rows:acknowledgement?[acknowledgement]:[]};
    if(sql.includes("INSERT INTO public.host_maintenance_intents"))return{rowCount:1,rows:[{id:303}]};
    if(sql.includes("INSERT INTO public.host_maintenance_preview_consumptions"))return{rowCount:1,rows:[]};
    throw new Error(`Unexpected execution query: ${sql}`);
  },release(){released=true;}};
  return{calls,preview,executor:{connect:async()=>client},get released(){return released;}};
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

test("image retirement grace is configurable but never below one day",()=>{
  const value=inventory();value.docker.images[0].retiredAt="2026-07-27T00:00:00.000Z";value.revision=canonicalHostInventoryRevision(value);
  assert.equal(planForCategory(buildHostMaintenancePlan(value,{minimumAgeDays:3,now:new Date("2026-07-29T00:00:00Z")}),"unused-alpr-images").candidateCount,0);
  assert.equal(planForCategory(buildHostMaintenancePlan(value,{minimumAgeDays:1,now:new Date("2026-07-29T00:00:00Z")}),"unused-alpr-images").candidateCount,1);
  assert.equal(planForCategory(buildHostMaintenancePlan(value,{minimumAgeDays:0,now:new Date("2026-07-29T00:00:00Z")}),"unused-alpr-images").candidateCount,1);
});

test("the exactly attested current host-worker image is always protected",()=>{
  const value=inventory();const worker=value.docker.images.find((image)=>image.currentWorker);worker.explicitlyRetired=true;worker.retiredAt="2026-07-01T00:00:00.000Z";value.revision=canonicalHostInventoryRevision(value);
  const plan=planForCategory(buildHostMaintenancePlan(value,{minimumAgeDays:1,now:new Date("2026-07-29T00:00:00Z")}),"unused-alpr-images");
  assert.equal(plan.items.some((item)=>item.id==="worker-current"),false);
});

test("manual image grace changes are typed, audited, bounded, and keep scheduling disabled",async(t)=>{
  const previousEnvironment=process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;
  const previousIdentity=process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;
  process.env.HOST_MAINTENANCE_ENVIRONMENT_ID="staging";
  process.env.HOST_MAINTENANCE_DATABASE_IDENTITY="db-staging";
  t.after(()=>{
    if(previousEnvironment===undefined)delete process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;
    else process.env.HOST_MAINTENANCE_ENVIRONMENT_ID=previousEnvironment;
    if(previousIdentity===undefined)delete process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;
    else process.env.HOST_MAINTENANCE_DATABASE_IDENTITY=previousIdentity;
  });
  await assert.rejects(()=>setManualImageRetentionPolicy({confirmation:"wrong"}),/SET IMAGE RETIREMENT GRACE/);
  const queries=[];
  const client={query:async(sql,params=[])=>{queries.push({sql,params});
    if(sql.includes("host_maintenance_environment_identity"))return{rowCount:1,rows:[{}]};
    if(sql.includes("SELECT * FROM public.host_maintenance_config"))return{rowCount:1,rows:[{category:"unused-alpr-images",automation_supported:false,
      scheduled_enabled:false,interval_seconds:604800,retained_verified_count:5,minimum_age_days:7,activation_revision:4,circuit_breaker_open:false,circuit_breaker_generation:0}]};
    if(sql.includes("UPDATE public.host_maintenance_config"))return{rowCount:1,rows:[{category:"unused-alpr-images",automation_supported:false,
      scheduled_enabled:false,interval_seconds:604800,retained_verified_count:5,minimum_age_days:params[0],activation_revision:params[1],
      circuit_breaker_open:false,circuit_breaker_generation:0}]};
    return{rowCount:1,rows:[]};},release(){}};
  const result=await setManualImageRetentionPolicy({executor:{connect:async()=>client},actor:{id:9},minimumAgeDays:0,
    confirmation:HOST_MAINTENANCE_IMAGE_POLICY_CONFIRMATION,now:new Date("2026-08-03T18:00:00Z")});
  assert.equal(result.minimumAgeDays,1);assert.equal(result.scheduledEnabled,false);assert.equal(result.activationRevision,5);
  const approval=queries.find(({sql})=>sql.includes("INSERT INTO public.host_maintenance_approvals"));
  assert.deepEqual(approval.params.slice(0,5),[5,604800,5,1,9]);
  assert.ok(queries.findIndex(({sql})=>sql==="BEGIN")<queries.indexOf(approval));
  assert.ok(queries.indexOf(approval)<queries.findIndex(({sql})=>sql.includes("UPDATE public.host_maintenance_config")));
  assert.match(queries.find(({sql})=>sql.includes("UPDATE public.host_maintenance_config")).sql,/scheduled_enabled=FALSE,next_run_at=NULL/);
});

test("host breaker acknowledgement binds the exact current failure and commits atomically",async(t)=>{
  bindHostMaintenanceTestEnvironment(t);
  let invalidConnects=0;
  await assert.rejects(()=>acknowledgeHostMaintenanceBreaker({
    executor:{connect:async()=>{invalidConnects+=1;throw new Error("must not connect");}},actor:{id:9},category:"unused-alpr-images",confirmation:"acknowledge",
  }),/ACKNOWLEDGE UNUSED IMAGE FAILURE/);
  assert.equal(invalidConnects,0,"an invalid typed phrase fails before database access");

  const now=new Date("2026-08-10T12:05:00.000Z");
  const harness=hostAcknowledgementHarness();
  const result=await acknowledgeHostMaintenanceBreaker({executor:harness.executor,actor:{id:9},category:"unused-alpr-images",
    confirmation:HOST_MAINTENANCE_ACKNOWLEDGEMENTS["unused-alpr-images"],now});
  assert.deepEqual(result,{category:"unused-alpr-images",acknowledged:true,breakerGeneration:7});
  assert.equal(harness.connects,1);assert.equal(harness.released,true);

  const failure=harness.calls.find(({sql})=>sql.includes("FROM public.host_maintenance_intents i JOIN public.host_maintenance_receipts"));
  assert.ok(failure);assert.match(failure.sql,/i\.completed_at=\$4::timestamptz/);assert.match(failure.sql,/r\.created_at=\$4::timestamptz/);
  assert.deepEqual(failure.params.slice(0,3),["unused-alpr-images","staging","db-staging"]);
  assert.equal(new Date(failure.params[3]).toISOString(),"2026-08-10T12:00:00.000Z");

  const acknowledgement=harness.calls.find(({sql})=>sql.includes("INSERT INTO public.host_maintenance_acknowledgements"));
  assert.ok(acknowledgement);assert.deepEqual(acknowledgement.params.slice(0,4),["unused-alpr-images",7,42,9]);
  assert.deepEqual(JSON.parse(acknowledgement.params[4]),{
    environmentId:"staging",databaseIdentity:"db-staging",failedWorkerGeneration:"worker-old",workerGeneration:"worker-fixed",
    inventoryRevision:"inventory-after-failure",inventoryMeasuredAt:"2026-08-10T12:03:00.000Z",heartbeatAt:"2026-08-10T12:04:00.000Z",
  });
  assert.equal(acknowledgement.params[5],now);

  const cleared=harness.calls.find(({sql})=>sql.includes("UPDATE public.host_maintenance_config"));
  assert.ok(cleared);assert.match(cleared.sql,/circuit_breaker_open=FALSE/);assert.match(cleared.sql,/circuit_breaker_opened_at=NULL/);
  assert.match(cleared.sql,/circuit_breaker_reason=NULL/);assert.match(cleared.sql,/scheduled_enabled=FALSE,next_run_at=NULL/);
  assert.deepEqual(cleared.params,["unused-alpr-images",now]);
  assert.equal(harness.states.get("unused-alpr-images").circuit_breaker_open,false);
  assert.equal(harness.states.get("unused-alpr-images").scheduled_enabled,false);
  assert.equal(harness.states.get("unused-alpr-images").next_run_at,null);
  assert.equal(harness.states.get("docker-build-cache").circuit_breaker_open,true,"acknowledgement is isolated to the selected category");

  const positions=Object.fromEntries(harness.calls.map(({sql},index)=>[sql,index]));
  assert.ok(positions.BEGIN<harness.calls.indexOf(failure));
  assert.ok(harness.calls.indexOf(failure)<harness.calls.indexOf(acknowledgement));
  assert.ok(harness.calls.indexOf(acknowledgement)<harness.calls.indexOf(cleared));
  assert.ok(harness.calls.indexOf(cleared)<positions.COMMIT);
  assert.equal(harness.calls.some(({sql})=>sql==="ROLLBACK"),false);
});

test("host breaker acknowledgement rejects invalid provenance and stale worker evidence before mutation",async(t)=>{
  bindHostMaintenanceTestEnvironment(t);
  const cases=[
    {name:"invalid opened timestamp",configOverrides:{circuit_breaker_opened_at:"not-a-date"},error:/breaker evidence is invalid/},
    {name:"missing opened timestamp",configOverrides:{circuit_breaker_opened_at:null},error:/breaker evidence is invalid/},
    {name:"invalid generation",configOverrides:{circuit_breaker_generation:0},error:/breaker evidence is invalid/},
    {name:"heartbeat not after breaker",workerOverrides:{heartbeat_at:"2026-08-10T12:00:00.000Z"},error:/fresh worker inventory/},
    {name:"inventory not after breaker",workerOverrides:{inventory_measured_at:"2026-08-10T12:00:00.000Z"},error:/fresh worker inventory/},
    {name:"missing current failure receipt",failedRows:[],error:/No failed destructive intent/},
    {name:"historical receipt cannot acknowledge current breaker",failedRows:[{id:11,failed_worker_generation:"worker-old",
      failure_receipt_at:"2026-08-01T12:00:00.000Z"}],filterFailedRowsByBreaker:true,error:/No failed destructive intent/},
    {name:"invalid failure receipt timestamp",failedRows:[{id:42,failed_worker_generation:"worker-old",failure_receipt_at:"not-a-date"}],error:/post-failure worker inventory/},
  ];
  for(const scenario of cases){
    const harness=hostAcknowledgementHarness(scenario);
    await assert.rejects(()=>acknowledgeHostMaintenanceBreaker({executor:harness.executor,actor:{id:9},category:"unused-alpr-images",
      confirmation:HOST_MAINTENANCE_ACKNOWLEDGEMENTS["unused-alpr-images"],now:new Date("2026-08-10T12:05:00.000Z")}),scenario.error,scenario.name);
    assert.equal(harness.calls.some(({sql})=>sql.includes("INSERT INTO public.host_maintenance_acknowledgements")),false,scenario.name);
    assert.equal(harness.calls.some(({sql})=>sql.includes("UPDATE public.host_maintenance_config")),false,scenario.name);
    assert.equal(harness.calls.some(({sql})=>sql==="COMMIT"),false,scenario.name);
    assert.equal(harness.calls.filter(({sql})=>sql==="ROLLBACK").length,1,scenario.name);
    assert.equal(harness.released,true,scenario.name);
  }
});

test("host breaker acknowledgement rolls back both acknowledgement and clear on transactional failures",async(t)=>{
  bindHostMaintenanceTestEnvironment(t);
  const scenarios=[
    {name:"acknowledgement insert fails",options:{insertError:new Error("acknowledgement insert unavailable")},error:/insert unavailable/,
      expectInsert:true,expectClear:false},
    {name:"breaker clear loses lock",options:{clearRowCount:0},error:/lost its breaker lock/,expectInsert:true,expectClear:true},
  ];
  for(const scenario of scenarios){
    const harness=hostAcknowledgementHarness(scenario.options);
    await assert.rejects(()=>acknowledgeHostMaintenanceBreaker({executor:harness.executor,actor:{id:9},category:"unused-alpr-images",
      confirmation:HOST_MAINTENANCE_ACKNOWLEDGEMENTS["unused-alpr-images"],now:new Date("2026-08-10T12:05:00.000Z")}),scenario.error,scenario.name);
    assert.equal(harness.calls.some(({sql})=>sql.includes("INSERT INTO public.host_maintenance_acknowledgements")),scenario.expectInsert,scenario.name);
    assert.equal(harness.calls.some(({sql})=>sql.includes("UPDATE public.host_maintenance_config")),scenario.expectClear,scenario.name);
    assert.equal(harness.calls.some(({sql})=>sql==="COMMIT"),false,scenario.name);
    assert.equal(harness.calls.filter(({sql})=>sql==="ROLLBACK").length,1,scenario.name);
    assert.equal(harness.states.get("unused-alpr-images").circuit_breaker_open,true,scenario.name);
    assert.equal(harness.states.get("docker-build-cache").circuit_breaker_open,true,scenario.name);
    assert.equal(harness.released,true,scenario.name);
  }
});

test("host execution rejects an open breaker and any preview not strictly newer than the current acknowledgement",async(t)=>{
  bindHostMaintenanceTestEnvironment(t);
  const acknowledgement={breaker_generation:7,created_at:"2026-08-10T12:00:00.000Z"};
  const scenarios=[
    {name:"open breaker",options:{breakerOpen:true,breakerGeneration:7},error:/circuit breaker is open/},
    {name:"nonzero generation without acknowledgement",options:{breakerGeneration:7,acknowledgement:null},error:/acknowledgement evidence is invalid/},
    {name:"generation zero with acknowledgement",options:{breakerGeneration:0,acknowledgement:{...acknowledgement,breaker_generation:0}},error:/acknowledgement evidence is invalid/},
    {name:"negative generation",options:{breakerGeneration:-1,acknowledgement:null},error:/acknowledgement evidence is invalid/},
    {name:"noninteger generation",options:{breakerGeneration:1.5,acknowledgement:{...acknowledgement,breaker_generation:1.5}},error:/acknowledgement evidence is invalid/},
    {name:"acknowledgement generation mismatch",options:{breakerGeneration:7,acknowledgement:{...acknowledgement,breaker_generation:6}},error:/acknowledgement evidence is invalid/},
    {name:"old preview",options:{breakerGeneration:7,acknowledgement,previewCreatedAt:"2026-08-10T11:59:59.999Z"},error:/Queue a fresh host maintenance preview/},
    {name:"equal-time preview",options:{breakerGeneration:7,acknowledgement,previewCreatedAt:acknowledgement.created_at},error:/Queue a fresh host maintenance preview/},
    {name:"invalid preview timestamp",options:{breakerGeneration:7,acknowledgement,previewCreatedAt:"not-a-date"},error:/acknowledgement evidence is invalid/},
    {name:"invalid acknowledgement timestamp",options:{breakerGeneration:7,acknowledgement:{...acknowledgement,created_at:"not-a-date"}},error:/acknowledgement evidence is invalid/},
  ];
  for(const scenario of scenarios){
    const harness=hostExecutionHarness(scenario.options);
    await assert.rejects(()=>requestHostMaintenanceExecution({executor:harness.executor,actor:{id:9},previewToken:"opaque-preview",
      confirmation:HOST_MAINTENANCE_CONFIRMATIONS["unused-alpr-images"],now:new Date("2026-08-10T12:05:00.000Z")}),scenario.error,scenario.name);
    assert.equal(harness.calls.some(({sql})=>sql.includes("INSERT INTO public.host_maintenance_intents")),false,scenario.name);
    assert.equal(harness.calls.some(({sql})=>sql.includes("INSERT INTO public.host_maintenance_preview_consumptions")),false,scenario.name);
    assert.equal(harness.calls.some(({sql})=>sql==="COMMIT"),false,scenario.name);
    assert.equal(harness.calls.filter(({sql})=>sql==="ROLLBACK").length,1,scenario.name);
    assert.equal(harness.released,true,scenario.name);
    const config=harness.calls.find(({sql})=>sql.includes("SELECT circuit_breaker_open,circuit_breaker_generation"));
    assert.ok(config,scenario.name);assert.match(config.sql,/WHERE category=\$1 FOR UPDATE/);assert.deepEqual(config.params,["unused-alpr-images"]);
    const acknowledgementQuery=harness.calls.find(({sql})=>sql.includes("FROM public.host_maintenance_acknowledgements"));
    if(scenario.name==="open breaker")assert.equal(acknowledgementQuery,undefined,"open breaker fails before acknowledgement lookup");
    else{assert.ok(acknowledgementQuery,scenario.name);assert.match(acknowledgementQuery.sql,/ORDER BY breaker_generation DESC LIMIT 1/);
      assert.deepEqual(acknowledgementQuery.params,["unused-alpr-images"]);}
  }
});

test("host execution accepts only a newer post-acknowledgement preview while preserving the never-failed flow",async(t)=>{
  bindHostMaintenanceTestEnvironment(t);
  const now=new Date("2026-08-10T12:05:00.000Z");
  const scenarios=[
    {name:"newer preview after exact current acknowledgement",options:{breakerGeneration:7,
      acknowledgement:{breaker_generation:7,created_at:"2026-08-10T12:00:00.000Z"},previewCreatedAt:"2026-08-10T12:00:00.001Z"}},
    {name:"no acknowledgement preserves never-failed flow",options:{breakerGeneration:0,acknowledgement:null,previewCreatedAt:"2026-08-01T12:00:00.000Z"}},
  ];
  for(const scenario of scenarios){
    const harness=hostExecutionHarness(scenario.options);
    const result=await requestHostMaintenanceExecution({executor:harness.executor,actor:{id:9},previewToken:"opaque-preview",
      confirmation:HOST_MAINTENANCE_CONFIRMATIONS["unused-alpr-images"],now});
    assert.deepEqual(result,{requestId:303,category:"unused-alpr-images",status:"pending",hostWorkerRequired:true},scenario.name);
    const acknowledgementQuery=harness.calls.find(({sql})=>sql.includes("FROM public.host_maintenance_acknowledgements"));
    const intent=harness.calls.find(({sql})=>sql.includes("INSERT INTO public.host_maintenance_intents"));
    const consumption=harness.calls.find(({sql})=>sql.includes("INSERT INTO public.host_maintenance_preview_consumptions"));
    assert.ok(acknowledgementQuery,scenario.name);assert.ok(intent,scenario.name);assert.ok(consumption,scenario.name);
    assert.deepEqual(intent.params,["unused-alpr-images","staging","db-staging",9,101,now],scenario.name);
    assert.deepEqual(consumption.params,[201,303,9,now],scenario.name);
    assert.ok(harness.calls.indexOf(acknowledgementQuery)<harness.calls.indexOf(intent),scenario.name);
    assert.ok(harness.calls.indexOf(intent)<harness.calls.indexOf(consumption),scenario.name);
    assert.ok(harness.calls.indexOf(consumption)<harness.calls.findIndex(({sql})=>sql==="COMMIT"),scenario.name);
    assert.equal(harness.calls.some(({sql})=>sql==="ROLLBACK"),false,scenario.name);
    assert.equal(harness.released,true,scenario.name);
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

test("rollback-backup deletion and scheduling are hard-disabled across control, worker, schema, and UI",async(t)=>{
  const previousEnvironment=process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;
  const previousIdentity=process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;
  process.env.HOST_MAINTENANCE_ENVIRONMENT_ID="staging";
  process.env.HOST_MAINTENANCE_DATABASE_IDENTITY="db-staging";
  t.after(()=>{
    if(previousEnvironment===undefined)delete process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;else process.env.HOST_MAINTENANCE_ENVIRONMENT_ID=previousEnvironment;
    if(previousIdentity===undefined)delete process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;else process.env.HOST_MAINTENANCE_DATABASE_IDENTITY=previousIdentity;
  });
  await assert.rejects(()=>setScheduledHostMaintenance({actor:{id:1},category:"rollout-backups",enabled:true}),/catalog-bound approval/);
  const queries=[];const client={query:async(sql)=>{queries.push(sql);
    if(sql==="BEGIN"||sql==="ROLLBACK")return{rowCount:0,rows:[]};
    if(sql.includes("host_maintenance_environment_identity"))return{rowCount:1,rows:[{}]};
    if(sql.includes("FROM public.host_maintenance_previews"))return{rowCount:1,rows:[{category:"rollout-backups"}]};
    throw new Error(`Unexpected query: ${sql}`);},release(){}};
  await assert.rejects(()=>requestHostMaintenanceExecution({executor:{connect:async()=>client},actor:{id:1},previewToken:"token",confirmation:"irrelevant"}),/catalog-bound approval/);
  assert.doesNotMatch(queries.join("\n"),/INSERT INTO public\.host_maintenance_intents/);
  await assert.rejects(()=>hostMaintenanceWorkerInternals.processPrune({}, {prune:async()=>{throw new Error("must not run");}}, {category:"rollout-backups"}, new Date(), "worker", {}),/catalog-bound approval/);

  const [schema,migrations,panel]=await Promise.all([
    readFile(new URL("../schema.sql",import.meta.url),"utf8"),readFile(new URL("../migrations.sql",import.meta.url),"utf8"),
    readFile(new URL("../app/settings/HostMaintenancePanel.jsx",import.meta.url),"utf8"),
  ]);
  assert.match(schema,/\('rollout-backups', FALSE, 30\)/);
  assert.match(migrations,/WHERE category='rollout-backups'/);
  assert.match(panel,/Rollback-backup deletion and scheduling remain hard-disabled/);
  assert.match(panel,/destructiveAvailable: false/);
  for(const source of[schema,migrations])assert.match(source,/host_backup_catalog_no_truncate/);
});

test("image eligibility requires authoritative application and worker ledgers and worker hard-disables its schedule",async()=>{
  for(const key of["catalogComplete","releaseLedgerComplete","workerImageLedgerComplete"]){const value=inventory();value[key]=false;value.revision=canonicalHostInventoryRevision(value);
    assert.equal(planForCategory(buildHostMaintenancePlan(value,{now:new Date("2026-07-29T00:00:00Z")}),"unused-alpr-images").candidateCount,0);}
  const worker=await readFile(new URL("../lib/host-maintenance.mjs",import.meta.url),"utf8");
  assert.match(worker,/intent_type==="scheduled"&&intent\.category==="unused-alpr-images"/);
  assert.match(worker,/Scheduled unused-image pruning is hard-disabled by the worker/);
  const none=inventory();none.docker.images.find((image)=>image.currentRelease).currentRelease=false;none.revision=canonicalHostInventoryRevision(none);
  assert.equal(planForCategory(buildHostMaintenancePlan(none,{now:new Date("2026-07-29T00:00:00Z")}),"unused-alpr-images").candidateCount,0);
  const two=inventory();two.docker.images[0].currentRelease=true;two.revision=canonicalHostInventoryRevision(two);
  assert.equal(planForCategory(buildHostMaintenancePlan(two,{now:new Date("2026-07-29T00:00:00Z")}),"unused-alpr-images").candidateCount,0);
  const noWorker=inventory();noWorker.docker.images.find((image)=>image.currentWorker).currentWorker=false;noWorker.authoritativeCurrentWorkerCount=0;noWorker.revision=canonicalHostInventoryRevision(noWorker);
  assert.equal(planForCategory(buildHostMaintenancePlan(noWorker,{now:new Date("2026-07-29T00:00:00Z")}),"unused-alpr-images").candidateCount,0);
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
  const [schema,migrations,control,worker,actions,panel,contract]=await Promise.all([
    readFile(new URL("../schema.sql",import.meta.url),"utf8"),readFile(new URL("../migrations.sql",import.meta.url),"utf8"),
    readFile(new URL("../lib/host-maintenance-control.mjs",import.meta.url),"utf8"),readFile(new URL("../lib/host-maintenance.mjs",import.meta.url),"utf8"),
    readFile(new URL("../app/actions.js",import.meta.url),"utf8"),readFile(new URL("../app/settings/HostMaintenancePanel.jsx",import.meta.url),"utf8"),
    readFile(new URL("../docs/host-maintenance-worker-contract.md",import.meta.url),"utf8"),
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
  assert.match(panel,/useEffect\(\(\) => \{[\s\S]*window\.setTimeout\(poll, 2500\)[\s\S]*refreshDatabaseBackup\(\{ requestId: databaseBackup\.requestId \}\)/);
  assert.match(panel,/catch \{[\s\S]*consecutiveFailures >= 3[\s\S]*Automatic updates paused/);
  assert.match(panel,/\["completed", "failed"\]\.includes\(result\.data\.status\)[\s\S]*router\.refresh\(\)/);
  assert.match(panel,/if \(overview\.databaseBackup\) setDatabaseBackup\(overview\.databaseBackup\)/);
  assert.match(actions,/createDatabaseBackup[\s\S]*revalidatePath\("\/settings\/data-privacy\/cleanup"\)/);
  assert.match(panel,/database-backup-create-v1 capability/);
  assert.match(panel,/accepts no command, path, filename, schedule, or restore input/);
  assert.doesNotMatch(panel,/checksumSha256|backupPath|commandArgs/);
  assert.match(contract,/`backup\(request\)`/);
  assert.match(contract,/`cleanupDatabaseBackupRequest\(request\)`/);
  assert.match(contract,/production worker is active and\s+advertises `database-backup-create-v1`/);
  assert.match(contract,/64,806,352-byte \(61\.8 MB\)\s+`alpr-postgres-20260802T164636Z-1\.dump`/);
  assert.doesNotMatch(contract,/Production has no deployed adapter|production does not/);
});

test("fresh schema defers the database-backup actor foreign key until users exist",async()=>{
  const [schema,migrations]=await Promise.all([
    readFile(new URL("../schema.sql",import.meta.url),"utf8"),readFile(new URL("../migrations.sql",import.meta.url),"utf8"),
  ]);
  const schemaTable=schema.slice(
    schema.indexOf("CREATE TABLE IF NOT EXISTS public.host_database_backup_requests"),
    schema.indexOf("CREATE INDEX IF NOT EXISTS idx_host_database_backup_requests_due"),
  );
  assert.match(schemaTable,/actor_user_id BIGINT,/);
  assert.doesNotMatch(schemaTable,/REFERENCES public\.users/);

  const migration=migrations.slice(
    migrations.indexOf("-- Manual database backup is deliberately separate"),
    migrations.indexOf("'2026073001_manual_database_backup'"),
  );
  assert.match(migration,/actor_user_id BIGINT,/);
  assert.doesNotMatch(migration,/actor_user_id BIGINT REFERENCES public\.users/);
  assert.match(migration,/conname = 'host_database_backup_requests_actor_user_id_fkey'/);
  assert.match(migration,/conrelid = 'public\.host_database_backup_requests'::regclass/);
  assert.match(migration,/ADD CONSTRAINT host_database_backup_requests_actor_user_id_fkey[\s\S]*FOREIGN KEY \(actor_user_id\) REFERENCES public\.users\(id\) ON DELETE SET NULL/);
});

test("database-backup audit writes use the schema vocabulary and commit atomically",async(t)=>{
  const previousEnvironment=process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;
  const previousIdentity=process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;
  process.env.HOST_MAINTENANCE_ENVIRONMENT_ID="staging";
  process.env.HOST_MAINTENANCE_DATABASE_IDENTITY="db-staging";
  t.after(()=>{
    if(previousEnvironment===undefined)delete process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;
    else process.env.HOST_MAINTENANCE_ENVIRONMENT_ID=previousEnvironment;
    if(previousIdentity===undefined)delete process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;
    else process.env.HOST_MAINTENANCE_DATABASE_IDENTITY=previousIdentity;
  });
  const now=new Date("2026-07-31T18:00:00Z");const queries=[];
  const client={query:async(sql,params)=>{queries.push({sql,params});
    if(sql.includes("host_maintenance_environment_identity"))return{rowCount:1,rows:[{}]};
    if(sql.includes("host_maintenance_worker_state"))return{rowCount:1,rows:[{heartbeat_at:now,database_backup_capability:"database-backup-create-v1",database_backup_capability_at:now}]};
    if(sql.includes("SELECT id FROM public.host_database_backup_requests"))return{rowCount:0,rows:[]};
    if(sql.includes("INSERT INTO public.host_database_backup_requests"))return{rowCount:1,rows:[{id:42,status:"pending",requested_at:now}]};
    return{rowCount:1,rows:[]};},release(){}};
  const result=await requestDatabaseBackup({executor:{connect:async()=>client},actor:{id:9},now});
  assert.equal(result.requestId,42);assert.equal(result.status,"pending");
  const audit=queries.find(({sql})=>sql.includes("maintenance.database_backup_requested"));
  assert.ok(audit);assert.match(audit.sql,/'browser'/);assert.match(audit.sql,/'succeeded'/);
  assert.doesNotMatch(audit.sql,/'web'|'success'/);
  assert.ok(queries.findIndex(({sql})=>sql==="BEGIN")<queries.indexOf(audit));
  assert.ok(queries.indexOf(audit)<queries.findIndex(({sql})=>sql==="COMMIT"));
});

test("worker audit writes stay inside the append-only audit schema vocabulary",async()=>{
  const [schema,worker]=await Promise.all([
    readFile(new URL("../migrations.sql",import.meta.url),"utf8"),
    readFile(new URL("../lib/host-maintenance.mjs",import.meta.url),"utf8"),
  ]);
  assert.match(schema,/CHECK \(source IN \('browser', 'api', 'system'\)\)/);
  assert.match(schema,/CHECK \(outcome IN \('succeeded', 'denied', 'failed'\)\)/);
  assert.doesNotMatch(worker,/'host-worker'|'success'/);
  assert.match(worker,/maintenance[.]database_backup_completed[\s\S]*?'succeeded'/);
  assert.match(worker,/maintenance[.]database_backup_failed[\s\S]*?'failed'/);
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

test("worker heartbeat explicitly binds reused timestamp parameters as timestamptz",async()=>{
  const priorEnvironment=process.env.HOST_MAINTENANCE_ENVIRONMENT_ID;
  const priorDatabase=process.env.HOST_MAINTENANCE_DATABASE_IDENTITY;
  process.env.HOST_MAINTENANCE_ENVIRONMENT_ID="staging";
  process.env.HOST_MAINTENANCE_DATABASE_IDENTITY="db-staging";
  try{
    const queries=[];
    const executor={query:async(sql,values)=>{
      queries.push({sql,values});
      if(/host_maintenance_environment_identity/.test(sql))return{rowCount:1,rows:[{ok:1}]};
      if(/INSERT INTO public\.host_backup_catalog_snapshots/.test(sql))return{rowCount:1,rows:[{id:1,entry_count:7}]};
      if(/INSERT INTO public\.host_maintenance_worker_state/.test(sql))return{rowCount:1,rows:[]};
      throw new Error(`Unexpected query: ${sql}`);
    }};
    const now=new Date("2026-07-31T23:59:00.000Z");
    const adapter={
      capabilities:["database-backup-create-v1"],
      backup:async()=>{throw new Error("not called");},
      inspect:async()=>inventory({measuredAt:now.toISOString()}),
    };
    const result=await inspectAndHeartbeatHostMaintenanceWorker({executor,adapter,workerId:"worker-test",now});
    assert.equal(result.databaseBackupSupported,true);
    assert.match(result.backupCatalogRevision,/^[0-9a-f]{64}$/);
    const catalogQuery=queries.find(({sql})=>/INSERT INTO public\.host_backup_catalog_snapshots/.test(sql));
    assert.ok(catalogQuery);
    assert.match(catalogQuery.sql,/jsonb_to_recordset/);
    assert.match(catalogQuery.sql,/SELECT COUNT\(\*\)::bigint FROM inserted_entries/);
    assert.doesNotMatch(catalogQuery.sql,/DELETE|UPDATE public\.host_backup_catalog/i);
    const heartbeatQuery=queries.find(({sql})=>/INSERT INTO public\.host_maintenance_worker_state/.test(sql));
    assert.ok(heartbeatQuery);
    assert.equal(heartbeatQuery.sql.match(/\$5::timestamptz/g)?.length,3);
    assert.equal(heartbeatQuery.sql.match(/\$8::varchar\(80\)/g)?.length,2);
    assert.doesNotMatch(heartbeatQuery.sql,/ELSE \$5 END|,\$5,\$6/);
    assert.doesNotMatch(heartbeatQuery.sql,/,\$8,|WHEN \$8 IS NULL/);
    assert.equal(heartbeatQuery.values[4],now);
    assert.equal(heartbeatQuery.values[7],"database-backup-create-v1");
    assert.ok(queries.indexOf(catalogQuery)<queries.indexOf(heartbeatQuery));

    const unsupportedResult=await inspectAndHeartbeatHostMaintenanceWorker({
      executor,
      adapter:{inspect:async()=>inventory({measuredAt:now.toISOString()})},
      workerId:"worker-without-backup",
      now,
    });
    assert.equal(unsupportedResult.databaseBackupSupported,false);
    const unsupportedHeartbeat=queries.filter(({sql})=>/INSERT INTO public\.host_maintenance_worker_state/.test(sql))[1];
    assert.ok(unsupportedHeartbeat);
    assert.equal(unsupportedHeartbeat.sql.match(/\$5::timestamptz/g)?.length,3);
    assert.equal(unsupportedHeartbeat.sql.match(/\$8::varchar\(80\)/g)?.length,2);
    assert.doesNotMatch(unsupportedHeartbeat.sql,/,\$8,|WHEN \$8 IS NULL/);
    assert.equal(unsupportedHeartbeat.values[4],now);
    assert.equal(unsupportedHeartbeat.values[7],null);
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

test("host breaker acknowledgement UI and action remain administrator-only, typed, and category-bound",async()=>{
  const [panel,actions]=await Promise.all([
    readFile(new URL("../app/settings/HostMaintenancePanel.jsx",import.meta.url),"utf8"),
    readFile(new URL("../app/actions.js",import.meta.url),"utf8"),
  ]);
  assert.match(panel,/acknowledgeHostMaintenanceFailureAction/);
  assert.match(panel,/const \[acknowledgementConfirmations, setAcknowledgementConfirmations\] = useState\(\{\}\)/);
  const acknowledgementFunction=panel.slice(panel.indexOf("function acknowledgeFailure"),panel.indexOf("function changeSchedule"));
  assert.match(acknowledgementFunction,/runAction\(`acknowledge:\$\{category\}`/);
  assert.match(acknowledgementFunction,/category,[\s\S]*confirmation: acknowledgementConfirmations\[category\] \|\| ""/);
  assert.doesNotMatch(acknowledgementFunction,/evidence|requestId|previewToken|manualConfirmations/);
  assert.ok(acknowledgementFunction.indexOf("if (!result.success)")<acknowledgementFunction.indexOf("setAcknowledgementConfirmations"));
  assert.match(acknowledgementFunction,/Scheduling remains disabled; queue a separate read-only preview/);
  assert.match(acknowledgementFunction,/router\.refresh\(\)/);

  assert.match(panel,/overview\.acknowledgementPhrases\?\.\[definition\.key\] \|\| ""/);
  const canAcknowledge=panel.slice(panel.indexOf("const canAcknowledge"),panel.indexOf("const draft",panel.indexOf("const canAcknowledge")));
  for(const gate of[/canApproveAutomaticCleanup/,/workerHealthy/,/configured/,/effectiveConfig\.circuitBreakerOpen/,/Boolean\(acknowledgementPhrase\)/,
    /!isPending/,/acknowledgementConfirmations\[definition\.key\] === acknowledgementPhrase/])assert.match(canAcknowledge,gate);
  assert.doesNotMatch(canAcknowledge,/\bblocked\b/);
  assert.match(panel,/configured && effectiveConfig\.circuitBreakerOpen/);
  assert.match(panel,/disabled=\{!canApproveAutomaticCleanup \|\| !workerHealthy \|\| isPending\}/);
  assert.match(panel,/onClick=\{\(\) => acknowledgeFailure\(definition\.key\)\} disabled=\{!canAcknowledge\}/);
  assert.match(panel,/protected acknowledgement phrase is unavailable; this breaker remains locked/);
  assert.match(panel,/Administrator automatic-cleanup approval permission is required/);
  assert.match(panel,/It does not delete anything, restart scheduling, or queue cleanup/);

  const action=actions.slice(actions.indexOf("export async function acknowledgeHostMaintenanceFailureAction"),actions.indexOf("export async function testBlueIrisConnection"));
  assert.match(action,/requirePermission\("maintenance\.automatic_cleanup\.approve"\)/);
  assert.doesNotMatch(action,/requirePermission\("maintenance\.manage"\)/);
  assert.match(action,/category: input\.category, confirmation: String\(input\.confirmation \|\| ""\)/);
  assert.doesNotMatch(action,/input\.evidence|input\.requestId|input\.previewToken/);
  assert.match(action,/revalidatePath\("\/settings\/data-privacy"\)/);
  assert.match(action,/revalidatePath\("\/settings\/data-privacy\/cleanup"\)/);
  for(const safe of[/Category circuit breaker is not open/,/A fresh worker inventory is required before acknowledgement/,
    /No failed destructive intent is available for acknowledgement/,/A post-failure worker inventory is required before acknowledgement/,
    /Category circuit breaker is open; acknowledge it before requesting cleanup/,
    /Queue a fresh host maintenance preview after acknowledging this failure/])assert.match(actions,safe);
});

test("host maintenance UI keeps categories separate and fails controls closed",async()=>{
  const [panel,container,control,actions]=await Promise.all([
    readFile(new URL("../app/settings/HostMaintenancePanel.jsx",import.meta.url),"utf8"),
    readFile(new URL("../app/settings/StorageMaintenancePanel.jsx",import.meta.url),"utf8"),
    readFile(new URL("../lib/host-maintenance-control.mjs",import.meta.url),"utf8"),
    readFile(new URL("../app/actions.js",import.meta.url),"utf8"),
  ]);
  for(const label of ["Docker build cache","Unused ALPR and maintenance images","Verified rollout backups"])assert.match(panel,new RegExp(label));
  assert.match(panel,/Candidate counts are unavailable, not zero/);
  assert.match(panel,/Preview complete: 0 candidates \(0 B\)/);
  assert.match(panel,/confirmationPhrases\?\.\[definition\.key\]/);
  assert.match(panel,/activationPhrases\?\.\[definition\.key\]/);
  assert.match(panel,/retainedVerifiedCount: String\(config\.retainedVerifiedCount \?\? 5\)/);
  assert.match(panel,/minimumAgeDays: String\(config\.minimumAgeDays \?\? \(key === "rollout-backups" \? 30 : 7\)\)/);
  assert.match(panel,/Automation unsupported: retired application and host-worker images remain preview-and-confirm manual only/);
  assert.match(panel,/non-mutable, non-shared cache unused for at least seven days/);
  assert.match(panel,/Retirement grace \(days\)/);
  assert.match(panel,/SET IMAGE RETIREMENT GRACE/);
  assert.match(panel,/id="host-image-age" type="number" min="1" max="365"/);
  assert.doesNotMatch(panel,/id="host-backup-age"/);
  assert.match(panel,/!workerHealthy \|\| !configured \|\| effectiveConfig\.circuitBreakerOpen \|\| isPending/);
  assert.match(panel,/candidateCount > 0/);
  assert.match(panel,/!previewExpired/);
  assert.match(panel,/never prune Docker volumes, containers, or networks/);
  assert.match(panel,/useState\(\(\) => activeHostRequests\(overview\.intents\)\)/);
  assert.match(panel,/field\(intent, "requestId", "id"\)/);
  assert.match(panel,/window\.setTimeout\(poll, 2500\)/);
  assert.match(panel,/refreshHostMaintenancePreview\(\{ requestId: request\.requestId \}\)/);
  assert.match(panel,/Status will update automatically/);
  assert.match(panel,/Automatic updates paused; use Retry status update to resume/);
  assert.match(panel,/hostPollingPaused && requestIsActive\(request\)/);
  assert.match(panel,/Retry status update/);
  assert.match(panel,/Logical preview footprint/);
  assert.match(panel,/Docker-accounted reclaimed/);
  assert.match(panel,/Docker's shared layer store and may be smaller, including zero/);
  assert.match(panel,/preview && requestIsActive\(preview\) \? "Calculating…"/);
  assert.match(panel,/disabled=\{!canManage \|\| blocked \|\| requestIsActive\(request\)\}/);
  assert.match(panel,/categoryPending \? "Queuing preview…" : requestIsActive\(request\) \? "Preview in progress"/);
  assert.match(control,/SELECT category FROM public\.host_maintenance_config WHERE category=\$1 FOR UPDATE/);
  assert.match(control,/A host maintenance request is already pending or running for this category/);
  assert.match(control,/requestedAt:row\.requested_at\|\|null,startedAt:row\.started_at\|\|null,completedAt:row\.completed_at\|\|null/);
  assert.match(actions,/A host maintenance request is already pending or running for this category/);
  assert.match(panel,/request\?\.operation === "preview" \? \{ \.\.\.overviewPreview, \.\.\.request, intentType: "preview" \}/);
  const queueExecution = panel.slice(panel.indexOf("function queueExecution"), panel.indexOf("function acknowledgeFailure"));
  assert.doesNotMatch(queueExecution,/router\.refresh\(\)/);
  assert.doesNotMatch(panel,/Request \{request\.requestId\}/);
  assert.doesNotMatch(panel,/circuitBreakerReason/);
  assert.doesNotMatch(panel,/lastError\}/);
  assert.match(container,/<HostMaintenancePanel/);
});
