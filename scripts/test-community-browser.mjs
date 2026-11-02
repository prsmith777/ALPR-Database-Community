import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { HomeAssistantDisplayService } from "../lib/home-assistant-display.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function exerciseBrowser(config) {
  const modulePath = process.env.ALPR_TEST_PLAYWRIGHT_MODULE;
  if (!modulePath || !path.isAbsolute(modulePath)) throw new Error("Set ALPR_TEST_PLAYWRIGHT_MODULE to an installed playwright-core module.");
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const executablePath = process.env.ALPR_TEST_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  assert.ok(existsSync(executablePath));
  const home = await mkdtemp(path.join(os.tmpdir(),"alpr-community-browser-"));
  assert.equal(path.dirname(home),os.tmpdir());
  const password = randomBytes(24).toString("hex");
  let source = "", browser, child;
  const parent = http.createServer((_req,res)=>{res.setHeader("Content-Type","text/html");res.end(`<iframe title="ALPR" src="${source}" width="100%" height="900"></iframe>`);});
  const blockedParent = http.createServer((_req,res)=>{res.setHeader("Content-Type","text/html");res.end(`<iframe title="ALPR" src="${source}"></iframe>`);});
  const blueIris = http.createServer(async (request,response)=>{
    if(request.method!=="POST"){response.writeHead(404);response.end();return;}
    let text="";for await(const chunk of request)text+=chunk;
    const command=JSON.parse(text || "{}");
    let result={result:"fail"};
    if(command.cmd==="login")result=command.response
      ? {result:"success",session:"fixture-session",data:{systemName:"Synthetic Blue Iris",version:"6.1"}}
      : {result:"fail",session:"fixture-challenge"};
    if(command.cmd==="camlist")result={result:"success",data:[{optionValue:"eastlpr",optionDisplay:"East LPR",isEnabled:true,isOnline:true}]};
    if(command.cmd==="alertlist")result={result:"success",data:[{camera:"eastlpr",date:Math.floor(config.read.timestamp.getTime()/1000),clip:"@fixture.bvr",offset:0}]};
    response.setHeader("Content-Type","application/json");response.end(JSON.stringify(result));
  });
  const placeholder = http.createServer();placeholder.listen(0,"127.0.0.1");await once(placeholder,"listening");
  const port=placeholder.address().port;await new Promise(resolve=>placeholder.close(resolve));
  parent.listen(0,"127.0.0.1");blockedParent.listen(0,"127.0.0.1");blueIris.listen(0,"127.0.0.1");
  await Promise.all([once(parent,"listening"),once(blockedParent,"listening"),once(blueIris,"listening")]);
  const origin=`http://127.0.0.1:${port}`, parentOrigin=`http://127.0.0.1:${parent.address().port}`;
  const logs=[];
  try {
    await mkdir(path.join(home,"storage/images"),{recursive:true});
    await mkdir(path.join(home,"config"),{recursive:true});
    await writeFile(path.join(home,"config/settings.yaml"),JSON.stringify({blueiris:{host:`http://127.0.0.1:${blueIris.address().port}`,username:"fixture",password:"fixture-password"}}));
    await config.pool.query(`INSERT INTO public.camera_direction_profiles(camera_key,camera_name,enabled,front_direction_label,rear_direction_label)
      VALUES ('eastlpr','eastlpr',false,'Westbound','Eastbound') ON CONFLICT(camera_key) DO UPDATE SET front_direction_label='Westbound',rear_direction_label='Eastbound'`);
    await writeFile(path.join(home,"storage/images/fixture.jpg"),await sharp({create:{width:320,height:180,channels:3,background:"#315a85"}}).jpeg().toBuffer());
    child=spawn(process.execPath,[path.join(root,"node_modules/next/dist/bin/next"),"start","-p",String(port),"-H","127.0.0.1"],{
      cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],
      env:{...process.env,NODE_ENV:"production",NEXT_TELEMETRY_DISABLED:"1",PORT:String(port),HOSTNAME:"127.0.0.1",ALPR_DATA_DIR:home,
        DB_HOST:`127.0.0.1:${config.port}`,DB_NAME:config.database,DB_USER:config.user,DB_PASSWORD:config.password,ADMIN_PASSWORD:password,
        ALPR_AUTH_FILE_PATH:path.join(home,"auth/auth.json"),ALPR_CONFIG_FILE_PATH:path.join(home,"config/settings.yaml"),MQTT_BROKER:"",PUSHOVER_ENABLED:"false",
        ALPR_INTERNAL_ORIGIN:origin,BLUEIRIS_HOST:"",BLUEIRIS_USERNAME:"",BLUEIRIS_PASSWORD:""},
    });
    child.stdout.on("data",chunk=>logs.push(String(chunk)));child.stderr.on("data",chunk=>logs.push(String(chunk)));
    let ready=false;
    for(let i=0;i<120;i++){
      if(child.exitCode!==null)throw new Error("Test application exited before readiness");
      try{if((await fetch(origin+"/api/health-check")).ok){ready=true;break;}}catch{}
      await delay(250);
    }
    assert.ok(ready,"production app health check");
    const service=new HomeAssistantDisplayService(config.pool);
    const grant=await service.create({label:"Browser fixture display",allowedOrigin:parentOrigin,cameraName:"eastlpr",days:1},{username:"fixture"});
    source=origin+`/embed/home-assistant/${grant.id}#token=${grant.token}`;
    const shell=await fetch(origin+`/embed/home-assistant/${grant.id}`);
    assert.equal(shell.status,200);
    assert.notEqual(shell.headers.get("x-frame-options"),"DENY");
    assert.ok(shell.headers.get("content-security-policy").includes(`frame-ancestors ${parentOrigin};`));
    assert.equal((await fetch(origin+`/api/home-assistant/display/${grant.id}`)).status,401);
    assert.equal((await fetch(origin+"/api/current-access",{headers:{Authorization:"Bearer "+grant.token}})).status,401);
    const normal=await fetch(origin+"/login");assert.equal(normal.headers.get("x-frame-options"),"DENY");
    browser=await chromium.launch({executablePath,headless:true});
    const page=await browser.newPage({viewport:{width:1100,height:900}});
    const requests=[];page.on("request",request=>requests.push(request.url()));
    await page.goto(parentOrigin);
    const frame=page.frameLocator('iframe');
    await frame.getByRole("heading",{name:"Browser fixture display"}).waitFor();
    await frame.getByRole("heading",{name:"TST5701",exact:true}).waitFor();
    assert.equal(await frame.getByRole("heading",{name:"TST5702",exact:true}).count(),0);
    await frame.locator("img").first().waitFor();
    assert.ok(requests.every(url=>!url.includes(grant.token)),"fragment credential is absent from HTTP request URLs");
    assert.equal((await page.context().cookies()).some(cookie=>cookie.name==='session'),false);
    await page.screenshot({path:path.join(home,"home-assistant-display.png"),fullPage:true});
    const blocked=await browser.newPage();let policyBlocked=false;
    blocked.on("console",message=>{if(/frame-ancestors|Refused to frame/i.test(message.text()))policyBlocked=true;});
    await blocked.goto(`http://127.0.0.1:${blockedParent.address().port}`);
    for(let i=0;i<20&&!policyBlocked;i++)await delay(100);
    assert.ok(policyBlocked,"an unapproved parent origin is blocked by the browser");
    await service.revoke(grant.id);
    await frame.getByRole("button",{name:"Refresh",exact:true}).click();
    await frame.getByRole("status").filter({hasText:"expired or was revoked"}).waitFor();
    assert.equal(await frame.locator("article").count(),0);
    assert.equal((await fetch(origin+`/api/home-assistant/display/${grant.id}/image/${config.read.id}`,{headers:{Authorization:"Bearer "+grant.token}})).status,401);

    // Exercise the actual administrator settings and server actions as well.
    const admin=await browser.newPage();await admin.goto(origin+"/login");
    await admin.getByLabel("Password",{exact:true}).fill(password);
    await admin.getByRole("button",{name:"Sign in",exact:true}).click();
    await admin.waitForURL(url=>url.pathname!=="/login");
    await admin.goto(origin+"/settings/home-assistant");
    await admin.getByLabel("Home Assistant origin",{exact:true}).fill(parentOrigin);
    await admin.getByLabel("Display name",{exact:true}).fill("Created through settings");
    await admin.getByRole("button",{name:"Create read-only display link",exact:true}).click();
    const link=admin.getByLabel("Copy this link into a Home Assistant webpage card",{exact:true});
    await link.waitFor();assert.ok((await link.inputValue()).includes("#token="));
    const active=await config.pool.query("SELECT id FROM public.home_assistant_display_grants WHERE label='Created through settings' AND revoked_at IS NULL");
    assert.equal(active.rows.length,1);
    const row=admin.locator("div.rounded-md.border.p-4").filter({hasText:"Created through settings"}).last();
    await row.getByRole("button",{name:"Revoke",exact:true}).click();
    await row.getByText("Revoked",{exact:true}).waitFor();
    assert.ok((await config.pool.query("SELECT revoked_at FROM public.home_assistant_display_grants WHERE id=$1",[active.rows[0].id])).rows[0].revoked_at);
    await admin.goto(origin+"/settings/blue-iris");
    await admin.getByRole("button",{name:"Test connection",exact:true}).click();
    await admin.getByText(/Found 1 cameras/).waitFor();
    const inventory=await config.pool.query("SELECT display_name FROM public.blue_iris_camera_inventory WHERE short_name='eastlpr' AND present");
    assert.equal(inventory.rows[0].display_name,"East LPR");
    // datetime-local deliberately uses the browser's local timezone, like the product.
    const localTime=await admin.evaluate(timestamp=>{const date=new Date(timestamp);const pad=value=>String(value).padStart(2,'0');return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+'T'+pad(date.getHours())+':'+pad(date.getMinutes())+':'+pad(date.getSeconds());},config.read.timestamp.toISOString());
    await admin.getByLabel("Plate-read local time",{exact:true}).fill(localTime);
    await admin.getByRole("button",{name:"Find matching alert",exact:true}).click();
    const owner=admin.getByLabel("ALPR read that will own this image",{exact:true});await owner.waitFor();
    assert.equal(await owner.inputValue(),"","ambiguous reads are not selected automatically");
    await owner.selectOption(String(config.read.id));
    await admin.getByRole("button",{name:"Select best vehicle frame",exact:true}).click();
    let selectedStatus;
    for(let i=0;i<120;i++){
      selectedStatus=(await config.pool.query("SELECT vehicle_image_status FROM public.plate_reads WHERE id=$1",[config.read.id])).rows[0].vehicle_image_status;
      if(["failed","unavailable"].includes(selectedStatus))break;
      await delay(250);
    }
    assert.ok(["failed","unavailable"].includes(selectedStatus),"the explicit read owns the recording request, even though the synthetic server has no video");
    assert.equal(await admin.getByText("No ALPR read from this camera matched the selected time closely enough to own the vehicle image.",{exact:true}).count(),0);
    await admin.goto(origin+"/settings/vehicle-intelligence");
    await admin.getByRole("combobox").first().click();await admin.getByRole("option",{name:"eastlpr",exact:true}).click();
    const save=admin.getByRole("button",{name:"Save image source for Westbound",exact:true});await save.waitFor();
    await save.click();await admin.getByText("Saved for Westbound. New eligible plate reads will use this source.",{exact:true}).waitFor();
    const mapping=await config.pool.query("SELECT source_camera_name,source_camera_short_name FROM public.vehicle_overview_pair_profiles WHERE plate_camera_name='eastlpr' AND direction_label='Westbound' AND source_mode='lpr_camera'");
    assert.deepEqual(mapping.rows,[{source_camera_name:"East LPR",source_camera_short_name:"eastlpr"}]);
    console.log("Production browser: iframe policy, read-only scope, revocation, administrator display UI, Blue Iris connection/inventory, explicit read selection and LPR source save passed");
  } catch(error) {
    await writeFile(path.join(home,"server.log"),logs.join(""));
    console.error("Browser fixture diagnostic directory: "+home);
    throw error;
  } finally {
    await browser?.close();
    if(child?.exitCode===null){child.kill();await Promise.race([once(child,"exit"),delay(5000)]);}
    await Promise.all([new Promise(resolve=>parent.close(resolve)),new Promise(resolve=>blockedParent.close(resolve)),new Promise(resolve=>blueIris.close(resolve))]);
    // Keep screenshots and logs for local QA. The directory contains synthetic data only.
  }
}
