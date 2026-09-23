import React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef(
  ({ className, type, icon = null, ...props }, ref) => {
    return (
      <div className="relative w-full">
        {icon && (
          <span className="absolute inset-y-0 left-2 flex items-center text-zinc-500">
            {icon}
          </span>
        )}
        <input
          type={type}
          className={cn(
            "flex h-9 w-full rounded-md border border-zinc-200 bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-zinc-950 placeholder:text-zinc-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:border-zinc-800 dark:file:text-zinc-50 dark:placeholder:text-zinc-400 dark:focus-visible:ring-zinc-300",
            icon ? "pl-8" : "", // Adds padding if icon exists
            className
          )}
          ref={ref}
          {...props}
        />
      </div>
    );
  }
);

Input.displayName = "Input";

export { Input };
