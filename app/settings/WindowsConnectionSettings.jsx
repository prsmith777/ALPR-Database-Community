"use client";

import {useEffect,useState,useTransition} from "react";
import {requestWindowsApplicationPort} from "@/app/actions";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from "@/components/ui/card";

export default function WindowsConnectionSettings({initialPort,initialSnapshot}) {
 const [port,setPort]=useState(String(initialPort));
 const [snapshot,setSnapshot]=useState(initialSnapshot);
 const [message,setMessage]=useState("");
 const [address,setAddress]=useState(null);
 const [requestId,setRequestId]=useState(null);
 const [pending,startTransition]=useTransition();
 const ready=snapshot?.agent.online&&snapshot.agent.applicationPort;
 useEffect(()=>{
  const timer=window.setInterval(async()=>{
   try{
    const response=await fetch("/api/software-updates/status",{cache:"no-store",credentials:"same-origin"});
    if(!response.ok)return;const result=await response.json();if(!result.success)return;
    setSnapshot(result.snapshot);
    const state=result.snapshot.state;
    if(requestId&&state?.requestId===requestId){
     setMessage(state.message);
     if(state.phase==="failed"){setAddress(null);setRequestId(null);}
    }
   }catch{/* A port change disconnects the old address. Keep the reconnect link. */}
  },2000);
  return()=>window.clearInterval(timer);
 },[requestId]);
 function apply(){
  setMessage("");
  startTransition(async()=>{
   try{
    const result=await requestWindowsApplicationPort(Number(port));
    if(!result.success){setMessage(result.error);return;}
    const next=new URL(window.location.href);next.port=port;
    setAddress(next.toString());setRequestId(result.request.requestId);
    setMessage("ALPR is checking the port and will briefly restart. Open the new address when ready.");
   }catch{setMessage("Unable to request the port change. Refresh this page and try again.");}
  });
 }
 const valid=/^\d{4,5}$/.test(port)&&Number(port)>=1024&&Number(port)<=65535;
 return <Card className="mt-8 max-w-2xl">
  <CardHeader><CardTitle>Windows connection port</CardTitle><CardDescription>Change the port used by your browser and Blue Iris. ALPR checks that the port is free, preserves local network access, and restarts. If verification fails, it restores the previous port.</CardDescription></CardHeader>
  <CardContent className="space-y-4">
   <label className="block space-y-2 text-sm font-medium" htmlFor="windows-application-port"><span>Application port</span><Input id="windows-application-port" inputMode="numeric" type="number" min="1024" max="65535" value={port} onChange={event=>setPort(event.target.value)} disabled={pending||Boolean(requestId)} /></label>
   <p className="text-sm text-muted-foreground">Currently {initialPort}. If another ALPR installation uses 3000, choose an unused port such as 3001. After changing it, update the port in every Blue Iris destination URL. Your API key stays the same.</p>
   <Button type="button" onClick={apply} disabled={!ready||snapshot.busy||pending||Boolean(requestId)||!valid||Number(port)===initialPort}>Change port and restart</Button>
   {!ready?<p className="text-sm text-muted-foreground">{snapshot?.agent.online?"Restart Windows once to activate this setting after updating from an older release.":"The Windows updater service must be running to change the port."}</p>:null}
   {message?<p role="status" className="text-sm">{message}</p>:null}
   {address?<div className="space-y-2 rounded-md border p-3 text-sm"><a href={address} className="font-medium text-primary underline">Open ALPR at the new address</a><p>If the new address is not ready, wait a moment and try again. If the change fails, ALPR restores this original address.</p></div>:null}
  </CardContent>
 </Card>;
}
