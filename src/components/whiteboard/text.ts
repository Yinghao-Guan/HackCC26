// Shared by the text editor (a textarea) and the canvas painter, so typed text
// looks the same while you type it and after it is placed on the board.

export const TEXT_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Line height as a multiple of the font size. */
export const TEXT_LINE_HEIGHT = 1.3;

/** Space between the editor's edge and the text, in pixels. */
export const TEXT_PADDING = 6;

export const fontFor = (size: number) => `${size}px ${TEXT_FONT_FAMILY}`;

export const textLines = (text: string) => text.split("\n");

let measureContext: CanvasRenderingContext2D | null | undefined;

function getMeasureContext() {
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  return measureContext;
}

/** The size of some text in CSS pixels. Only call this in the browser. */
export function measureText(text: string, size: number): { width: number; height: number } {
  const lines = textLines(text);
  let width = 0;
  const ctx = getMeasureContext();
  if (ctx) {
    ctx.font = fontFor(size);
    for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
  }
  return { width, height: lines.length * size * TEXT_LINE_HEIGHT };
}

/**
 * How far below the top of a line the text baseline sits, matching how CSS
 * centers text in a line box.
 */
export function baselineOffset(ctx: CanvasRenderingContext2D, size: number): number {
  ctx.font = fontFor(size);
  const metrics = ctx.measureText("Hg");
  const ascent = metrics.fontBoundingBoxAscent ?? size * 0.9;
  const descent = metrics.fontBoundingBoxDescent ?? size * 0.25;
  return (size * TEXT_LINE_HEIGHT - (ascent + descent)) / 2 + ascent;
}
