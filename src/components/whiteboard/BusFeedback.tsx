"use client";

import { useImperativeHandle, useRef, useState, type Ref } from "react";

/** Show the presenter what the camera service sees, so they know it is working. */
export interface BusFeedbackHandle {
  /** Where the finger is: a ring while it hovers, a filled dot while it touches the board. */
  pointer(x: number, y: number, touching: boolean): void;
  hidePointer(): void;
  /** The reset countdown, from 0 to 1. 0 (or 1) hides the ring. */
  ring(progress: number): void;
  /** A short note at the top, such as "Moving the board". Null hides it. */
  hint(text: string | null, holdMs?: number): void;
}

// The finger marker fades this long after the last position, so it never lingers.
const POINTER_FADE_MS = 600;
const RING_RADIUS = 30;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export function BusFeedback({ ref }: { ref?: Ref<BusFeedbackHandle> }) {
  const dotRef = useRef<HTMLDivElement>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [ring, setRing] = useState(0);
  const [hint, setHint] = useState<string | null>(null);

  useImperativeHandle(ref, () => {
    const hide = () => {
      if (dotRef.current) dotRef.current.style.opacity = "0";
    };
    return {
      // Many times a second, so this moves the element directly instead of re-rendering.
      pointer(x, y, touching) {
        const dot = dotRef.current;
        if (!dot) return;
        dot.style.transform = `translate(${x}px, ${y}px)`;
        dot.dataset.touching = String(touching);
        dot.style.opacity = "1";
        clearTimeout(fadeTimer.current);
        fadeTimer.current = setTimeout(hide, POINTER_FADE_MS);
      },
      hidePointer: hide,
      ring: (progress) => setRing(progress > 0 && progress < 1 ? progress : 0),
      hint(text, holdMs) {
        clearTimeout(hintTimer.current);
        setHint(text);
        if (text && holdMs) hintTimer.current = setTimeout(() => setHint(null), holdMs);
      },
    };
  }, []);

  return (
    <>
      <div
        ref={dotRef}
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-30 -ml-3 -mt-3 size-6 rounded-full border-[3px] border-blue-600 opacity-0 transition-opacity data-[touching=true]:bg-blue-600/50"
      />

      {ring > 0 && (
        <svg
          role="img"
          aria-label="Hold both hands open to reset the view"
          width="76"
          height="76"
          viewBox="0 0 76 76"
          className="pointer-events-none fixed left-1/2 top-16 z-40 -translate-x-1/2"
        >
          <circle cx="38" cy="38" r={RING_RADIUS} fill="white" stroke="#e5e5e5" strokeWidth="8" />
          <circle
            cx="38"
            cy="38"
            r={RING_RADIUS}
            fill="none"
            stroke="#2563eb"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - ring)}
            transform="rotate(-90 38 38)"
          />
        </svg>
      )}

      {hint && (
        <div
          role="status"
          className="pointer-events-none fixed left-1/2 top-4 z-40 -translate-x-1/2 rounded-full border border-neutral-200 bg-white/95 px-4 py-1.5 text-sm font-medium text-neutral-800 shadow-md"
        >
          {hint}
        </div>
      )}
    </>
  );
}
