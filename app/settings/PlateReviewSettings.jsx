"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { ArrowRight, Ban, RefreshCw, ShieldCheck } from "lucide-react";
import {
  createPlateAlias,
  disablePlateAlias,
  listPlateAliases,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function PlateReviewSettings() {
  const [aliases, setAliases] = useState([]);
  const [message, setMessage] = useState({ error: "", success: "" });
  const [isPending, startTransition] = useTransition();

  const loadAliases = useCallback(async () => {
    const result = await listPlateAliases();
    if (result.success) {
      setAliases(result.data);
    } else {
      setMessage({ error: result.error, success: "" });
    }
  }, []);

  useEffect(() => {
    loadAliases();
  }, [loadAliases]);

  const handleCreate = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setMessage({ error: "", success: "" });
    startTransition(async () => {
      const result = await createPlateAlias(formData);
      if (!result.success) {
        setMessage({ error: result.error, success: "" });
        return;
      }
      form.reset();
      setMessage({
        error: "",
        success: "Recurring misread alias created. Future exact reads will use the effective plate.",
      });
      await loadAliases();
    });
  };

  const handleDisable = (aliasId) => {
    const formData = new FormData();
    formData.append("aliasId", aliasId);
    formData.append("reason", "disabled_in_review_settings");
    setMessage({ error: "", success: "" });
    startTransition(async () => {
      const result = await disablePlateAlias(formData);
      if (!result.success) {
        setMessage({ error: result.error, success: "" });
        return;
      }
      setMessage({ error: "", success: "Alias disabled. Its audit history was retained." });
      await loadAliases();
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-2xl font-semibold">
          <ShieldCheck className="h-6 w-6 text-primary" />
          Review & Corrections
        </h2>
        <p className="mt-2 text-muted-foreground">
          Camera observations remain immutable. Aliases explicitly map recurring exact
          misreads to an effective plate used by known names, tags, rules, and notifications.
        </p>
      </div>

      {message.error && (
        <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {message.error}
        </div>
      )}
      {message.success && (
        <div className="rounded-md bg-green-500/10 p-3 text-sm text-green-500">
          {message.success}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-primary">Create recurring misread alias</CardTitle>
          <CardDescription>
            Exact matching is used. Camera scope is optional and takes priority over an
            all-camera alias.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="aliasSource">Camera reads</Label>
              <Input
                id="aliasSource"
                name="sourcePlate"
                className="font-mono uppercase"
                maxLength={10}
                required
                placeholder="ABC123"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aliasTarget">Resolve as</Label>
              <Input
                id="aliasTarget"
                name="targetPlate"
                className="font-mono uppercase"
                maxLength={10}
                required
                placeholder="ABC128"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aliasCamera">Camera scope (optional)</Label>
              <Input
                id="aliasCamera"
                name="cameraName"
                maxLength={30}
                placeholder="Leave blank for all cameras"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aliasReason">Reason</Label>
              <Input
                id="aliasReason"
                name="reason"
                maxLength={120}
                required
                defaultValue="reviewed_recurring_ocr_misread"
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={isPending}>
                {isPending ? "Saving…" : "Create reviewed alias"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-primary">Plate aliases</CardTitle>
            <CardDescription>
              Aliases are disabled, never deleted, so their history remains available.
            </CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={loadAliases}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {aliases.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
              No recurring plate aliases have been configured.
            </div>
          ) : (
            <div className="space-y-3">
              {aliases.map((alias) => (
                <div
                  key={alias.id}
                  className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2 font-mono text-lg">
                      <span>{alias.source_plate}</span>
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      <span>{alias.target_plate}</span>
                      <Badge variant={alias.enabled ? "default" : "secondary"}>
                        {alias.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {alias.camera_name ? `Camera: ${alias.camera_name}` : "All cameras"}
                      {" · "}
                      Used {alias.use_count} times
                      {" · "}
                      Created by {alias.created_by_display_name}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {alias.reason}
                    </div>
                  </div>
                  {alias.enabled && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => handleDisable(alias.id)}
                    >
                      <Ban className="mr-2 h-4 w-4" />
                      Disable
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
