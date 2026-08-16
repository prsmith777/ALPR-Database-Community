"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Layers3, Loader2 } from "lucide-react";

import { createVehicleReidV2ProfileCandidateSnapshot } from "@/app/actions";
import { Button } from "@/components/ui/button";

export default function VehicleReidV2ProfileCandidateControls({
  canReview = false,
  hasSnapshot = false,
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setCreating(true);
    setError("");
    try {
      const result = await createVehicleReidV2ProfileCandidateSnapshot();
      if (!result?.success) {
        setError(result?.error || "Unable to create the shadow profile snapshot.");
        return;
      }
      router.refresh();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button type="button" size="sm" disabled={!canReview || creating} onClick={create}>
        {creating
          ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          : <Layers3 className="mr-1 h-4 w-4" />}
        {hasSnapshot ? "Create updated shadow snapshot" : "Create shadow profile snapshot"}
      </Button>
      {!canReview ? (
        <p className="text-xs text-muted-foreground">Plate review permission is required.</p>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
