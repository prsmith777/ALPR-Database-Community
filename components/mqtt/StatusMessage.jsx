import { Alert, AlertDescription } from "@/components/ui/alert";

export function StatusMessage({ status }) {
  if (!status?.message) return null;

  const className =
    status.type === "error"
      ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
      : status.type === "success"
        ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
        : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";

  return (
    <Alert className={className}>
      <AlertDescription>{status.message}</AlertDescription>
    </Alert>
  );
}
