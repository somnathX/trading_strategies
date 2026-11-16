import { Dialog as SheetPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Sheet = SheetPrimitive.Root;
export const SheetTitle = SheetPrimitive.Title;
export function SheetContent({ className, side = "left", ...props }: ComponentProps<typeof SheetPrimitive.Content> & { side?: "left" | "right" }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <SheetPrimitive.Content
        className={cn("fixed inset-y-0 z-50 flex h-full w-[min(380px,92vw)] flex-col bg-sidebar shadow-xl transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=open]:duration-300",
          side === "left" ? "left-0 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left" : "right-0 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right", className)}
        {...props} />
    </SheetPrimitive.Portal>
  );
}
