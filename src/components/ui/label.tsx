import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label data-slot="label" className={cn("flex select-none items-center gap-1.5 text-[13px] font-medium leading-none text-foreground/90", className)} {...props} />;
}
