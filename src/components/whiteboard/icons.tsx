// Line icons for the radial AI menu. They draw in `currentColor`, so they follow the text color.

import type { ReactNode } from "react";

function Icon({ size = 24, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** Sparkles, for the AI menu. */
export function SparklesIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M10 3.5l1.6 4.4 4.4 1.6-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6z" />
      <path d="M18 14l.8 2.2 2.2.8-2.2.8L18 20l-.8-2.2-2.2-.8 2.2-.8z" />
    </Icon>
  );
}

/** "x =", for Solve. */
export function SolveIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M3.5 8l6 7M9.5 8l-6 7" />
      <path d="M13.5 9.5h7M13.5 13.5h7" />
    </Icon>
  );
}

/** Axes with a curve, for Graph. */
export function GraphIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M4 4v16h16" />
      <path d="M7 16c2-7 4.5-9 6.5-6s3.5 1.5 5.5-4" />
    </Icon>
  );
}

/** A magnifier over a line of working, for Check (find the mistake). */
export function CheckWorkIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
      <path d="M8 10.5l2 2 3-3.5" />
    </Icon>
  );
}

export function MicIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
    </Icon>
  );
}

export function CloseIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}
