import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function statusVariant(value) {
  return value === "matched" || value === "succeeded" ? "default" : "secondary";
}

export function NotificationOperationsPanel({ overview }) {
  const history = overview?.history || [];
  return <div className="space-y-4">
    <Card>
      <CardHeader>
        <CardTitle>Notification operations</CardTitle>
        <CardDescription>Recent rule decisions, quiet-hour suppression, delivery retries, and dead-letter outcomes.</CardDescription>
      </CardHeader>
      <CardContent>
        {history.length === 0 ? <p className="text-sm text-muted-foreground">No unified-rule evaluations have been recorded yet.</p> : <div className="max-h-[36rem] space-y-2 overflow-y-auto pr-1">{history.map((item) => <details key={item.id} className="rounded-lg border p-3 text-sm">
          <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
            <span><span className="font-medium">{item.ruleName}</span> · {item.eventType === "camera.activity_check" ? "Camera check" : `Read ${item.readId || ""}`}</span>
            <span className="flex items-center gap-2"><Badge variant={statusVariant(item.outcome)}>{item.outcome}</Badge><span className="text-xs text-muted-foreground">{new Date(item.evaluatedAt).toLocaleString()}</span></span>
          </summary>
          <div className="mt-3 space-y-3">
            <p><span className="text-muted-foreground">Reason:</span> {item.reason}</p>
            {item.deliveries.length > 0 && <div className="space-y-2">{item.deliveries.map((delivery) => <div key={delivery.id} className="rounded border p-2">
              <div className="flex flex-wrap items-center justify-between gap-2"><span>{String(delivery.channelType).toUpperCase()} delivery #{delivery.id}</span><Badge variant={statusVariant(delivery.status)}>{delivery.status}</Badge></div>
              <p className="mt-1 text-xs text-muted-foreground">Attempts {delivery.attemptCount}/{delivery.maxAttempts}{delivery.lastError ? ` · ${delivery.lastError}` : ""}</p>
              {(delivery.attempts || []).map((attempt) => <p key={attempt.number} className="mt-1 text-xs">Attempt {attempt.number}: {attempt.outcome}{attempt.error ? ` — ${attempt.error}` : ""}</p>)}
            </div>)}</div>}
            <details><summary className="cursor-pointer text-xs text-muted-foreground">Condition trace</summary><pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{JSON.stringify(item.decision, null, 2)}</pre></details>
          </div>
        </details>)}</div>}
      </CardContent>
    </Card>
  </div>;
}
