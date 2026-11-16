import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Segmented control: one connected row, the chosen item raised. */
export function ToggleGroup({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return <ToggleGroupPrimitive.Root data-slot="toggle-group" className={cn("inline-flex w-fit items-center gap-0.5 rounded-lg bg-muted p-[3px]", className)} {...props} />;
}
export function ToggleGroupItem({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item data-slot="toggle-group-item"
      className={cn("inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-[color,box-shadow,background-color] outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-input/50", className)}
      {...props} />
  );
}
