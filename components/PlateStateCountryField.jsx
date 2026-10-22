"use client";

import { useEffect, useId, useState } from "react";
import { Pencil } from "lucide-react";
import { useAccess } from "@/components/auth/AccessProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getPlateStateCountries, updatePlateStateCountry } from "@/app/actions";

export default function PlateStateCountryField({ plateNumber, value, onSaved }) {
  const { can } = useAccess();
  const inputId = useId();
  const optionsId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [savedValue, setSavedValue] = useState(value || "");
  const [options, setOptions] = useState([]);
  const [error, setError] = useState("");
  const [optionsError, setOptionsError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setSavedValue(value || ""), [plateNumber, value]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setOptionsError("");
    getPlateStateCountries().then((result) => {
      if (!active) return;
      setOptions(result.data || []);
      if (!result.success) setOptionsError(result.error);
    }).catch(() => {
      if (active) setOptionsError("Unable to load previous entries. You can still enter a value.");
    });
    return () => { active = false; };
  }, [open]);

  if (!can("plate.review")) return <span className="whitespace-pre-wrap break-words">{savedValue || "—"}</span>;

  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await updatePlateStateCountry(plateNumber, draft);
      if (!result.success) { setError(result.error); return; }
      setSavedValue(result.data.state_country || "");
      onSaved?.(result.data);
      setOpen(false);
    } catch {
      setError("Unable to save State/Country. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return <>
    <Button type="button" variant="ghost" size="sm" className="h-auto max-w-48 justify-start gap-2 whitespace-normal px-1 py-1 text-left font-normal" aria-label={"Edit State/Country for " + plateNumber} onClick={() => { setDraft(savedValue); setError(""); setOpen(true); }}>
      <span className="min-w-0 break-words">{savedValue || "Add State/Country"}</span><Pencil className="h-3 w-3 shrink-0" />
    </Button>
    <Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>State/Country for {plateNumber}</DialogTitle>
          <DialogDescription>Enter a value or choose a previous entry. This applies to all reads of this plate. Leave it blank to clear it.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={inputId}>State/Country</Label>
            <Input id={inputId} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={100} placeholder="e.g. Colorado, USA" autoComplete="off" disabled={saving} />
            {options.length > 0 && <div className="space-y-2 pt-2">
              <Label htmlFor={optionsId}>Previous entries</Label>
              <Select value={options.includes(draft) ? draft : ""} onValueChange={setDraft} disabled={saving}>
                <SelectTrigger id={optionsId}><SelectValue placeholder="Choose a previous entry" /></SelectTrigger>
                <SelectContent>{options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
              </Select>
            </div>}
            {optionsError && <p className="text-xs text-muted-foreground" role="status">{optionsError}</p>}
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
