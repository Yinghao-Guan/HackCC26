import type { Rect } from "./layout";

const PADDING = 14;

/** A red ring drawn around the line of writing that has the mistake. It sits on the board, so it scrolls with it. */
export function MistakeMark({ box, step }: { box: Rect; step: number | null }) {
  const width = box.width + PADDING * 2;
  const height = box.height + PADDING * 2;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute"
      style={{ left: box.x - PADDING, top: box.y - PADDING, width, height }}
    >
      <svg width={width} height={height} className="absolute inset-0 overflow-visible">
        <rect
          x={3}
          y={3}
          width={width - 6}
          height={height - 6}
          rx={Math.min(height / 2, 28)}
          fill="none"
          stroke="#dc2626"
          strokeWidth={4}
        />
      </svg>
      {step !== null && (
        // Beside the ring, not above it, so it never covers the line before.
        <span className="absolute left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap rounded-full bg-red-600 px-2.5 py-0.5 text-sm font-semibold text-white">
          Step {step}
        </span>
      )}
    </div>
  );
}
