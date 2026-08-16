"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, CircleHelp, Loader2, XCircle } from "lucide-react";

import { submitVehicleReidV2PairReview } from "@/app/actions";
import { Button } from "@/components/ui/button";

const OPTIONS = Object.freeze([
  { label: "same_vehicle", text: "Same vehicle", Icon: CheckCircle2 },
  { label: "different_vehicle", text: "Different vehicle", Icon: XCircle },
  { label: "unsure", text: "Unsure", Icon: CircleHelp },
]);

function reviewText(review) {
  if (!review) return "No human review recorded for this crop pair.";
  const labels = {
    same_vehicle: "Same vehicle",
    different_vehicle: "Different vehicle",
    unsure: "Unsure",
  };
  if (review.automatic) {
    const basis = review.reviewBasis === "exact_effective_plate"
      ? "exact effective/corrected plate match"
      : "effective plates are outside the conservative fuzzy-match tolerance";
    return `${labels[review.label] || review.label} · automatically reviewed from ${basis}`;
  }
  const reviewer = review.reviewer?.displayName || review.reviewer?.username;
  return `${labels[review.label] || review.label}${reviewer ? ` · ${reviewer}` : ""} · revision ${review.revision}`;
}

export default function VehicleReidV2PairReviewControls({
  sourceDerivativeId,
  candidateDerivativeId,
  initialReview = null,
  canReview = false,
  nextHref = null,
  campaignId = null,
}) {
  const router = useRouter();
  const [review, setReview] = useState(initialReview);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState("");

  const save = async (label) => {
    setSaving(label);
    setError("");
    try {
      const result = await submitVehicleReidV2PairReview({
        sourceDerivativeId,
        candidateDerivativeId,
        label,
        campaignId,
      });
      if (!result?.success) {
        setError(result?.error || "Unable to save this pair review.");
        return;
      }
      setReview(result.data.review);
      if (nextHref) {
        router.push(nextHref);
        router.refresh();
      } else {
        router.refresh();
      }
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {review?.automatic ? "Automatic plate review" : "Human pair review — calibration only"}
      </p>
      {!review?.automatic ? <div className="flex flex-wrap gap-2">
        {OPTIONS.map(({ label, text, Icon }) => (
          <Button
            key={label}
            type="button"
            size="sm"
            variant={review?.label === label ? "default" : "outline"}
            aria-pressed={review?.label === label}
            disabled={!canReview || Boolean(saving)}
            onClick={() => save(label)}
          >
            {saving === label
              ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              : <Icon className="mr-1 h-4 w-4" />}
            {text}
          </Button>
        ))}
      </div> : null}
      <p className="text-xs text-muted-foreground">
        {canReview ? reviewText(review) : "Plate review permission is required to label this pair."}
      </p>
      {canReview && nextHref && !review?.automatic ? (
        <p className="text-xs text-muted-foreground">
          Saving any label advances to the next current targeted recommendation.
        </p>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
