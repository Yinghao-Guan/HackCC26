import type { Rect } from "./layout";
import { isInView, paintStroke, strokeBounds, type Stroke } from "./strokes";

const PADDING = 24; // white margin around the ink in the exported image, in pixels
const NUMBER_MARGIN = 72; // left margin when lines are numbered, with room for a circle
const TARGET_SIDE = 1024; // aim for about this size on the image's long side
const MAX_UPSCALE = 2; // never blow small writing up by more than this
const ALPHA_THRESHOLD = 16; // a pixel counts as ink above this opacity (0-255)
const MIN_LINE_GAP = 10; // an empty band this tall (in board pixels) separates two lines

/**
 * The color to draw a mark in for the image the AI reads, which is on white. Light ink
 * (made for the projected gray board) would vanish there, so it is drawn dark.
 */
function inkForAi(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const value = parseInt(match[1], 16);
  const brightness =
    0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255);
  return brightness > 170 ? "#171717" : color;
}

export interface InkImage {
  /** The ink on a white background, cropped to the writing, as a PNG data URL. */
  dataUrl: string;
  /** Where that writing sits on the board, in board pixels. */
  bounds: Rect;
  /** Each line of writing, top to bottom, in board pixels. */
  lines: Rect[];
}

export interface ExportOptions {
  /** Mark each line of writing with a red numbered circle in the left margin. */
  numberLines?: boolean;
}

/** A band of rows (of the ink canvas) that holds one line of writing. */
interface Run {
  start: number;
  end: number;
  left: number;
  right: number;
}

/**
 * Writing painted on a transparent canvas: ink is opaque, the rest is clear. The
 * canvas's top-left corner is at (originX, originY) on the board, and `scale` canvas
 * pixels make one board pixel.
 */
interface PaintedInk {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  originX: number;
  originY: number;
  scale: number;
}

/** Paint the marks made on the board (with the mouse or a finger) onto `ctx`, dark, with the eraser's cuts. */
function paintMarks(ctx: CanvasRenderingContext2D, strokes: Stroke[], included: (stroke: Stroke) => boolean) {
  for (const stroke of strokes) {
    if (stroke.tool === "eraser") paintStroke(ctx, stroke);
    else if (included(stroke)) paintStroke(ctx, { ...stroke, color: inkForAi(stroke.color) });
  }
}

/** Paint the writing made on the board onto a canvas just big enough for it, sized for the AI. */
function paintStrokes(strokes: Stroke[], viewport?: Rect): PaintedInk | null {
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
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(areaWidth * scale));
  canvas.height = Math.max(1, Math.ceil(areaHeight * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
  paintMarks(ctx, strokes, (stroke) => included.has(stroke));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas, ctx, originX: minX, originY: minY, scale };
}

/**
 * Turn painted writing into the image the AI reads: cropped to where ink actually
 * is, on white, with the lines of writing found (and numbered if asked).
 *
 * Lines of writing are found from the ink itself (separated by empty bands), so
 * they work for handwriting and typed text alike and ignore erased marks.
 */
