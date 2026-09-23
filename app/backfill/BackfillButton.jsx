"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function BackfillButton({ dbBackfill }) {
  const [response, setResponse] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  return (
    <>
      <Button
        className="mt-4"
        onClick={async () => {
          setIsLoading(true);
          try {
            const result = await dbBackfill();
            setResponse(
              result.success
                ? "Backfill completed successfully"
                : "Backfill failed"
            );
          } catch (error) {
            setResponse("Error occurred during backfill");
          } finally {
            setIsLoading(false);
          }
        }}
        disabled={isLoading}
      >
        {isLoading ? "Processing..." : "Backfill"}
      </Button>
      {response && <p className="mt-4">{response}</p>}
    </>
  );
}
