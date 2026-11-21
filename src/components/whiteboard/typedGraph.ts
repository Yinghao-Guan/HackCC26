import { graphFromLines } from "@/lib/equations";
import type { GraphCurve, GraphWindow } from "@/lib/graph";
import type { Rect } from "./layout";
import { isInView, strokeBounds, type Stroke } from "./strokes";

export interface TypedGraph {
  curves: GraphCurve[];
  window: GraphWindow;
  /** Where the typed equations sit on the board. */
  ink: Rect;
}

/**
 * If what is in view is only typed equations that can be read directly (like
 * `y = x^2 - 3x + 2`), work out the graph right here: no AI, no waiting. Gives
 * null when anything else is in view (handwriting, prose, LaTeX...), and the
 * AI should be asked instead.
 */
export function graphFromTypedText(strokes: Stroke[], viewport: Rect): TypedGraph | null {
  const marks = strokes.filter((stroke) => stroke.tool !== "eraser" && isInView(stroke, viewport));
  if (marks.length === 0 || marks.some((stroke) => stroke.tool !== "text")) return null;

  // Read top to bottom, then left to right.
  const ordered = [...marks].sort(
    (a, b) => a.points[0].y - b.points[0].y || a.points[0].x - b.points[0].x,
  );
  const graph = graphFromLines(ordered.flatMap((stroke) => (stroke.text ?? "").split("\n")));
  if (!graph) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of ordered) {
    const b = strokeBounds(stroke);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return { ...graph, ink: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}
