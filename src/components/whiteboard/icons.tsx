// Line icons for the radial tool menu. They draw in `currentColor`, so they follow the text color.

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

export function PenIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M4 20l1.2-4.4L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.4 18.8 4 20z" />
      <path d="M14 7l3 3" />
    </Icon>
  );
}

export function EraserIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M8.5 19.5L3.9 14.9a1.8 1.8 0 0 1 0-2.6l8.4-8.4a1.8 1.8 0 0 1 2.6 0l4.6 4.6a1.8 1.8 0 0 1 0 2.6l-8.4 8.4" />
      <path d="M8.5 19.5H20" />
      <path d="M8 8.2l7.8 7.8" />
    </Icon>
  );
}

export function TextIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M5 7V5h14v2" />
      <path d="M12 5v14" />
      <path d="M9 19h6" />
    </Icon>
  );
}

export function MoveIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M12 3v18M3 12h18" />
      <path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
    </Icon>
  );
}

export function UndoIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Icon>
  );
}

/** A whiteboard on a stand, for the board actions. */
export function BoardIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M12 16v4M8 20h8" />
    </Icon>
  );
}

export function TrashIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V4h6v3" />
    </Icon>
  );
}

/** Corners of a frame around a dot: back to the starting view. */
export function ResetViewIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
      <circle cx="12" cy="12" r="2.5" />
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

export function PlusIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M12 6v12M6 12h12" />
    </Icon>
  );
}
