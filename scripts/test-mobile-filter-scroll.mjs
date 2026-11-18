// Run with absolute ALPR_TEST_PLAYWRIGHT_MODULE and ALPR_TEST_ESBUILD_MODULE paths.
// Validated with playwright@1.65.1 and esbuild@0.28.2 (development tools only).
// Uses the real PlateTable, Sheet, MultiSelectFilter and application CSS, with
// synthetic data and a stubbed Next router/server actions. No database is used.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {once} from "node:events";
import http from "node:http";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";

const root = fileURLToPath(new URL("../",import.meta.url));
const require = createRequire(new URL("../package.json",import.meta.url));
for(const name of ["ALPR_TEST_PLAYWRIGHT_MODULE","ALPR_TEST_ESBUILD_MODULE"]) {
  assert.ok(process.env[name] && path.isAbsolute(process.env[name]),"Set "+name+" to an installed test module");
}
const {chromium,webkit} = await import(pathToFileURL(process.env.ALPR_TEST_PLAYWRIGHT_MODULE).href);
const esbuild = await import(pathToFileURL(process.env.ALPR_TEST_ESBUILD_MODULE).href);
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const artifacts = path.resolve(root,"output/mobile-filter-scroll");
await mkdir(artifacts,{recursive:true});
const actionSource = await readFile(path.join(root,"app/actions.js"),"utf8");
const actions = [...actionSource.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(match=>match[1]);
const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import PlateTable from '@/components/PlateTable';
import {AccessProvider} from '@/components/auth/AccessProvider';
import {TooltipProvider} from '@/components/ui/tooltip';
const tags=Array.from({length:40},(_,i)=>({name:'Test Tag '+String(i+1).padStart(2,'0'),color:'#008899'}));
const cameras=Array.from({length:30},(_,i)=>'Test Camera '+String(i+1).padStart(2,'0'));
function Fixture(){
 const [filters,setFilters]=useState({search:'',tags:[],cameraNames:[],reviewStatuses:[],directionLabels:[],matchMode:'balanced',dateRange:{from:null,to:null},hourRange:{}});
 function update(next){setFilters(previous=>({...previous,...next,
  ...('tag' in next?{tags:next.tag||[]}:{}),...('camera' in next?{cameraNames:next.camera||[]}:{})}));}
 return <AccessProvider><TooltipProvider><h1>Recognition Feed mobile scrolling test</h1>
  <PlateTable data={[]} loading={false} availableTags={tags} availableCameras={cameras}
   filters={filters} onUpdateFilters={update} pagination={{page:1,pageSize:25,total:0,totalPages:1}}
   onAddTag={()=>{}} onRemoveTag={()=>{}} onAddKnownPlate={()=>{}} onDeleteRecord={()=>{}} onValidate={()=>{}} />
  <output aria-label="Selected filters">{JSON.stringify(filters)}</output>
  <div style={{height:1400}}>Background scroll sentinel</div>
 </TooltipProvider></AccessProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const bundle = await esbuild.build({
  absWorkingDir:root,stdin:{contents:fixture,resolveDir:root,loader:"jsx"},
  bundle:true,write:false,format:"iife",platform:"browser",jsx:"automatic",
  define:{"process.env.NODE_ENV":'"development"'},
  loader:{".js":"jsx"},
  plugins:[{name:"isolated-next-environment",setup(build){
    build.onResolve({filter:/^next\/(image|link|navigation)$/},args=>({path:args.path,namespace:"fixture"}));
    build.onResolve({filter:/^@\/app\/actions$/},()=>({path:"actions",namespace:"fixture"}));
    build.onLoad({filter:/.*/,namespace:"fixture"},args=>({loader:"js",resolveDir:root,contents:
      args.path==="actions" ? actions.map(name=>`export async function ${name}(){throw Error('Server actions are disabled in this UI fixture');}`).join("\n") :
      args.path==="next/navigation" ? "export const useRouter=()=>({push(){},replace(){},refresh(){}}); export const usePathname=()=>'/live_feed'; export const useSearchParams=()=>new URLSearchParams();" :
      "import React from 'react'; export default function Component({children,priority,fill,unoptimized,loader,...props}){return React.createElement('"+(args.path==="next/link"?"a":"img")+"',props,children);}"
    }));
  }}],
});
const cssSource = (await readFile(path.join(root,"app/globals.css"),"utf8"))
  .replace("@import 'tailwindcss';","@import 'tailwindcss' source(none);\n@source '../components';");
const css = (await postcss([tailwind({base:root})]).process(cssSource,{from:path.join(root,"app/globals.css")})).css;
const server = http.createServer((request,response)=>{
  if(request.url==="/bundle.js") {response.setHeader("Content-Type","text/javascript");response.end(bundle.outputFiles[0].contents);}
  else if(request.url==="/app.css") {response.setHeader("Content-Type","text/css");response.end(css);}
  else if(request.url==="/api/current-access") {response.setHeader("Content-Type","application/json");response.end(JSON.stringify({currentUser:{username:"synthetic-fixture"},permissions:["plate.read"]}));}
  else {response.setHeader("Content-Type","text/html");response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');}
});
server.listen(0,"127.0.0.1");
await once(server,"listening");
const origin = "http://127.0.0.1:"+server.address().port;
const results = [];
const pause = ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function swipe(cdp,box) {
  const x=box.x+box.width/2, start=box.y+box.height-24, end=box.y+24;
  await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y:start}]});
  for(let i=1;i<=12;i++) {
    await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x,y:start+(end-start)*i/12}]});
    await pause(16);
  }
  await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
  await pause(150);
}
async function exercise(browserType,name,{mobile,touch}) {
  const chromiumOptions = process.env.ALPR_TEST_BROWSER
    ? {executablePath:process.env.ALPR_TEST_BROWSER}
    : process.platform==="win32" ? {channel:"msedge"} : {};
  const browser = await browserType.launch({headless:true,...(name.startsWith("chromium")?chromiumOptions:{})});
  // Windows WebKit cannot synthesize mobile wheel/swipe input. At phone width,
  // exercise real wheel scrolling and explicitly check touch-event cancellation.
  const context = await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1200,height:900},hasTouch:mobile,isMobile:mobile&&touch});
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  try {
    await page.goto(origin);
    await page.getByRole("button",{name:/^Search options/}).click();
    if(mobile) await page.getByRole("button",{name:"Open filters",exact:true}).click();
    const background = await page.evaluate(()=>window.scrollY);
    const cdp = touch ? await context.newCDPSession(page) : null;
    for(const [label,last] of [["Filter by tags","Test Tag 40"],["Filter by cameras","Test Camera 30"]]) {
      const trigger = page.getByRole("combobox",{name:label,exact:true}).filter({visible:true});
      await trigger.click();
      const option = page.getByRole("option",{name:last,exact:true});
      const list = option.locator("..");
      const box = await list.boundingBox(); assert.ok(box);
      assert.ok((await list.evaluate(el=>el.scrollHeight))>box.height,"Fixture must overflow the dropdown");
      if(mobile&&!touch) {
        const prevented = await list.evaluate(el=>{
          const target=el.querySelector('button'), box=target.getBoundingClientRect();
          function event(type,y){
            const value=new Event(type,{bubbles:true,cancelable:true});
            const points=[{identifier:1,target,clientX:box.x+20,clientY:y}];
            Object.defineProperty(value,'touches',{value:points});
            Object.defineProperty(value,'changedTouches',{value:points});
            target.dispatchEvent(value); return value;
          }
          event('touchstart',box.y+30);
          return event('touchmove',box.y+10).defaultPrevented;
        });
        assert.equal(prevented,false,'WebKit must allow touch movement inside the dropdown');
      }
      if(touch) {
        for(let i=0;i<9;i++) {
          await swipe(cdp,box);
          if(await list.evaluate(el=>el.scrollTop+el.clientHeight>=el.scrollHeight-1)) break;
        }
      } else {
        await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
        await page.mouse.wheel(0,2400); await pause(300);
      }
      const top = await list.evaluate(el=>el.scrollTop);
      await page.screenshot({path:path.join(artifacts,name+"-"+(label.endsWith("tags")?"tags":"cameras")+".png")});
      assert.ok(top>0,name+" "+label+": scroll was blocked (scrollTop="+top+")");
      const rect = await option.boundingBox();
      const currentBox = await list.boundingBox();
      assert.ok(rect && currentBox && rect.y>=currentBox.y-1 && rect.y+rect.height<=currentBox.y+currentBox.height+1,last+" must be reachable by scrolling");
      await option.click();
      assert.match(await page.getByLabel("Selected filters").textContent(),new RegExp(last));
      if(await page.getByRole("option",{name:last,exact:true}).isVisible()) await page.keyboard.press("Escape");
      await page.getByRole("option",{name:last,exact:true}).waitFor({state:"hidden"});
      if(mobile) assert.equal(await page.evaluate(()=>window.scrollY),background,"Background must remain locked while filtering");
    }
    if(mobile) {
      await page.getByRole("button",{name:"Close",exact:true}).click();
      await page.getByRole("dialog",{name:"Filter Results",exact:true}).waitFor({state:"hidden"});
      await page.getByRole("button",{name:"Open filters",exact:true}).waitFor({state:"visible"});
    }
    await page.mouse.move(10,10); await page.mouse.wheel(0,600); await pause(250);
    assert.ok(await page.evaluate(()=>window.scrollY>0),"Background must unlock after the filter panel closes");
    assert.deepEqual(errors,[]);
    results.push({browser:name,gesture:touch?"native touch swipe":mobile?"wheel and touch-event cancellation":"wheel",tags:40,cameras:30,lastOptionsSelected:true,backgroundLockPreserved:true,passed:true});
    console.log(JSON.stringify(results.at(-1)));
  } catch(error) {
    console.error(JSON.stringify({browser:name,pageErrors:errors,body:(await page.locator('body').innerText()).slice(0,1200)}));
    await page.screenshot({path:path.join(artifacts,name+'-failure.png')});
    throw error;
  } finally {await browser.close();}
}
try {
  await exercise(chromium,"chromium-mobile",{mobile:true,touch:true});
  await exercise(webkit,"webkit-mobile-layout",{mobile:true,touch:false});
  await exercise(chromium,"chromium-desktop",{mobile:false,touch:false});
  await writeFile(path.join(artifacts,"verification.json"),JSON.stringify({results,passed:true},null,2)+"\n");
} finally {await new Promise(resolve=>server.close(resolve));}
