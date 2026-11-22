import type { Rect } from "./layout";

const PADDING = 14;

/**
 * A ring drawn around the line of writing that has the mistake. It sits on the board, so it scrolls with
 * it. White edged with black, so it shows on a board of any brightness without any color (the projected
 * board shows no color, so the camera can find the blue cap of the marker that presses the buttons).
 */
export function MistakeMark({ box, step }: { box: Rect; step: number | null }) {
  const width = box.width + PADDING * 2;
  const height = box.height + PADDING * 2;
  const ring = { x: 3, y: 3, width: width - 6, height: height - 6, rx: Math.min(height / 2, 28), fill: "none" };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute"
      style={{ left: box.x - PADDING, top: box.y - PADDING, width, height }}
    >
      <svg width={width} height={height} className="absolute inset-0 overflow-visible">
        <rect {...ring} stroke="#171717" strokeWidth={7} />
        <rect {...ring} stroke="#ffffff" strokeWidth={4} />
      </svg>
      {step !== null && (
        // Beside the ring, not above it, so it never covers the line before.
        <span className="absolute left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap rounded-full border-2 border-neutral-900 bg-white px-2.5 py-0.5 text-sm font-semibold text-neutral-900">
          Step {step}
        </span>
      )}
    </div>
  );
}
