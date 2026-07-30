import { createHash, randomBytes } from "node:crypto";

import { getHostMaintenanceAdapter } from "./host-maintenance-adapter.mjs";
import {
  assertFreshHostMaintenanceInventory, buildHostMaintenancePlan, candidateSetHash, canonicalHostInventoryRevision,
  HOST_MAINTENANCE_CAPS, HOST_MAINTENANCE_PREVIEW_TTL_SECONDS, hostMaintenanceJob,
  planForCategory, plansMatch,
} from "./host-maintenance-policy.mjs";

async function defaultPool(){return(await import("./db.js")).getPool();}
const sha256=(value)=>createHash("sha256").update(String(value)).digest("hex");
const rawError=(error)=>String(error?.message||error||"Host maintenance failed").slice(0,2000);
const FAILURE_CODE="HOST_MAINTENANCE_FAILED";
function configuredIdentity(name){const value=String(process.env[name]||"").trim();return/^[A-Za-z0-9][A-Za-z0-9:_.@+-]{0,199}$/.test(value)?value:null;}
function expectedBindings({expectedEnvironmentId,expectedDatabaseIdentity}={}){
  const environmentId=expectedEnvironmentId||configuredIdentity("HOST_MAINTENANCE_ENVIRONMENT_ID");
  const databaseIdentity=expectedDatabaseIdentity||configuredIdentity("HOST_MAINTENANCE_DATABASE_IDENTITY");
  if(!environmentId||!databaseIdentity)throw new Error("Host worker environment binding is not configured");
  return{environmentId,databaseIdentity};
}
async function assertDatabaseIdentity(pool,bindings){
  const result=await pool.query(`SELECT 1 FROM public.host_maintenance_environment_identity
    WHERE singleton=TRUE AND environment_id=$1 AND database_identity=$2 LIMIT 1`,[bindings.environmentId,bindings.databaseIdentity]);
  if(!result.rowCount)throw new Error("Host worker database identity mismatch");
}
function capPlan(plan){const cap=HOST_MAINTENANCE_CAPS[plan.category];const items=[];let total=0;
  for(const item of[...plan.items].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))){if(items.length>=cap.maxItems||total+item.bytes>cap.maxBytes)break;items.push(item);total+=item.bytes;}
  return{...plan,items,candidateCount:items.length,candidateBytes:total,cap};}
function assertOwned(result,context){if(result.rowCount!==1)throw new Error(`HOST_MAINTENANCE_FATAL_INVARIANT: lost worker lease during ${context}`);}

async function inspectFresh(adapter,bindings,now){
  const inventory=assertFreshHostMaintenanceInventory(await adapter.inspect(),{now,expectedEnvironmentId:bindings.environmentId,expectedDatabaseIdentity:bindings.databaseIdentity});
  if(inventory.revision!==canonicalHostInventoryRevision(inventory))throw new Error("Host inventory revision is not the canonical protection hash");
  return inventory;
}
async function heartbeat(pool,inventory,workerId,now){
  await pool.query(`INSERT INTO public.host_maintenance_worker_state
    (environment_id,database_identity,worker_generation,worker_id,heartbeat_at,inventory_revision,inventory_measured_at,last_error,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$5) ON CONFLICT(environment_id) DO UPDATE SET database_identity=EXCLUDED.database_identity,
      worker_generation=EXCLUDED.worker_generation,worker_id=EXCLUDED.worker_id,heartbeat_at=EXCLUDED.heartbeat_at,
      inventory_revision=EXCLUDED.inventory_revision,inventory_measured_at=EXCLUDED.inventory_measured_at,last_error=NULL,updated_at=EXCLUDED.updated_at`,
    [inventory.environmentId,inventory.databaseIdentity,inventory.workerGeneration,String(workerId).slice(0,255),now,inventory.revision,inventory.measuredAt]);
}
async function recordWorkerError(pool,environmentId){
  await pool.query("UPDATE public.host_maintenance_worker_state SET last_error=$2,updated_at=CURRENT_TIMESTAMP WHERE environment_id=$1",[environmentId,FAILURE_CODE]);
}
export async function inspectAndHeartbeatHostMaintenanceWorker({executor,adapter=getHostMaintenanceAdapter(),workerId=`host-maintenance-${process.pid}`,now=new Date(),...bindingInput}={}){
  const pool=executor||await defaultPool();const bindings=expectedBindings(bindingInput);
  await assertDatabaseIdentity(pool,bindings);
  try{const inventory=await inspectFresh(adapter,bindings,now);await heartbeat(pool,inventory,workerId,now);return{status:"healthy",environmentId:bindings.environmentId,workerGeneration:inventory.workerGeneration,inventoryRevision:inventory.revision};}
  catch(error){await recordWorkerError(pool,bindings.environmentId);throw error;}
}

