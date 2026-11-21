import type { Rect } from "./layout";
import { paintStroke, strokeBounds, type Stroke } from "./strokes";

const PADDING = 24; // white margin around the ink in the exported image, in pixels
const TARGET_SIDE = 1024; // aim for about this size on the image's long side
const MAX_UPSCALE = 2; // never blow small writing up by more than this
const ALPHA_THRESHOLD = 16; // a pixel counts as ink above this opacity (0-255)

export interface InkImage {
  /** The ink on a white background, cropped to the writing, as a PNG data URL. */
  dataUrl: string;
  /** Where that writing sits on the board, in board pixels. */
  bounds: Rect;
}

/** True if any part of a mark (including the pen's width) is inside the rectangle. */
function isInView(stroke: Stroke, view: Rect): boolean {
  const b = strokeBounds(stroke);
  const half = stroke.tool === "text" ? 0 : stroke.size / 2;
  return (
    b.maxX + half >= view.x &&
    b.minX - half <= view.x + view.width &&
    b.maxY + half >= view.y &&
    b.minY - half <= view.y + view.height
  );
}

/**
 * Render the writing on the board to an image the AI can read. If a `viewport`
 * is given, only writing that is at least partly inside it is included, so the
 * AI reads what you are looking at. Strokes are drawn from data (not copied
 * from the screen), so the image is clean: ink and text on white with no UI,
 * cropped to the writing and sized sensibly. Returns null if there is nothing
 * to read.
 */
export function exportInk(strokes: Stroke[], viewport?: Rect): InkImage | null {
  // Pen strokes and typed text count as writing; pixel-eraser cuts do not.
  const marks = strokes.filter(
    (stroke) => stroke.tool !== "eraser" && (!viewport || isInView(stroke, viewport)),
  );
  if (marks.length === 0) return null;
  const included = new Set(marks);

  // A rough area that surely contains all the writing, including the pen's width.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of marks) {
    const b = strokeBounds(stroke);
    const half = stroke.tool === "text" ? 0 : stroke.size / 2;
    minX = Math.min(minX, b.minX - half);
    minY = Math.min(minY, b.minY - half);
    maxX = Math.max(maxX, b.maxX + half);
    maxY = Math.max(maxY, b.maxY + half);
  }
  const areaWidth = maxX - minX;
  const areaHeight = maxY - minY;
  const scale = Math.min(MAX_UPSCALE, TARGET_SIDE / Math.max(areaWidth, areaHeight));

  // Paint the writing in order, with the eraser cuts, on a transparent canvas.
  const ink = document.createElement("canvas");
  ink.width = Math.max(1, Math.ceil(areaWidth * scale));
  ink.height = Math.max(1, Math.ceil(areaHeight * scale));
  const ctx = ink.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
  for (const stroke of strokes) {
    if (stroke.tool === "eraser" || included.has(stroke)) paintStroke(ctx, stroke);
  }

  // Erasing can leave empty margins, so find where ink actually remains.
  const { data } = ctx.getImageData(0, 0, ink.width, ink.height);
  let left = ink.width;
  let top = ink.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < ink.height; y++) {
    for (let x = 0; x < ink.width; x++) {
      if (data[(y * ink.width + x) * 4 + 3] > ALPHA_THRESHOLD) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null; // everything was erased

  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  const out = document.createElement("canvas");
  out.width = cropWidth + PADDING * 2;
  out.height = cropHeight + PADDING * 2;
  const outCtx = out.getContext("2d");
  if (!outCtx) return null;
  outCtx.fillStyle = "#ffffff";
  outCtx.fillRect(0, 0, out.width, out.height);
  outCtx.drawImage(ink, left, top, cropWidth, cropHeight, PADDING, PADDING, cropWidth, cropHeight);

  return {
    dataUrl: out.toDataURL("image/png"),
    bounds: {
      x: minX + left / scale,
      y: minY + top / scale,
      width: cropWidth / scale,
      height: cropHeight / scale,
    },
  };
}
