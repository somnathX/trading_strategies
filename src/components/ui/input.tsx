import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const inputClass = "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-neg aria-invalid:ring-neg/20 dark:bg-input/30";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cn(inputClass, className)} {...props} />;
}

/** Native select styled like the inputs (native keeps keyboard + mobile pickers for free). */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select data-slot="select"
      className={cn(inputClass, "cursor-pointer appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat pr-8 dark:bg-input/30",
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]", className)}
      {...props} />
  );
}