function imageFromInk(painted: PaintedInk, options: ExportOptions): InkImage | null {
  const { canvas: ink, ctx, originX, originY, scale } = painted;

  // Erasing can leave empty margins, so find where ink actually remains, row by row.
  const { data } = ctx.getImageData(0, 0, ink.width, ink.height);
  const rowLeft = new Int32Array(ink.height).fill(ink.width);
  const rowRight = new Int32Array(ink.height).fill(-1);
  let left = ink.width;
  let top = ink.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < ink.height; y++) {
    for (let x = 0; x < ink.width; x++) {
      if (data[(y * ink.width + x) * 4 + 3] > ALPHA_THRESHOLD) {
        if (x < rowLeft[y]) rowLeft[y] = x;
        if (x > rowRight[y]) rowRight[y] = x;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null; // no ink at all

  // Group the rows that hold ink into lines, split wherever there is a wide enough empty band.
  const gap = Math.max(2, Math.round(MIN_LINE_GAP * scale));
  const runs: Run[] = [];
  let run: Run | null = null;
  let emptyRows = 0;
  for (let y = top; y <= bottom; y++) {
    if (rowRight[y] < 0) {
      emptyRows++;
      if (run && emptyRows >= gap) {
        runs.push(run);
        run = null;
      }
      continue;
    }
    emptyRows = 0;
    if (!run) run = { start: y, end: y, left: rowLeft[y], right: rowRight[y] };
    else {
      run.end = y;
      run.left = Math.min(run.left, rowLeft[y]);
      run.right = Math.max(run.right, rowRight[y]);
    }
  }
  if (run) runs.push(run);

  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  const marginLeft = options.numberLines ? NUMBER_MARGIN : PADDING;
  const out = document.createElement("canvas");
  out.width = cropWidth + marginLeft + PADDING;
  out.height = cropHeight + PADDING * 2;
  const outCtx = out.getContext("2d");
  if (!outCtx) return null;
  outCtx.fillStyle = "#ffffff";
  outCtx.fillRect(0, 0, out.width, out.height);
  outCtx.drawImage(ink, left, top, cropWidth, cropHeight, marginLeft, PADDING, cropWidth, cropHeight);

  if (options.numberLines) {
    // Red numbered circles in the margin, so the AI can say "line 3" and we know which one that is.
    const shortest = Math.min(...runs.map((r) => r.end - r.start + 1));
    const radius = Math.max(10, Math.min(22, shortest * 0.45));
    outCtx.textAlign = "center";
    outCtx.textBaseline = "middle";
    outCtx.font = `bold ${Math.round(radius * 1.15)}px sans-serif`;
    runs.forEach((r, index) => {
      const cx = marginLeft / 2;
      const cy = (r.start + r.end) / 2 - top + PADDING;
      outCtx.fillStyle = "#dc2626";
      outCtx.beginPath();
      outCtx.arc(cx, cy, radius, 0, Math.PI * 2);
      outCtx.fill();
      outCtx.fillStyle = "#ffffff";
      outCtx.fillText(String(index + 1), cx, cy + 1);
    });
  }

  return {
    dataUrl: out.toDataURL("image/png"),
    bounds: {
      x: originX + left / scale,
      y: originY + top / scale,
      width: cropWidth / scale,
      height: cropHeight / scale,
    },
    lines: runs.map((r) => ({
      x: originX + r.left / scale,
      y: originY + r.start / scale,
      width: (r.right - r.left + 1) / scale,
      height: (r.end - r.start + 1) / scale,
    })),
  };
}

/**
 * Render the writing on the board to an image the AI can read. If a `viewport`
 * is given, only writing that is at least partly inside it is included, so the
 * AI reads what you are looking at. Strokes are drawn from data (not copied
 * from the screen), so the image is clean: ink and text on white with no UI,
 * cropped to the writing and sized sensibly. Returns null if there is nothing
 * to read.
 */
export function exportInk(
  strokes: Stroke[],
  viewport?: Rect,
  options: ExportOptions = {},
): InkImage | null {
  const painted = paintStrokes(strokes, viewport);
  return painted ? imageFromInk(painted, options) : null;
}

/**
 * The image the AI reads when the board is read through the camera: the marker
 * writing from the camera's picture of the drawing area, with anything drawn with
 * the mouse (or a finger) on top, where it shows on the board.
 *
 * `picture` is the camera page's cleaned picture of the drawing area (white except
 * for the writing), covering exactly `viewport`, with `pictureScale` picture pixels
 * to one board pixel. Returns null if there is no writing at all.
 */
export async function exportBoardPicture(
  picture: string,
  pictureScale: number,
  strokes: Stroke[],
  viewport: Rect,
  options: ExportOptions = {},
): Promise<InkImage | null> {
  const image = new Image();
  image.src = picture;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  // The marker writing becomes ink on a transparent canvas, as dark as it was in the picture.
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = pixels;
  for (let i = 0; i < data.length; i += 4) {
    const darkness = 255 - data[i];
    data[i] = 23;
    data[i + 1] = 23;
    data[i + 2] = 23;
    data[i + 3] = darkness;
  }
  ctx.putImageData(pixels, 0, 0);

  // Marks made on the board go on top. They are painted on their own canvas first, so that the
  // eraser's cuts only remove those marks, never the marker writing.
  const digital = document.createElement("canvas");
  digital.width = canvas.width;
  digital.height = canvas.height;
  const digitalCtx = digital.getContext("2d");
  if (digitalCtx) {
    digitalCtx.setTransform(pictureScale, 0, 0, pictureScale, -viewport.x * pictureScale, -viewport.y * pictureScale);
    paintMarks(digitalCtx, strokes, (stroke) => isInView(stroke, viewport));
    ctx.drawImage(digital, 0, 0);
  }

  return imageFromInk(
    { canvas, ctx, originX: viewport.x, originY: viewport.y, scale: pictureScale },
    options,
  );
}
