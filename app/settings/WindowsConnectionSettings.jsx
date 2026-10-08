"use client";

import {useEffect,useState,useTransition} from "react";
import {requestWindowsApplicationPort,requestWindowsDatabasePort} from "@/app/actions";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from "@/components/ui/card";

export default function WindowsConnectionSettings({initialPort,initialDatabasePort,initialSnapshot}) {
 const [port,setPort]=useState(String(initialPort));
 const [databasePort,setDatabasePort]=useState(String(initialDatabasePort));
 const [currentDatabasePort,setCurrentDatabasePort]=useState(initialDatabasePort);
 const [snapshot,setSnapshot]=useState(initialSnapshot);
 const [message,setMessage]=useState("");
 const [address,setAddress]=useState(null);
 const [request,setRequest]=useState(null);
 const [pending,startTransition]=useTransition();
 const appReady=snapshot?.agent.online&&snapshot.agent.applicationPort;
 const databaseReady=snapshot?.agent.online&&snapshot.agent.databasePort;
 useEffect(()=>{
  const timer=window.setInterval(async()=>{
   try{
    const response=await fetch("/api/software-updates/status",{cache:"no-store",credentials:"same-origin"});
    if(!response.ok)return;const result=await response.json();if(!result.success)return;
    setSnapshot(result.snapshot);
    const state=result.snapshot.state;
    if(request&&state?.requestId===request.id){
     setMessage(state.message);
     if(state.phase==="failed"){setAddress(null);setRequest(null);}
     if(state.phase==="succeeded"&&request.kind==="database"){
      if(state.currentDatabasePort){setCurrentDatabasePort(state.currentDatabasePort);setDatabasePort(String(state.currentDatabasePort));}
      setRequest(null);setAddress(null);
     }
    }
   }catch{/* Service restarts interrupt polling. Keep the reconnect link available. */}
  },2000);
  return()=>window.clearInterval(timer);
 },[request]);
 function apply(kind){
  setMessage("");
  startTransition(async()=>{
   try{
    const result=kind==="database"?await requestWindowsDatabasePort(Number(databasePort)):await requestWindowsApplicationPort(Number(port));
    if(!result.success){setMessage(result.error);return;}
    const next=new URL(window.location.href);if(kind==="application")next.port=port;
    setAddress(next.toString());setRequest({id:result.request.requestId,kind});
    setMessage(kind==="database"?"ALPR is checking the database port and will briefly restart. This page will reconnect automatically.":"ALPR is checking the application port and will briefly restart. Open the new address when ready.");
   }catch{setMessage("Unable to request the port change. Refresh this page and try again.");}
  });
 }
 const valid=value=>/^\d{4,5}$/.test(value)&&Number(value)>=1024&&Number(value)<=65535;
 const busy=snapshot?.busy||pending||Boolean(request);
 return <Card className="mt-8 max-w-2xl">
  <CardHeader><CardTitle>Windows connection ports</CardTitle><CardDescription>ALPR checks that the selected port is free and verifies the restarted services. If a change fails or is interrupted, it restores the previous port. Finish any pending software update first.</CardDescription></CardHeader>
  <CardContent className="space-y-6">
   <div className="space-y-3">
    <label className="block space-y-2 text-sm font-medium" htmlFor="windows-application-port"><span>Application port</span><Input id="windows-application-port" inputMode="numeric" type="number" min="1024" max="65535" value={port} onChange={event=>setPort(event.target.value)} disabled={busy} /></label>
    <p className="text-sm text-muted-foreground">Currently {initialPort}. Your browser and Blue Iris use this port. After changing it, update every Blue Iris destination URL. Your API key and local network access stay the same.</p>
    <Button type="button" onClick={()=>apply("application")} disabled={!appReady||busy||!valid(port)||Number(port)===initialPort||Number(port)===currentDatabasePort}>Change application port and restart</Button>
   </div>
   <div className="space-y-3 border-t pt-4">
    <label className="block space-y-2 text-sm font-medium" htmlFor="windows-database-port"><span>Local PostgreSQL port</span><Input id="windows-database-port" inputMode="numeric" type="number" min="1024" max="65535" value={databasePort} onChange={event=>setDatabasePort(event.target.value)} disabled={busy} /></label>
    <p className="text-sm text-muted-foreground">Currently {currentDatabasePort}. This private database listens only on this computer. Changing it briefly restarts PostgreSQL and ALPR. Your browser address, Blue Iris URLs, records, images and credentials stay the same.</p>
    <Button type="button" onClick={()=>apply("database")} disabled={!databaseReady||busy||!valid(databasePort)||Number(databasePort)===currentDatabasePort||Number(databasePort)===initialPort}>Change PostgreSQL port and restart</Button>
   </div>
   {!appReady||!databaseReady?<p className="text-sm text-muted-foreground">{snapshot?.agent.online?"Restart Windows once to activate the new port controls after updating from an older release.":"The Windows updater service must be running to change ports."}</p>:null}
   {message?<p role="status" className="text-sm">{message}</p>:null}
   {address?<div className="space-y-2 rounded-md border p-3 text-sm"><a href={address} className="font-medium text-primary underline">{request?.kind==="database"?"Reconnect to ALPR":"Open ALPR at the new address"}</a><p>Wait a moment if ALPR is still restarting. If the change fails, it restores the original connection.</p></div>:null}
  </CardContent>
 </Card>;
}
