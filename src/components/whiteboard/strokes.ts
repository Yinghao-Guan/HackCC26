import {
  baselineOffset,
  fontFor,
  measureText,
  textLines,
  TEXT_LINE_HEIGHT,
} from "./text";
import type { Rect } from "./layout";

/** The kinds of mark that can be on the board. */
export type MarkTool = "pen" | "eraser" | "text";

export interface Point {
  x: number;
  y: number;
}

/**
 * A mark that is still being made, or has not been given an id yet. A mark is
 * a pen stroke, a pixel-eraser cut, or a piece of typed text.
 */
export interface StrokeDraft {
  tool: MarkTool;
  color: string;
  /** Pen and eraser: the line width. Text: the font size. */
  size: number;
  /** Pen and eraser: the path. Text: one point, the top-left corner of the text. */
  points: Point[];
  /** Text only: what was typed. Lines are separated by "\n". */
  text?: string;
}

/**
 * One mark on the board, from pointer down to pointer up (or one piece of
 * text). Never changed after it is finished.
 *
 * Points are in CSS pixels relative to the board's top-left corner. Marks are
 * kept as data, not just pixels, so we can undo, repaint at any size, and
 * later hand them to the AI layer (strokes to image) or the layout engine
 * (bounding boxes).
 */
export interface Stroke extends StrokeDraft {
  id: number;
}

const midpoint = (a: Point, b: Point): Point => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

function applyStyle(ctx: CanvasRenderingContext2D, stroke: StrokeDraft) {
  // The pixel eraser cuts through earlier ink instead of painting white, so
  // the canvas stays transparent and the board's own background shows through.
  ctx.globalCompositeOperation =
    stroke.tool === "eraser" ? "destination-out" : "source-over";
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

function paintDot(ctx: CanvasRenderingContext2D, point: Point, size: number) {
  ctx.beginPath();
  ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
  ctx.fill();
}

function paintText(ctx: CanvasRenderingContext2D, stroke: StrokeDraft) {
  const { x, y } = stroke.points[0];
  const lineHeight = stroke.size * TEXT_LINE_HEIGHT;

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = stroke.color;
  ctx.font = fontFor(stroke.size);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const baseline = baselineOffset(ctx, stroke.size);
  textLines(stroke.text ?? "").forEach((line, index) => {
    ctx.fillText(line, x, y + index * lineHeight + baseline);
  });
  ctx.restore();
}

/** Paint a whole mark. Pen strokes are smooth curves through the midpoints of their points. */
export function paintStroke(ctx: CanvasRenderingContext2D, stroke: StrokeDraft) {
  const pts = stroke.points;
  if (pts.length === 0) return;

  if (stroke.tool === "text") {
    paintText(ctx, stroke);
    return;
  }

  ctx.save();
  applyStyle(ctx, stroke);

  if (pts.length === 1) {
    paintDot(ctx, pts[0], stroke.size);
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const end = midpoint(pts[i], pts[i + 1]);
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, end.x, end.y);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Paint only the newest piece of an in-progress stroke. It follows the same
 * curve as `paintStroke`, so drawing live and repainting later look the same.
 */
export function paintStrokeTail(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeDraft,
) {
  const pts = stroke.points;
  const n = pts.length;
  if (n === 0) return;

  ctx.save();
  applyStyle(ctx, stroke);

  if (n === 1) {
    paintDot(ctx, pts[0], stroke.size);
  } else {
    ctx.beginPath();
    if (n === 2) {
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
    } else {
      const start = n === 3 ? pts[0] : midpoint(pts[n - 3], pts[n - 2]);
      const end = midpoint(pts[n - 2], pts[n - 1]);
      ctx.moveTo(start.x, start.y);
      ctx.quadraticCurveTo(pts[n - 2].x, pts[n - 2].y, end.x, end.y);
    }
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Bounds and hit-testing (used by the stroke eraser, the text tool and export)
// ---------------------------------------------------------------------------

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Finished strokes never change, so their bounds can be cached.
const boundsCache = new WeakMap<StrokeDraft, Bounds>();

/**
 * The box around a mark. For pen and eraser strokes it covers the points but
 * not the line width; for text it covers the whole text.
 */
export function strokeBounds(stroke: StrokeDraft): Bounds {
  let bounds = boundsCache.get(stroke);
  if (!bounds) {
    if (stroke.tool === "text") {
      const { x, y } = stroke.points[0];
      const size = measureText(stroke.text ?? "", stroke.size);
      bounds = { minX: x, minY: y, maxX: x + size.width, maxY: y + size.height };
    } else {
      bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const { x, y } of stroke.points) {
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
    }
    boundsCache.set(stroke, bounds);
  }
  return bounds;
}

function distanceToSegmentSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return (p.x - cx) ** 2 + (p.y - cy) ** 2;
}

/** True if a circle at `center` touches any part of the mark's visible ink. */
export function strokeTouchesCircle(
  stroke: StrokeDraft,
  center: Point,
  radius: number,
): boolean {
  const b = strokeBounds(stroke);

  if (stroke.tool === "text") {
    // Text counts as the whole box around it.
    const nearestX = Math.max(b.minX, Math.min(center.x, b.maxX));
    const nearestY = Math.max(b.minY, Math.min(center.y, b.maxY));
    return (center.x - nearestX) ** 2 + (center.y - nearestY) ** 2 <= radius ** 2;
  }

  // The ink is as wide as the stroke, so it reaches half a stroke past its points.
  const reach = radius + stroke.size / 2;
  if (
    center.x < b.minX - reach ||
    center.x > b.maxX + reach ||
    center.y < b.minY - reach ||
    center.y > b.maxY + reach
  ) {
    return false;
  }

  const reachSq = reach * reach;
  const pts = stroke.points;
  if (pts.length === 1) {
    return (center.x - pts[0].x) ** 2 + (center.y - pts[0].y) ** 2 <= reachSq;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    if (distanceToSegmentSq(center, pts[i], pts[i + 1]) <= reachSq) return true;
  }
  return false;
}

/** The topmost piece of text under a point (with a little slack), if any. */
export function findTextAt(strokes: Stroke[], point: Point): Stroke | null {
  const slack = 4;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const stroke = strokes[i];
    if (stroke.tool !== "text") continue;
    const b = strokeBounds(stroke);
    if (
      point.x >= b.minX - slack &&
      point.x <= b.maxX + slack &&
      point.y >= b.minY - slack &&
      point.y <= b.maxY + slack
    ) {
      return stroke;
    }
  }
  return null;
}

/** True if any part of a mark (including the pen's width) is inside the rectangle. */
export function isInView(stroke: Stroke, view: Rect): boolean {
  const b = strokeBounds(stroke);
  const half = stroke.tool === "text" ? 0 : stroke.size / 2;
  return (
    b.maxX + half >= view.x &&
    b.minX - half <= view.x + view.width &&
    b.maxY + half >= view.y &&
    b.minY - half <= view.y + view.height
  );
}
