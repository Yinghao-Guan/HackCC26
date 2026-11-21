import type { MarkTool } from "./strokes";

/** What a click or drag on the board does. "move" pans the view; the others make marks. */
export type Tool = MarkTool | "move";

/** The tools that have a size setting. */
export type SizedTool = Exclude<Tool, "move">;

/**
 * How the eraser works:
 * - pixel: rubs out whatever the eraser circle covers, even part of a stroke
 * - stroke: removes every whole stroke (or piece of text) the eraser circle touches
 */
export type EraserMode = "pixel" | "stroke";

export interface WhiteboardSettings {
  tool: Tool;
  eraserMode: EraserMode;
  /** Used by the pen and by text. */
  color: string;
  penSize: number;
  eraserSize: number;
  /** Font size for typed text, in pixels. */
  textSize: number;
}

export const COLORS = [
  { name: "Black", value: "#171717" },
  { name: "Blue", value: "#2563eb" },
  { name: "Red", value: "#dc2626" },
  { name: "Green", value: "#16a34a" },
  { name: "Orange", value: "#ea580c" },
] as const;

export const SIZE_LIMITS = {
  pen: { min: 1, max: 24 },
  eraser: { min: 8, max: 96 },
  text: { min: 14, max: 96 },
} as const;

export const DEFAULT_SETTINGS: WhiteboardSettings = {
  tool: "pen",
  eraserMode: "pixel",
  color: COLORS[0].value,
  penSize: 4,
  eraserSize: 32,
  textSize: 28,
};

/** The size setting that belongs to the selected tool (0 for tools without one). */
export function sizeOf(settings: WhiteboardSettings): number {
  switch (settings.tool) {
    case "pen":
      return settings.penSize;
    case "eraser":
      return settings.eraserSize;
    case "text":
      return settings.textSize;
    case "move":
      return 0;
  }
}
