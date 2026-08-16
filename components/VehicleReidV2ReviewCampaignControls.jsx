"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Play } from "lucide-react";

import { startVehicleReidV2ReviewCampaign } from "@/app/actions";
import { Button } from "@/components/ui/button";

export default function VehicleReidV2ReviewCampaignControls({ canReview = false }) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const start = async () => {
    setStarting(true);
    setError("");
    try {
      const result = await startVehicleReidV2ReviewCampaign();
      if (!result?.success) {
        setError(result?.error || "Unable to start the review campaign.");
        return;
      }
      router.push("/visual_search/reid-v2?campaign=1");
      router.refresh();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button type="button" size="sm" disabled={!canReview || starting} onClick={start}>
        {starting
          ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          : <Play className="mr-1 h-4 w-4" />}
        Start one 500-pair-decision campaign
      </Button>
      {!canReview ? (
        <p className="text-xs text-muted-foreground">Plate review permission is required.</p>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
