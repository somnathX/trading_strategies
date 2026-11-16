import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Table({ className, wrapClassName, ...props }: ComponentProps<"table"> & { wrapClassName?: string }) {
  return (
    <div data-slot="table-container" className={cn("relative w-full overflow-x-auto", wrapClassName)}>
      <table className={cn("w-full caption-bottom border-collapse text-[13px]", className)} {...props} />
    </div>
  );
}
export const TableHeader = ({ className, ...props }: ComponentProps<"thead">) =>
  <thead className={cn("[&_tr]:border-b [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card", className)} {...props} />;
export const TableBody = ({ className, ...props }: ComponentProps<"tbody">) =>
  <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
export const TableRow = ({ className, ...props }: ComponentProps<"tr">) =>
  <tr className={cn("border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted", className)} {...props} />;
export const TableHead = ({ className, ...props }: ComponentProps<"th">) =>
  <th className={cn("h-10 whitespace-nowrap px-3 text-left align-middle text-xs font-medium text-muted-foreground", className)} {...props} />;
export const TableCell = ({ className, ...props }: ComponentProps<"td">) =>
  <td className={cn("whitespace-nowrap px-3 py-2.5 align-middle", className)} {...props} />;
