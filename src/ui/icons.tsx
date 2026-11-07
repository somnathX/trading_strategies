import type { ReactNode, SVGProps } from "react";

/** Lucide-style 24px stroke icons, inlined so there's no icon dependency. Decorative by default. */
function Icon({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const LogoIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false" {...p}>
    <rect width="28" height="28" rx="7" fill="var(--accent-soft)" />
    <path d="M8 7v14M14 5v16M20 9v12" stroke="var(--text-3)" strokeWidth="1.5" strokeLinecap="round" />
    <rect x="6" y="11" width="4" height="7" rx="1" fill="var(--pos)" />
    <rect x="12" y="8" width="4" height="8" rx="1" fill="var(--neg)" />
    <rect x="18" y="12" width="4" height="6" rx="1" fill="var(--pos)" />
  </svg>
);

export const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Icon>
);

export const MoonIcon = () => (
  <Icon><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></Icon>
);

export const SlidersIcon = () => (
  <Icon><path d="M21 4h-7M10 4H3m18 8h-9M8 12H3m18 8h-5m-4 0H3M14 2v4M8 10v4m8 4v4" /></Icon>
);

export const BookmarkIcon = () => (
  <Icon><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" /></Icon>
);

export const AlertIcon = () => (
  <Icon><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4m0 4h.01" /></Icon>
);

export const ChevronIcon = () => (
  <Icon className="chevron"><path d="m6 9 6 6 6-6" /></Icon>
);

export const InfoIcon = () => (
  <Icon width="14" height="14"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4m0-4h.01" /></Icon>
);

export const UndoIcon = () => (
  <Icon><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Icon>
);

export const RedoIcon = () => (
  <Icon><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></Icon>
);

export const HelpIcon = () => (
  <Icon><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3m.08 4h.01" /></Icon>
);

export const CloseIcon = () => (
  <Icon><path d="M18 6 6 18M6 6l12 12" /></Icon>
);

export const ArrowIcon = ({ dir }: { dir: "left" | "right" }) => (
  <Icon><path d={dir === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} /></Icon>
);

export const SparkIcon = () => (
  <Icon><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1" /></Icon>
);
