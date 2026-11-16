import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const TooltipProvider = ({ delayDuration = 150, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) =>
  <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export function TooltipContent({ className, sideOffset = 6, children, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content sideOffset={sideOffset}
        className={cn("z-50 max-w-72 rounded-md bg-foreground px-3 py-1.5 text-xs leading-relaxed text-background text-balance animate-in fade-in-0 zoom-in-95", className)}
        {...props}>
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
