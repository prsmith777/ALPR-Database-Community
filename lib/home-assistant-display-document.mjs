export function displayDocument(nonce) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALPR read-only display</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;padding:20px;background:#10151d;color:#e8edf5;font:15px system-ui,sans-serif}header{display:flex;justify-content:space-between;align-items:center;gap:16px}h1{font-size:22px;margin:0}small,#status{color:#a7b7ce}#status{padding:12px 0}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:14px}article{background:#1b2533;border:1px solid #304158;border-radius:10px;padding:14px}h2{font-size:25px;margin:0 0 8px;overflow-wrap:anywhere}p{margin:6px 0}img{width:100%;height:155px;object-fit:contain;background:#0e1218;border-radius:5px;margin-top:10px}button{font:inherit;padding:7px 12px;color:inherit;background:#25364c;border:1px solid #536b8b;border-radius:6px;cursor:pointer}
</style><header><div><h1 id="title">ALPR</h1><small>Read-only · recent reads from the last 24 hours</small></div><button id="refresh">Refresh</button></header><p id="status" role="status">Connecting…</p><main id="reads"></main>
<script nonce="${nonce}">
const id=location.pathname.split('/').filter(Boolean).at(-1);
const key='alpr-display:'+id;
let token=new URLSearchParams(location.hash.slice(1)).get('token');
try{if(token)sessionStorage.setItem(key,token);else token=sessionStorage.getItem(key)}catch{}
history.replaceState(null,'',location.pathname);
const status=document.getElementById('status'), cards=document.getElementById('reads');
let busy=false, objects=[];
function clear(){for(const url of objects)URL.revokeObjectURL(url);objects=[];cards.replaceChildren()}
async function refresh(){
 if(busy)return;busy=true;
 try{
  if(!token)throw new Error('Open the display link created by your ALPR administrator.');
  const base='/api/home-assistant/display/'+id;
  const options={headers:{Authorization:'Bearer '+token},cache:'no-store',credentials:'omit'};
  const response=await fetch(base,options);
  if(response.status===401){token=null;try{sessionStorage.removeItem(key)}catch{};throw new Error('Display access expired or was revoked. Ask your administrator for a new link.')}
  if(!response.ok)throw new Error('Display temporarily unavailable.');
  const data=await response.json();clear();document.getElementById('title').textContent=data.label;
  status.textContent=data.reads.length?'Updated '+new Date().toLocaleTimeString():'No reads in the last 24 hours.';
  for(const read of data.reads){
   const card=document.createElement('article'), plate=document.createElement('h2');plate.textContent=read.plate_number;card.append(plate);
   for(const text of [read.camera_name, new Date(read.timestamp).toLocaleString(), read.direction]){if(!text)continue;const p=document.createElement('p');p.textContent=text;card.append(p)}
   cards.append(card);
   if(read.has_image){const picture=await fetch(base+'/image/'+read.id,options);if(picture.ok){const img=document.createElement('img');img.alt='Vehicle or plate image';const url=URL.createObjectURL(await picture.blob());objects.push(url);img.src=url;card.append(img)}}
  }
 }catch(error){clear();status.textContent=error.message||'Display temporarily unavailable.'}finally{busy=false}
}
document.getElementById('refresh').addEventListener('click',refresh);
setInterval(()=>{if(!document.hidden&&token)refresh()},15000);refresh();
</script></html>`;
}
