import type { SVGProps } from "react";
import {
  BookmarkPlus, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Info, Moon, Redo2, SlidersHorizontal, Sparkles, Sun,
  TriangleAlert, Undo2, X, type LucideIcon, type LucideProps,
} from "lucide-react";

/** Lucide icons at one size and stroke across the app. Decorative by default (buttons carry the label). */
const make = (I: LucideIcon, base: LucideProps = {}) => (p: LucideProps) => <I size={16} strokeWidth={1.85} aria-hidden="true" focusable="false" {...base} {...p} />;

export const LogoIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false" {...p}>
    <rect width="28" height="28" rx="7" fill="var(--muted)" />
    <path d="M8 7v14M14 5v16M20 9v12" stroke="var(--muted-foreground)" strokeWidth="1.5" strokeLinecap="round" />
    <rect x="6" y="11" width="4" height="7" rx="1" fill="var(--pos)" />
    <rect x="12" y="8" width="4" height="8" rx="1" fill="var(--neg)" />
    <rect x="18" y="12" width="4" height="6" rx="1" fill="var(--pos)" />
  </svg>
);

export const SunIcon = make(Sun);
export const MoonIcon = make(Moon);
export const SlidersIcon = make(SlidersHorizontal);
export const BookmarkIcon = make(BookmarkPlus);
export const AlertIcon = make(TriangleAlert);
export const ChevronIcon = make(ChevronDown, { className: "chevron" });
export const InfoIcon = make(Info, { size: 14 });
export const UndoIcon = make(Undo2);
export const RedoIcon = make(Redo2);
export const HelpIcon = make(CircleHelp);
export const CloseIcon = make(X);
export const SparkIcon = make(Sparkles);
export const ArrowIcon = ({ dir }: { dir: "left" | "right" }) => (dir === "left" ? <Left /> : <Right />);
const Left = make(ChevronLeft), Right = make(ChevronRight);
