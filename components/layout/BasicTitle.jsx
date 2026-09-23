import { Radio } from "lucide-react";

export default function BasicTitle({
  title,
  recording,
  subtitle = null,
  children,
}) {
  return (
    <div className="flex min-h-screen flex-col px-4 sm:p-6">
      <header className="hidden sm:block border-b backdrop-blur pb-4">
        <div className="container flex h-14 items-center">
          <div className="flex items-center space-x-2">
            <h1 className="text-2xl font-semibold">
              <span className="flex items-center gap-2">
                {title}
                {recording && <Radio className="text-[#f31261d1]" />}
              </span>
            </h1>
          </div>
        </div>
        {subtitle && (
          <h2 className=" font-medium text-muted-foreground">{subtitle}</h2>
        )}
      </header>
      <div className="flex-1">
        <div className="sm:py-6">{children}</div>
      </div>
    </div>
  );
}
