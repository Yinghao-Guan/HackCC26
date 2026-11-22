import type { MarkTool } from "./strokes";

/** What a click or drag on the board does. "move" pans the view; the others make marks. */
export type Tool = MarkTool | "move";

/**
 * How the eraser works:
 * - pixel: rubs out whatever the eraser circle covers, even part of a stroke
 * - stroke: removes every whole stroke (or piece of text) the eraser circle touches
 */
export type EraserMode = "pixel" | "stroke";
