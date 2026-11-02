"use client";

import { useEffect, useState } from "react";
import { createHomeAssistantDisplay, getHomeAssistantDisplays, revokeHomeAssistantDisplay } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function HomeAssistantAccessSettings() {
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [label, setLabel] = useState("Home Assistant display"), [origin, setOrigin] = useState("");
  const [camera, setCamera] = useState(""), [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false), [link, setLink] = useState("");
  async function reload() {
    const result = await getHomeAssistantDisplays();
    if (!result.success) throw new Error(result.error);
    setData(result);
  }
  useEffect(() => { reload().catch(() => setError("Unable to load display access.")); }, []);
  async function create() {
    setBusy(true); setError(""); setLink("");
    try {
      const result = await createHomeAssistantDisplay({ label, allowedOrigin: origin, cameraName: camera, days: Number(days) });
      if (!result.success) throw new Error(result.error);
      setLink(`${window.location.origin}/embed/home-assistant/${result.data.id}#token=${result.data.token}`);
      await reload();
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  async function revoke(id) {
    setBusy(true); setError("");
    try {
      const result = await revokeHomeAssistantDisplay(id);
      if (!result.success) throw new Error(result.error);
      if (link.includes(id)) setLink("");
      await reload();
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return <section className="space-y-5 max-w-3xl">
    <div><h2 className="text-2xl font-semibold">Home Assistant read-only displays</h2>
      <p className="text-sm text-muted-foreground mt-2">Create a revocable link for a Home Assistant webpage card. Displays show up to 25 reads and their images from the last 24 hours. They cannot edit records, open settings or control ALPR.</p></div>
    <p className="text-sm text-muted-foreground">The old IP login-bypass whitelist is retired. Each display uses its own credential. Keep the link private. Use HTTPS for ALPR when Home Assistant uses HTTPS.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2"><Label htmlFor="ha-display-name">Display name</Label><Input id="ha-display-name" maxLength={80} value={label} onChange={e => setLabel(e.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="ha-display-origin">Home Assistant origin</Label><Input id="ha-display-origin" placeholder="https://home.example.com:8123" value={origin} onChange={e => setOrigin(e.target.value)} /><p className="text-xs text-muted-foreground">Include the scheme and port. Leave out dashboard paths.</p></div>
      <div className="space-y-2"><Label htmlFor="ha-display-camera">Visible camera</Label><select id="ha-display-camera" className="h-10 w-full rounded-md border bg-background px-3" value={camera} onChange={e => setCamera(e.target.value)}><option value="">All cameras</option>{data?.cameras.map(name => <option key={name}>{name}</option>)}</select></div>
      <div className="space-y-2"><Label htmlFor="ha-display-days">Expires after (days)</Label><Input id="ha-display-days" type="number" min="1" max="90" value={days} onChange={e => setDays(e.target.value)} /></div>
    </div>
    <Button type="button" disabled={busy || !data || !origin || !label} onClick={create}>Create read-only display link</Button>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {link && <div className="space-y-2 rounded-md border p-4"><Label htmlFor="ha-display-link">Copy this link into a Home Assistant webpage card</Label><Input id="ha-display-link" readOnly value={link} onFocus={e => e.target.select()} /><p className="text-xs text-muted-foreground">The credential is shown once. Revoke this display and create another if the link is lost or shared.</p></div>}
    {!data ? <p>Loading displays…</p> : <div className="space-y-3">{data.grants.length === 0 && <p className="text-sm text-muted-foreground">No display access has been created.</p>}{data.grants.map(grant => <div key={grant.id} className="flex items-center justify-between gap-3 rounded-md border p-4"><div><p className="font-medium">{grant.label}</p><p className="text-sm text-muted-foreground break-all">{grant.allowed_origin} · {grant.camera_name || "All cameras"}</p><p className="text-xs text-muted-foreground">{grant.revoked_at ? "Revoked" : `Expires ${new Date(grant.expires_at).toLocaleString()}`}</p></div><Button type="button" variant="outline" disabled={busy || Boolean(grant.revoked_at)} onClick={() => revoke(grant.id)}>Revoke</Button></div>)}</div>}
  </section>;
}
