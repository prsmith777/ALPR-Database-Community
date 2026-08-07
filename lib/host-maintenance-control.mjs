import { createHash } from "node:crypto";
import {
  HOST_MAINTENANCE_ACKNOWLEDGEMENTS, HOST_MAINTENANCE_ACTIVATIONS,
  HOST_MAINTENANCE_CONFIRMATIONS, HOST_MAINTENANCE_MIN_INTERVAL_SECONDS,
  HOST_MAINTENANCE_IMAGE_POLICY_CONFIRMATION,
  normalizeHostMaintenanceCategory,
} from "./host-maintenance-policy.mjs";
import { buildHostBackupCatalogPreview, publicHostBackupCatalogPreview } from "./host-backup-catalog.mjs";

async function defaultPool() { return (await import("./db.js")).getPool(); }
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
function actorId(actor) {
  const id = Number(actor?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Host maintenance requires an authenticated actor");
  return id;
}
function bounded(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
const HOST_WORKER_STALE_SECONDS=300;
const HOST_WORKER_FUTURE_SKEW_SECONDS=30;
function expectedEnvironmentId(){
  const value=String(process.env.HOST_MAINTENANCE_ENVIRONMENT_ID||"").trim();
  return /^[A-Za-z0-9][A-Za-z0-9:_.@+-]{0,199}$/.test(value)?value:null;
}
function expectedDatabaseIdentity(){const value=String(process.env.HOST_MAINTENANCE_DATABASE_IDENTITY||"").trim();return/^[A-Za-z0-9][A-Za-z0-9:_.@+-]{0,199}$/.test(value)?value:null;}
function expectedBindings(){return{environmentId:expectedEnvironmentId(),databaseIdentity:expectedDatabaseIdentity()};}
async function assertDatabaseIdentity(database,bindings=expectedBindings()){
  if(!bindings.environmentId||!bindings.databaseIdentity)throw new Error("Host maintenance is unavailable");
  const identity=await database.query(`SELECT 1 FROM public.host_maintenance_environment_identity
    WHERE singleton=TRUE AND environment_id=$1 AND database_identity=$2 LIMIT 1`,[bindings.environmentId,bindings.databaseIdentity]);
  if(!identity.rowCount)throw new Error("Host maintenance database identity is unavailable or mismatched");
  return bindings;
}
async function assertHealthyWorker(database,now,bindings=expectedBindings(),{databaseBackupRequired=false}={}){
  await assertDatabaseIdentity(database,bindings);
  const result=await database.query(`SELECT database_identity,heartbeat_at,worker_generation,inventory_revision,inventory_measured_at,database_backup_capability,database_backup_capability_at FROM public.host_maintenance_worker_state
    WHERE environment_id=$1 AND database_identity=$5 AND last_error IS NULL
      AND heartbeat_at BETWEEN $2::timestamptz-make_interval(secs=>$3) AND $2::timestamptz+make_interval(secs=>$4)
      AND inventory_measured_at BETWEEN $2::timestamptz-make_interval(secs=>$3) AND $2::timestamptz+make_interval(secs=>$4)
    LIMIT 1`,[bindings.environmentId,now,HOST_WORKER_STALE_SECONDS,HOST_WORKER_FUTURE_SKEW_SECONDS,bindings.databaseIdentity]);
  if(!result.rowCount)throw new Error("The fixed host maintenance worker is unavailable or stale");
  const worker=result.rows[0];
  if(databaseBackupRequired&&(worker.database_backup_capability!=="database-backup-create-v1"||
    new Date(worker.database_backup_capability_at).getTime()!==new Date(worker.heartbeat_at).getTime()))throw new Error("The fixed database-backup worker adapter is not installed");
  return worker;
}
function databaseBackupShape(row={}){return{requestId:row.id?Number(row.id):null,status:row.status||"never",requestedAt:row.requested_at||null,
  startedAt:row.started_at||null,completedAt:row.completed_at||null,filename:row.filename||null,sizeBytes:row.size_bytes==null?null:Number(row.size_bytes),
  verified:row.verified===true,
  error:row.status==='failed'?"Database backup failed. Review the protected host-worker logs.":null};}
function configShape(row = {}) {
  return { category:row.category,automationSupported:row.automation_supported===true,scheduledEnabled:row.scheduled_enabled===true,
    intervalSeconds:Number(row.interval_seconds||604800),retainedVerifiedCount:Number(row.retained_verified_count||5),minimumAgeDays:Number(row.minimum_age_days||30),
    nextRunAt:row.next_run_at||null,activationRevision:Number(row.activation_revision||0),circuitBreakerOpen:row.circuit_breaker_open===true,
    circuitBreakerOpenedAt:row.circuit_breaker_opened_at||null,circuitBreakerReason:row.circuit_breaker_open?"Host maintenance suspended":null,
    circuitBreakerGeneration:Number(row.circuit_breaker_generation||0) };
}

export async function requestHostMaintenancePreview({executor,actor,category,now=new Date()}={}){
  const database=executor||await defaultPool();const client=await database.connect();const normalizedCategory=normalizeHostMaintenanceCategory(category);
  try{await client.query("BEGIN");const bindings=expectedBindings();await assertHealthyWorker(client,now,bindings);
    const config=await client.query("SELECT category FROM public.host_maintenance_config WHERE category=$1 FOR UPDATE",[normalizedCategory]);
    if(!config.rowCount)throw new Error("Unsupported host maintenance category");
    const active=await client.query(`SELECT id FROM public.host_maintenance_intents WHERE category=$1 AND environment_id=$2 AND database_identity=$3
      AND status IN('pending','processing') ORDER BY id DESC LIMIT 1`,[normalizedCategory,bindings.environmentId,bindings.databaseIdentity]);
    if(active.rowCount)throw new Error("A host maintenance request is already pending or running for this category");
    const result=await client.query(`INSERT INTO public.host_maintenance_intents(intent_type,category,environment_id,database_identity,status,actor_user_id,requested_at)
      VALUES('preview',$1,$2,$3,'pending',$4,$5) RETURNING id`,[normalizedCategory,bindings.environmentId,bindings.databaseIdentity,actorId(actor),now]);
    await client.query("COMMIT");return{requestId:Number(result.rows[0].id),status:"pending",requestedAt:now,hostWorkerRequired:true};
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
}

export async function requestDatabaseBackup({executor,actor,now=new Date()}={}){
  const database=executor||await defaultPool();const client=await database.connect();const id=actorId(actor);
  try{await client.query("BEGIN");const bindings=expectedBindings();await assertHealthyWorker(client,now,bindings,{databaseBackupRequired:true});
    const active=await client.query(`SELECT id FROM public.host_database_backup_requests WHERE environment_id=$1 AND database_identity=$2
      AND status IN('pending','processing') ORDER BY id DESC LIMIT 1 FOR UPDATE`,[bindings.environmentId,bindings.databaseIdentity]);
    if(active.rowCount)throw new Error("A database backup is already pending or running");
    const result=await client.query(`INSERT INTO public.host_database_backup_requests(environment_id,database_identity,status,actor_user_id,requested_at)
      VALUES($1,$2,'pending',$3,$4) RETURNING *`,[bindings.environmentId,bindings.databaseIdentity,id,now]);
    await client.query(`INSERT INTO public.audit_events(actor_user_id,source,event_type,resource_type,resource_id,outcome,metadata)
      VALUES($1,'browser','maintenance.database_backup_requested','database-backup',$2,'succeeded',jsonb_build_object('format','custom','scheduled',FALSE))`,[id,String(result.rows[0].id)]);
    await client.query("COMMIT");return databaseBackupShape(result.rows[0]);
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
}

export async function getDatabaseBackupRequestStatus({executor,requestId,actor}={}){
  const database=executor||await defaultPool();const id=actorId(actor);const bindings=await assertDatabaseIdentity(database,expectedBindings());
  const result=await database.query(`SELECT id,status,requested_at,started_at,completed_at,filename,size_bytes,verified,last_error
    FROM public.host_database_backup_requests WHERE id=$1 AND environment_id=$2 AND database_identity=$3 AND actor_user_id=$4 LIMIT 1`,
    [Number(requestId),bindings.environmentId,bindings.databaseIdentity,id]);
  if(!result.rowCount)throw new Error("Database-backup request is invalid");return databaseBackupShape(result.rows[0]);
}

export async function getHostMaintenanceRequestStatus({executor,requestId,actor}={}){
  const database=executor||await defaultPool();
  const bindings=await assertDatabaseIdentity(database,expectedBindings());
  // Delivery is atomic and one-time: plaintext is cleared while its hash and
  // immutable preview binding remain. Polling before completion cannot consume it.
  const result=await database.query(`WITH delivered AS (
      DELETE FROM public.host_maintenance_preview_deliveries d USING public.host_maintenance_previews p,public.host_maintenance_intents i
      WHERE d.preview_id=p.id AND p.intent_id=i.id AND i.id=$1 AND i.actor_user_id=$2 AND i.status='completed'
      RETURNING d.preview_id,d.opaque_token
    ) SELECT i.id,i.category,i.status,i.requested_at,i.started_at,i.completed_at,i.candidate_count,i.candidate_bytes,i.reclaimed_bytes,i.last_error,
      i.inventory_measured_at,i.requested_at,i.started_at,i.completed_at,p.expires_at,c.opaque_token
      FROM public.host_maintenance_intents i LEFT JOIN public.host_maintenance_previews p ON p.intent_id=i.id
      LEFT JOIN delivered c ON c.preview_id=p.id WHERE i.id=$1 AND i.actor_user_id=$2 AND i.environment_id=$3 AND i.database_identity=$4`,
      [Number(requestId),actorId(actor),bindings.environmentId,bindings.databaseIdentity]);
  const row=result.rows?.[0]; if(!row)throw new Error("Host maintenance request is invalid");
  return{requestId:Number(row.id),category:row.category,status:row.status,requestedAt:row.requested_at||null,startedAt:row.started_at||null,completedAt:row.completed_at||null,previewToken:row.opaque_token||null,expiresAt:row.expires_at||null,
    candidateCount:Number(row.candidate_count),candidateBytes:Number(row.candidate_bytes),reclaimedBytes:Number(row.reclaimed_bytes),lastError:row.status==='failed'?"HOST_MAINTENANCE_FAILED":null,
    inventoryMeasuredAt:row.inventory_measured_at,requestedAt:row.requested_at,startedAt:row.started_at,completedAt:row.completed_at,
    confirmationPhrase:HOST_MAINTENANCE_CONFIRMATIONS[row.category]};
}

export async function requestHostMaintenanceExecution({executor,actor,previewToken,confirmation,now=new Date()}={}){
  const database=executor||await defaultPool(); const client=await database.connect();
  try{await client.query("BEGIN");
    const bindings=await assertDatabaseIdentity(client,expectedBindings());
    const result=await client.query(`SELECT p.*,i.status FROM public.host_maintenance_previews p JOIN public.host_maintenance_intents i ON i.id=p.intent_id
      WHERE p.token_hash=$1 AND p.actor_user_id=$2 AND p.environment_id=$4 AND p.database_identity=$5 AND p.expires_at>$3 AND i.status='completed' FOR UPDATE`,[sha256(previewToken),actorId(actor),now,bindings.environmentId,bindings.databaseIdentity]);
    const preview=result.rows?.[0]; if(!preview)throw new Error("Host maintenance preview is incomplete, expired, or invalid");
    if(preview.category==="rollout-backups")throw new Error("Rollback-backup deletion is disabled until catalog-bound approval is implemented");
    if(String(confirmation)!==HOST_MAINTENANCE_CONFIRMATIONS[preview.category])throw new Error(`Type ${HOST_MAINTENANCE_CONFIRMATIONS[preview.category]} to request this category`);
    const intent=await client.query(`INSERT INTO public.host_maintenance_intents(intent_type,category,environment_id,database_identity,status,actor_user_id,preview_intent_id,requested_at)
      VALUES('execute',$1,$2,$3,'pending',$4,$5,$6) RETURNING id`,[preview.category,bindings.environmentId,bindings.databaseIdentity,actorId(actor),preview.intent_id,now]);
    await client.query(`INSERT INTO public.host_maintenance_preview_consumptions(preview_id,execution_intent_id,actor_user_id,consumed_at)
      VALUES($1,$2,$3,$4)`,[preview.id,intent.rows[0].id,actorId(actor),now]);
    await client.query("COMMIT"); return{requestId:Number(intent.rows[0].id),category:preview.category,status:"pending",hostWorkerRequired:true};
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
}

export async function setScheduledHostMaintenance({executor,actor,category,enabled,confirmation="",intervalSeconds=604800,retainedVerifiedCount=5,minimumAgeDays=30,now=new Date()}={}){
  const normalized=normalizeHostMaintenanceCategory(category);
  if(enabled===true&&normalized==="unused-alpr-images")throw new Error("Scheduled unused-image pruning is unsupported until independently approved");
  if(enabled===true&&normalized==="rollout-backups")throw new Error("Rollback-backup deletion is disabled until catalog-bound approval is implemented");
  if(enabled===true&&confirmation!==HOST_MAINTENANCE_ACTIVATIONS[normalized])throw new Error(`Type ${HOST_MAINTENANCE_ACTIVATIONS[normalized]} to activate scheduled ${normalized} maintenance`);
  const database=executor||await defaultPool();const client=await database.connect();const id=actorId(actor);
  const interval=bounded(intervalSeconds,604800,HOST_MAINTENANCE_MIN_INTERVAL_SECONDS,2592000),keep=bounded(retainedVerifiedCount,5,5,50);
  const age=normalized==="rollout-backups"?bounded(minimumAgeDays,30,30,365):bounded(minimumAgeDays,7,7,365);
  try{await client.query("BEGIN");await assertDatabaseIdentity(client,expectedBindings());const current=await client.query("SELECT * FROM public.host_maintenance_config WHERE category=$1 FOR UPDATE",[normalized]);
    if(!current.rowCount||(enabled&&current.rows[0].automation_supported!==true))throw new Error("Automation is not supported for this category");
    if(enabled)await assertHealthyWorker(client,now);
    const revision=Number(current.rows[0].activation_revision)+1;
    await client.query(`INSERT INTO public.host_maintenance_approvals(category,revision,enabled,interval_seconds,retained_verified_count,minimum_age_days,actor_user_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[normalized,revision,enabled===true,interval,keep,age,id,now]);
    const updated=await client.query(`UPDATE public.host_maintenance_config SET scheduled_enabled=$1,interval_seconds=$2,retained_verified_count=$3,minimum_age_days=$4,
      next_run_at=CASE WHEN $1 AND NOT circuit_breaker_open THEN $5::timestamptz+make_interval(secs=>$2) ELSE NULL END,activation_revision=$6,
      activated_at=CASE WHEN $1 THEN $5 ELSE activated_at END,activated_by_user_id=$7,updated_at=$5 WHERE category=$8 RETURNING *`,
      [enabled===true,interval,keep,age,now,revision,id,normalized]);await client.query("COMMIT");return configShape(updated.rows[0]);
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
}

export async function setManualImageRetentionPolicy({executor,actor,minimumAgeDays=7,confirmation="",now=new Date()}={}){
  if(confirmation!==HOST_MAINTENANCE_IMAGE_POLICY_CONFIRMATION)throw new Error(`Type ${HOST_MAINTENANCE_IMAGE_POLICY_CONFIRMATION} to update image retention`);
  const database=executor||await defaultPool();const client=await database.connect();const id=actorId(actor);const age=bounded(minimumAgeDays,7,1,365);
  try{await client.query("BEGIN");await assertDatabaseIdentity(client,expectedBindings());
    const current=await client.query("SELECT * FROM public.host_maintenance_config WHERE category='unused-alpr-images' FOR UPDATE");
    if(!current.rowCount)throw new Error("Unused-image retention configuration is unavailable");
    const row=current.rows[0];const revision=Number(row.activation_revision)+1;
    await client.query(`INSERT INTO public.host_maintenance_approvals(category,revision,enabled,interval_seconds,retained_verified_count,minimum_age_days,actor_user_id,created_at)
      VALUES('unused-alpr-images',$1,FALSE,$2,$3,$4,$5,$6)`,[revision,row.interval_seconds,row.retained_verified_count,age,id,now]);
    const updated=await client.query(`UPDATE public.host_maintenance_config SET scheduled_enabled=FALSE,next_run_at=NULL,minimum_age_days=$1,
      activation_revision=$2,activated_by_user_id=$3,updated_at=$4 WHERE category='unused-alpr-images' RETURNING *`,[age,revision,id,now]);
    await client.query("COMMIT");return configShape(updated.rows[0]);
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
}

export async function acknowledgeHostMaintenanceBreaker({executor,actor,category,confirmation,now=new Date()}={}){
  const normalized=normalizeHostMaintenanceCategory(category);
  if(confirmation!==HOST_MAINTENANCE_ACKNOWLEDGEMENTS[normalized])throw new Error(`Type ${HOST_MAINTENANCE_ACKNOWLEDGEMENTS[normalized]} to acknowledge this failure`);
  const database=executor||await defaultPool();const client=await database.connect();
  try{await client.query("BEGIN");const bindings=await assertDatabaseIdentity(client,expectedBindings());const config=(await client.query("SELECT * FROM public.host_maintenance_config WHERE category=$1 FOR UPDATE",[normalized])).rows[0];
    if(!config?.circuit_breaker_open)throw new Error("Category circuit breaker is not open");
    const environmentId=bindings.environmentId;
    const worker=await assertHealthyWorker(client,now,bindings);
    if(new Date(worker.heartbeat_at)<=new Date(config.circuit_breaker_opened_at) || new Date(worker.inventory_measured_at)<=new Date(config.circuit_breaker_opened_at))
      throw new Error("A fresh worker inventory is required before acknowledgement");
    const failed=(await client.query(`SELECT i.id,r.worker_generation AS failed_worker_generation,r.created_at AS failure_receipt_at
      FROM public.host_maintenance_intents i JOIN public.host_maintenance_receipts r ON r.intent_id=i.id AND r.success=FALSE
      WHERE i.category=$1 AND i.environment_id=$2 AND i.database_identity=$3 AND i.status='failed' AND i.intent_type IN('execute','scheduled')
      ORDER BY i.id DESC LIMIT 1`,[normalized,environmentId,bindings.databaseIdentity])).rows[0];
    if(!failed)throw new Error("No failed destructive intent is available for acknowledgement");
    if(new Date(worker.inventory_measured_at)<=new Date(failed.failure_receipt_at))throw new Error("A post-failure worker inventory is required before acknowledgement");
    await client.query(`INSERT INTO public.host_maintenance_acknowledgements(category,breaker_generation,failed_intent_id,actor_user_id,evidence,created_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[normalized,config.circuit_breaker_generation,failed.id,actorId(actor),JSON.stringify({
        environmentId,databaseIdentity:worker.database_identity,failedWorkerGeneration:failed.failed_worker_generation,
        workerGeneration:worker.worker_generation,inventoryRevision:worker.inventory_revision,
        inventoryMeasuredAt:worker.inventory_measured_at,heartbeatAt:worker.heartbeat_at,
      }),now]);
    const cleared=await client.query(`UPDATE public.host_maintenance_config SET circuit_breaker_open=FALSE,circuit_breaker_opened_at=NULL,circuit_breaker_reason=NULL,
      scheduled_enabled=FALSE,next_run_at=NULL,updated_at=$2 WHERE category=$1 AND circuit_breaker_open=TRUE RETURNING category`,[normalized,now]);
    if(cleared.rowCount!==1)throw new Error("Host maintenance acknowledgement lost its breaker lock");
    await client.query("COMMIT");return{category:normalized,acknowledged:true,breakerGeneration:Number(config.circuit_breaker_generation)};
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
}

export async function getHostBackupCatalogOverview({executor,now=new Date()}={}){
  const database=executor||await defaultPool();const bindings=expectedBindings();
  const unavailable={status:"unavailable",policyReady:false,backupCount:null,backupBytes:null,verifiedCount:null,protectedCount:null,rejectedCount:null,
    candidateCount:null,candidateBytes:null,destructiveExecutionAvailable:false,entries:[]};
  if(!bindings.environmentId||!bindings.databaseIdentity)return unavailable;
  const snapshot=await database.query(`SELECT catalog.* FROM public.host_maintenance_worker_state worker
    JOIN public.host_backup_catalog_snapshots catalog ON catalog.environment_id=worker.environment_id
      AND catalog.database_identity=worker.database_identity AND catalog.inventory_revision=worker.inventory_revision
    WHERE worker.environment_id=$1 AND worker.database_identity=$2 AND worker.last_error IS NULL
      AND worker.heartbeat_at BETWEEN $3::timestamptz-make_interval(secs=>$4) AND $3::timestamptz+make_interval(secs=>$5)
      AND worker.inventory_measured_at BETWEEN $3::timestamptz-make_interval(secs=>$4) AND $3::timestamptz+make_interval(secs=>$5)
    ORDER BY catalog.id DESC LIMIT 1`,[bindings.environmentId,bindings.databaseIdentity,now,HOST_WORKER_STALE_SECONDS,HOST_WORKER_FUTURE_SKEW_SECONDS]);
  if(!snapshot.rowCount)return unavailable;
  const row=snapshot.rows[0];const entryResult=await database.query(`SELECT opaque_id,identity,bytes,backup_created_at,checksum_verified,checksum_sha256,
    explicitly_protected,current_release,rollback_chain,image_ids,backup_environment_id,backup_database_identity,release_id,schema_version,
    postgres_format,device,inode,modified_at,partial,symlink,hardlink_count
    FROM public.host_backup_catalog_entries WHERE snapshot_id=$1 ORDER BY opaque_id`,[row.id]);
  if(entryResult.rowCount!==Number(row.backup_count))return{...unavailable,status:"blocked",policyBlocks:["catalog-entry-count-mismatch"]};
  const catalog={version:row.catalog_version,catalogRevision:row.catalog_revision,inventoryRevision:row.inventory_revision,
    environmentId:row.environment_id,databaseIdentity:row.database_identity,workerGeneration:row.worker_generation,measuredAt:row.inventory_measured_at,
    catalogComplete:row.catalog_complete===true,releaseLedgerComplete:row.release_ledger_complete===true,
    backupCount:Number(row.backup_count),backupBytes:Number(row.backup_bytes),
    authoritativeCurrentReleaseCount:Number(row.authoritative_current_release_count),leases:{backupRestore:row.backup_restore_lease===true,
      build:row.build_lease===true,deploy:row.deploy_lease===true,rollback:row.rollback_lease===true},
    entries:entryResult.rows.map((entry)=>({id:entry.opaque_id,identity:entry.identity,bytes:Number(entry.bytes),createdAt:entry.backup_created_at,
      checksumVerified:entry.checksum_verified===true,checksumSha256:entry.checksum_sha256||"",protected:entry.explicitly_protected===true,
      currentRelease:entry.current_release===true,rollbackChain:entry.rollback_chain===true,imageIds:Array.isArray(entry.image_ids)?entry.image_ids:[],
      environmentId:entry.backup_environment_id,databaseIdentity:entry.backup_database_identity,releaseId:entry.release_id,
      schemaVersion:entry.schema_version,postgresFormat:entry.postgres_format,device:entry.device,inode:entry.inode,modifiedAt:entry.modified_at,
      partial:entry.partial===true,symlink:entry.symlink===true,hardlinkCount:Number(entry.hardlink_count)}))};
  try{return publicHostBackupCatalogPreview(buildHostBackupCatalogPreview(catalog,{now}));}
  catch{return{...unavailable,status:"blocked",policyBlocks:["catalog-integrity-mismatch"]};}
}

export async function getHostMaintenanceOverview({executor,now=new Date(),workerStaleSeconds=HOST_WORKER_STALE_SECONDS}={}){
 const database=executor||await defaultPool();const bindings=expectedBindings();const expected=bindings.environmentId;const[configs,intents,runs,worker,identity,backups,backupCatalog]=await Promise.all([
  database.query("SELECT * FROM public.host_maintenance_config ORDER BY category"),
  database.query("SELECT id,intent_type,category,status,requested_at,started_at,completed_at,candidate_count,candidate_bytes,reclaimed_bytes,last_error,inventory_measured_at FROM public.host_maintenance_intents ORDER BY id DESC LIMIT 20"),
  database.query("SELECT id,job_name,trigger_type,mode,status,started_at,completed_at,duration_ms,candidate_count,candidate_bytes,reclaimed_bytes,failure_count,last_error,configuration,result,created_at FROM public.maintenance_runs WHERE job_name LIKE 'host-maintenance:%' ORDER BY id DESC LIMIT 20"),
  database.query("SELECT environment_id,database_identity,worker_generation,heartbeat_at,inventory_revision,inventory_measured_at,database_backup_capability,database_backup_capability_at,last_error FROM public.host_maintenance_worker_state WHERE environment_id=$1 AND database_identity=$2 LIMIT 1",[expected||"",bindings.databaseIdentity||""]),
  database.query("SELECT 1 FROM public.host_maintenance_environment_identity WHERE singleton=TRUE AND environment_id=$1 AND database_identity=$2 LIMIT 1",[expected||"",bindings.databaseIdentity||""]),
  database.query("SELECT id,status,requested_at,started_at,completed_at,filename,size_bytes,verified,last_error FROM public.host_database_backup_requests WHERE environment_id=$1 AND database_identity=$2 ORDER BY id DESC LIMIT 1",[expected||"",bindings.databaseIdentity||""]),
  getHostBackupCatalogOverview({executor:database,now}) ]);
  const row=worker.rows?.[0];
  const heartbeatTime=row?new Date(row.heartbeat_at).getTime():NaN;
  const inventoryTime=row?new Date(row.inventory_measured_at).getTime():NaN;
  const ageSeconds=row?Math.max(0,Math.floor((now.getTime()-heartbeatTime)/1000)):null;
  const workerShape=!identity.rowCount?{status:"unavailable",ageSeconds:null,note:"The host maintenance database identity is not initialized or does not match this environment."}
    :!row?{status:"unavailable",ageSeconds:null,note:"Install the separate fixed host worker; the web application has no host access."}
    :row.last_error||heartbeatTime>now.getTime()+HOST_WORKER_FUTURE_SKEW_SECONDS*1000||inventoryTime>now.getTime()+HOST_WORKER_FUTURE_SKEW_SECONDS*1000||
      now.getTime()-inventoryTime>workerStaleSeconds*1000||ageSeconds>workerStaleSeconds?{status:"stale",ageSeconds,environment_id:row.environment_id,heartbeat_at:row.heartbeat_at,note:"The fixed host worker heartbeat is stale or unhealthy; host controls are fail-closed."}
    :{status:"healthy",ageSeconds,...row};
  const publicIntents=intents.rows.map((item)=>({...item,last_error:item.status==='failed'?'HOST_MAINTENANCE_FAILED':null}));
  const publicRuns=runs.rows.map((item)=>({...item,last_error:item.status==='failed'?'HOST_MAINTENANCE_FAILED':null}));
  const capabilityFresh=workerShape.status==='healthy'&&row?.database_backup_capability==='database-backup-create-v1'&&
    new Date(row.database_backup_capability_at).getTime()===heartbeatTime;
  const databaseBackup={...databaseBackupShape(backups.rows?.[0]),supported:capabilityFresh,scheduled:false,restoreSupported:false};
  return{configs:configs.rows.map(configShape),intents:publicIntents,runs:publicRuns,worker:workerShape,databaseBackup,backupCatalog,
    confirmationPhrases:HOST_MAINTENANCE_CONFIRMATIONS,activationPhrases:HOST_MAINTENANCE_ACTIVATIONS,acknowledgementPhrases:HOST_MAINTENANCE_ACKNOWLEDGEMENTS};}

export async function enqueueDueScheduledHostMaintenance({executor,now=new Date()}={}){const database=executor||await defaultPool();const bindings=expectedBindings();
  if(!bindings.environmentId||!bindings.databaseIdentity)return{status:"unavailable"};
  try{await assertDatabaseIdentity(database,bindings);}catch{return{status:"unavailable"};}
  const result=await database.query(`WITH due AS (
  UPDATE public.host_maintenance_config SET next_run_at=$1::timestamptz+make_interval(secs=>interval_seconds),updated_at=$1
  WHERE scheduled_enabled=TRUE AND automation_supported=TRUE AND circuit_breaker_open=FALSE AND next_run_at<=$1
    AND EXISTS(SELECT 1 FROM public.host_maintenance_worker_state WHERE environment_id=$3 AND database_identity=$5 AND last_error IS NULL
      AND heartbeat_at BETWEEN $1::timestamptz-make_interval(secs=>$2) AND $1::timestamptz+make_interval(secs=>$4)
      AND inventory_measured_at BETWEEN $1::timestamptz-make_interval(secs=>$2) AND $1::timestamptz+make_interval(secs=>$4)) RETURNING category)
  INSERT INTO public.host_maintenance_intents(intent_type,category,environment_id,database_identity,status,requested_at)
  SELECT 'scheduled',category,$3,$5,'pending',$1 FROM due RETURNING id,category`,[now,HOST_WORKER_STALE_SECONDS,bindings.environmentId,HOST_WORKER_FUTURE_SKEW_SECONDS,bindings.databaseIdentity]);
  return result.rowCount?{status:"queued",requests:result.rows.map((r)=>({requestId:Number(r.id),category:r.category}))}:{status:"not-due"};}

export const hostMaintenanceControlInternals=Object.freeze({assertDatabaseIdentity,assertHealthyWorker,configShape,databaseBackupShape});