async function claimIntent(pool,workerId,environmentId,databaseIdentity,now){const client=await pool.connect();try{await client.query("BEGIN");
  const result=await client.query(`WITH candidate AS(SELECT id FROM public.host_maintenance_intents
    WHERE status='pending' AND environment_id=$3 AND database_identity=$4 ORDER BY requested_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE public.host_maintenance_intents i SET status='processing',locked_at=$1,locked_by=$2,started_at=$1,updated_at=$1
    FROM candidate WHERE i.id=candidate.id RETURNING i.*`,[now,String(workerId).slice(0,255),environmentId,databaseIdentity]);
  await client.query("COMMIT");return result.rows?.[0]||null;}catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}}

async function insertPreviewItems(client,previewId,items){for(const item of items)await client.query(`INSERT INTO public.host_maintenance_preview_items
  (preview_id,artifact_kind,opaque_id,identity,bytes,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
  [previewId,item.kind,item.id,item.identity,item.bytes,JSON.stringify({checksumSha256:item.checksumSha256||null,device:item.device||null,inode:item.inode||null,modifiedAt:item.modifiedAt||null})]);}

async function processPreview(pool,adapter,intent,now,workerId,bindings){
  const config=(await pool.query("SELECT * FROM public.host_maintenance_config WHERE category=$1",[intent.category])).rows[0];
  const inventory=await inspectFresh(adapter,bindings,now);if(inventory.hostLockAvailable!==true)throw new Error("Shared host maintenance lock is unavailable");
  await heartbeat(pool,inventory,workerId,now);
  const plan=capPlan(planForCategory(buildHostMaintenancePlan(inventory,{retainedVerifiedCount:config.retained_verified_count,minimumAgeDays:config.minimum_age_days,now}),intent.category));
  const token=randomBytes(32).toString("hex");const client=await pool.connect();try{await client.query("BEGIN");
    const owned=await client.query("SELECT id FROM public.host_maintenance_intents WHERE id=$1 AND status='processing' AND locked_by=$2 FOR UPDATE",[intent.id,intent.locked_by]);assertOwned(owned,"preview completion");
    const run=await client.query(`INSERT INTO public.maintenance_runs(job_name,trigger_type,mode,status,actor_user_id,completed_at,candidate_count,candidate_bytes,configuration,result)
      VALUES($1,'manual','preview','previewed',$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id`,[hostMaintenanceJob(intent.category),intent.actor_user_id,now,plan.candidateCount,plan.candidateBytes,
      JSON.stringify({category:intent.category,policyRevision:Number(config.activation_revision),environmentId:bindings.environmentId}),JSON.stringify({destructive:false,candidateSetHash:candidateSetHash(plan)})]);
    const preview=await client.query(`INSERT INTO public.host_maintenance_previews(intent_id,category,actor_user_id,token_hash,environment_id,database_identity,policy_revision,worker_generation,
      inventory_revision,candidate_set_hash,inventory_measured_at,expires_at,candidate_count,candidate_bytes,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz+make_interval(secs=>$13),$14,$15,$12) RETURNING id`,
      [intent.id,intent.category,intent.actor_user_id,sha256(token),bindings.environmentId,bindings.databaseIdentity,Number(config.activation_revision),plan.workerGeneration,plan.inventoryRevision,candidateSetHash(plan),plan.measuredAt,now,HOST_MAINTENANCE_PREVIEW_TTL_SECONDS,plan.candidateCount,plan.candidateBytes]);
    await client.query("INSERT INTO public.host_maintenance_preview_deliveries(preview_id,opaque_token,created_at) VALUES($1,$2,$3)",[preview.rows[0].id,token,now]);
    await insertPreviewItems(client,preview.rows[0].id,plan.items);
    const completed=await client.query(`UPDATE public.host_maintenance_intents SET status='completed',run_id=$3,completed_at=$4,inventory_revision=$5,inventory_measured_at=$6,
      candidate_count=$7,candidate_bytes=$8,locked_at=NULL,locked_by=NULL,updated_at=$4 WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id`,
      [intent.id,intent.locked_by,run.rows[0].id,now,plan.inventoryRevision,plan.measuredAt,plan.candidateCount,plan.candidateBytes]);assertOwned(completed,"preview commit");
    await client.query("COMMIT");return{status:"completed",intentId:Number(intent.id),candidateCount:plan.candidateCount};
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}}

async function loadExpectedPreview(pool,intent,now){if(intent.intent_type!=="execute")return null;
  const result=await pool.query(`SELECT p.*,c.activation_revision FROM public.host_maintenance_previews p
    JOIN public.host_maintenance_config c ON c.category=p.category JOIN public.host_maintenance_preview_consumptions x ON x.preview_id=p.id AND x.execution_intent_id=$1
    WHERE p.intent_id=$2 AND p.expires_at>$3`,[intent.id,intent.preview_intent_id,now]);if(!result.rowCount)throw new Error("Preview is expired, unconsumed, or invalid");
  const preview=result.rows[0];if(Number(preview.policy_revision)!==Number(preview.activation_revision))throw new Error("Maintenance policy changed after preview");
  const items=(await pool.query(`SELECT artifact_kind AS kind,opaque_id AS id,identity,bytes,evidence FROM public.host_maintenance_preview_items
    WHERE preview_id=$1 ORDER BY artifact_kind,opaque_id`,[preview.id])).rows.map((item)=>({...item,bytes:Number(item.bytes),...(item.evidence||{})}));return{preview,items};}

export function validateHostMaintenanceReceipt(receipt,request){
  if(!receipt||receipt.hostLockHeld!==true||receipt.environmentId!==request.environmentId||receipt.databaseIdentity!==request.databaseIdentity||receipt.workerGeneration!==request.workerGeneration||
    receipt.inventoryRevision!==request.inventoryRevision||receipt.candidateSetHash!==request.candidateSetHash)throw new Error("Worker receipt binding mismatch");
  if(!Number.isSafeInteger(receipt.durationMs)||receipt.durationMs<0||receipt.durationMs>request.maxDurationSeconds*1000)throw new Error("Worker receipt duration is invalid");
  if(!Array.isArray(receipt.results)||receipt.results.length!==request.items.length)throw new Error("Worker receipt set size mismatch");
  const expected=new Map(request.items.map((item)=>[`${item.kind}:${item.id}`,item]));const seen=new Set();let total=0;
  for(const item of receipt.results){const key=`${item.kind}:${item.id}`;const source=expected.get(key);
    if(!source||seen.has(key)||item.identity!==source.identity)throw new Error("Worker receipt contains extra, duplicate, or identity-mismatched artifacts");seen.add(key);
    if(!["deleted","quarantined","skipped"].includes(item.status))throw new Error("Worker receipt status is invalid");
    const reclaimed=Number(item.reclaimedBytes);if(!Number.isSafeInteger(reclaimed)||reclaimed<0||reclaimed>source.bytes||(item.status==="skipped"&&reclaimed!==0))throw new Error("Worker receipt reclaimed bytes are invalid");total+=reclaimed;
  }
  if(seen.size!==expected.size||!Number.isSafeInteger(receipt.reclaimedBytes)||receipt.reclaimedBytes!==total||total>request.maxBytes||total>request.candidateBytes)
    throw new Error("Worker receipt reclaimed total is invalid");return{reclaimedBytes:total,results:receipt.results};
}

async function processPrune(pool,adapter,intent,now,workerId,bindings){
  const config=(await pool.query("SELECT * FROM public.host_maintenance_config WHERE category=$1",[intent.category])).rows[0];if(config.circuit_breaker_open)throw new Error("Category circuit breaker is open");
  if(intent.intent_type==="scheduled"&&intent.category==="unused-alpr-images")throw new Error("Scheduled unused-image pruning is hard-disabled by the worker");
  if(intent.intent_type==="scheduled"&&(!config.scheduled_enabled||!config.automation_supported))throw new Error("Scheduled category is not enabled and supported");
  const expected=await loadExpectedPreview(pool,intent,now);const inventory=await inspectFresh(adapter,bindings,now);if(inventory.hostLockAvailable!==true)throw new Error("Shared host maintenance lock is unavailable");
  await heartbeat(pool,inventory,workerId,now);const current=capPlan(planForCategory(buildHostMaintenancePlan(inventory,{retainedVerifiedCount:config.retained_verified_count,minimumAgeDays:config.minimum_age_days,now}),intent.category));
  if(expected){const bound={...current,inventoryRevision:expected.preview.inventory_revision,environmentId:expected.preview.environment_id,databaseIdentity:expected.preview.database_identity,workerGeneration:expected.preview.worker_generation,items:expected.items};
    if(expected.preview.environment_id!==bindings.environmentId||expected.preview.database_identity!==bindings.databaseIdentity||candidateSetHash(bound)!==expected.preview.candidate_set_hash||!plansMatch(bound,current))throw new Error("Exact preview binding changed");}
  const plan=expected?{...current,items:expected.items,candidateCount:expected.items.length,candidateBytes:expected.items.reduce((sum,item)=>sum+item.bytes,0)}:current;
  const runClient=await pool.connect();try{await runClient.query("BEGIN");
    const owned=await runClient.query("SELECT id FROM public.host_maintenance_intents WHERE id=$1 AND status='processing' AND locked_by=$2 FOR UPDATE",[intent.id,intent.locked_by]);assertOwned(owned,"run creation");
    const run=await runClient.query(`INSERT INTO public.maintenance_runs(job_name,trigger_type,mode,status,actor_user_id,started_at,candidate_count,candidate_bytes,configuration,result)
      VALUES($1,$2,'execute','running',$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING id`,[hostMaintenanceJob(intent.category),intent.intent_type==='scheduled'?'scheduled':'manual',intent.actor_user_id,now,
      plan.candidateCount,plan.candidateBytes,JSON.stringify({category:intent.category,environmentId:bindings.environmentId,databaseIdentity:bindings.databaseIdentity,candidateSetHash:candidateSetHash(plan)}),JSON.stringify({revalidated:true})]);intent.run_id=run.rows[0].id;
    const runBound=await runClient.query("UPDATE public.host_maintenance_intents SET run_id=$3 WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id",[intent.id,intent.locked_by,intent.run_id]);assertOwned(runBound,"run binding");
    await runClient.query("COMMIT");}catch(error){try{await runClient.query("ROLLBACK");}catch{}throw error;}finally{runClient.release();}
  const request={category:intent.category,environmentId:bindings.environmentId,databaseIdentity:bindings.databaseIdentity,workerGeneration:plan.workerGeneration,inventoryRevision:plan.inventoryRevision,candidateSetHash:candidateSetHash(plan),items:plan.items,
    candidateBytes:plan.candidateBytes,maxItems:plan.cap.maxItems,maxBytes:plan.cap.maxBytes,maxDurationSeconds:plan.cap.maxDurationSeconds,deadline:new Date(now.getTime()+plan.cap.maxDurationSeconds*1000).toISOString()};
  const validated=validateHostMaintenanceReceipt(await adapter.prune(request),request);const completedAt=new Date();const client=await pool.connect();try{await client.query("BEGIN");
    const owned=await client.query("SELECT id FROM public.host_maintenance_intents WHERE id=$1 AND status='processing' AND locked_by=$2 FOR UPDATE",[intent.id,intent.locked_by]);assertOwned(owned,"destructive completion");
    const stored=await client.query(`INSERT INTO public.host_maintenance_receipts(intent_id,category,environment_id,database_identity,worker_generation,inventory_revision,candidate_set_hash,success,reclaimed_bytes,result,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9::jsonb,$10) RETURNING id`,[intent.id,intent.category,bindings.environmentId,bindings.databaseIdentity,plan.workerGeneration,plan.inventoryRevision,request.candidateSetHash,validated.reclaimedBytes,JSON.stringify({hostLockHeld:true}),completedAt]);
    for(const item of validated.results)await client.query(`INSERT INTO public.host_maintenance_receipt_items(receipt_id,artifact_kind,opaque_id,identity,status,reclaimed_bytes,error)
      VALUES($1,$2,$3,$4,$5,$6,NULL)`,[stored.rows[0].id,item.kind,item.id,item.identity,item.status,item.reclaimedBytes]);
    const runDone=await client.query(`UPDATE public.maintenance_runs SET status='completed',completed_at=$2,duration_ms=GREATEST(0,EXTRACT(EPOCH FROM($2-started_at))*1000)::bigint,
      reclaimed_bytes=$3,result=result||$4::jsonb,updated_at=$2 WHERE id=$1 AND status='running' RETURNING id`,[intent.run_id,completedAt,validated.reclaimedBytes,JSON.stringify({receiptId:Number(stored.rows[0].id)})]);assertOwned(runDone,"run completion");
    const intentDone=await client.query(`UPDATE public.host_maintenance_intents SET status='completed',completed_at=$3,inventory_revision=$4,inventory_measured_at=$5,candidate_count=$6,candidate_bytes=$7,
      reclaimed_bytes=$8,locked_at=NULL,locked_by=NULL,updated_at=$3 WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id`,
      [intent.id,intent.locked_by,completedAt,plan.inventoryRevision,plan.measuredAt,plan.candidateCount,plan.candidateBytes,validated.reclaimedBytes]);assertOwned(intentDone,"intent completion");
    await client.query("COMMIT");return{status:"completed",intentId:Number(intent.id),runId:Number(intent.run_id),reclaimedBytes:validated.reclaimedBytes};
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}}

async function writeFailure(client,intent,error,now){const destructive=["execute","scheduled"].includes(intent.intent_type);const detail=rawError(error);
  const failed=await client.query(`UPDATE public.host_maintenance_intents SET status='failed',completed_at=$3,last_error=$4,locked_at=NULL,locked_by=NULL,updated_at=$3
    WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id`,[intent.id,intent.locked_by,now,detail]);assertOwned(failed,"failure persistence");
  if(intent.run_id){const runFailed=await client.query("UPDATE public.maintenance_runs SET status='failed',completed_at=$2,failure_count=GREATEST(failure_count,1),last_error=$3,updated_at=$2 WHERE id=$1 AND status='running' RETURNING id",[intent.run_id,now,detail]);assertOwned(runFailed,"failed run persistence");}
  if(destructive){const breaker=await client.query(`UPDATE public.host_maintenance_config SET scheduled_enabled=FALSE,next_run_at=NULL,circuit_breaker_open=TRUE,circuit_breaker_opened_at=$1,
      circuit_breaker_reason=$2,circuit_breaker_generation=circuit_breaker_generation+1,updated_at=$1 WHERE category=$3 RETURNING category`,[now,detail,intent.category]);assertOwned(breaker,"breaker persistence");
    await client.query(`INSERT INTO public.host_maintenance_receipts(intent_id,category,environment_id,database_identity,worker_generation,inventory_revision,candidate_set_hash,success,reclaimed_bytes,result,created_at)
      SELECT $1,$2,$3,$4,COALESCE(p.worker_generation,'unknown'),COALESCE(p.inventory_revision,'unknown'),COALESCE(p.candidate_set_hash,$5),FALSE,0,
        jsonb_build_object('error',$6::text,'ambiguous',TRUE),$7 FROM(SELECT 1)seed LEFT JOIN public.host_maintenance_previews p ON p.intent_id=$8`,
      [intent.id,intent.category,intent.environment_id,intent.database_identity,sha256(`failed:${intent.id}`),detail,now,intent.preview_intent_id||0]);}
  await client.query(`INSERT INTO public.audit_events(actor_user_id,source,event_type,resource_type,resource_id,outcome,reason,metadata)
    VALUES($1,'host-worker',$2,'host-maintenance-intent',$3,'failed',$4,jsonb_build_object('category',$5::text,'breakerOpened',$6::boolean))`,
    [intent.actor_user_id,destructive?'maintenance.host_prune_failed':'maintenance.host_preview_failed',String(intent.id),detail,intent.category,destructive]);}

async function failIntentAtomic(pool,intent,error,now){const client=await pool.connect();try{await client.query("BEGIN");await client.query("SET LOCAL lock_timeout='5s'");
  await writeFailure(client,intent,error,now);await client.query("COMMIT");}catch(failure){try{await client.query("ROLLBACK");}catch{}
  const fatal=new Error(`HOST_MAINTENANCE_FATAL_INVARIANT: unable to persist authoritative failure: ${rawError(failure)}`);fatal.cause=failure;throw fatal;}finally{client.release();}}

export async function recoverStaleHostMaintenanceLeases({executor,now=new Date(),leaseSeconds=600,...bindingInput}={}){const pool=executor||await defaultPool();const bindings=expectedBindings(bindingInput);const client=await pool.connect();let recovered=0;
  try{await assertDatabaseIdentity(client,bindings);await client.query("BEGIN");const stale=await client.query(`SELECT * FROM public.host_maintenance_intents WHERE status='processing' AND environment_id=$1 AND database_identity=$4
    AND locked_at<$2::timestamptz-make_interval(secs=>$3) ORDER BY id FOR UPDATE SKIP LOCKED`,[bindings.environmentId,now,leaseSeconds,bindings.databaseIdentity]);
    for(const intent of stale.rows){await writeFailure(client,intent,new Error("Host worker lease expired; outcome is ambiguous"),now);recovered++;}
    await client.query("COMMIT");return{recovered};}catch(error){try{await client.query("ROLLBACK");}catch{}throw new Error(`HOST_MAINTENANCE_FATAL_INVARIANT: stale lease recovery failed: ${rawError(error)}`);}finally{client.release();}}

export async function processNextHostMaintenanceIntent({executor,adapter=getHostMaintenanceAdapter(),workerId=`host-maintenance-${process.pid}`,now=()=>new Date(),...bindingInput}={}){
  const pool=executor||await defaultPool();const bindings=expectedBindings(bindingInput);await assertDatabaseIdentity(pool,bindings);await recoverStaleHostMaintenanceLeases({executor:pool,now:now(),...bindings});
  const intent=await claimIntent(pool,workerId,bindings.environmentId,bindings.databaseIdentity,now());if(!intent)return{status:"idle"};
  try{return intent.intent_type==='preview'?await processPreview(pool,adapter,intent,now(),workerId,bindings):await processPrune(pool,adapter,intent,now(),workerId,bindings);}
  catch(error){await failIntentAtomic(pool,intent,error,now());
    try{await recordWorkerError(pool,bindings.environmentId);}catch(stateError){throw new Error(`HOST_MAINTENANCE_FATAL_INVARIANT: failure persisted but worker error state failed: ${rawError(stateError)}`);}
    throw error;}
}

export const hostMaintenanceWorkerInternals=Object.freeze({assertDatabaseIdentity,capPlan,claimIntent,failIntentAtomic,processPreview,processPrune,validateHostMaintenanceReceipt,writeFailure});
