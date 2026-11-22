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
  /** How bright the board is, as a percent: 100 is white, lower is a darker gray. */
  boardBrightness: number;
}

// White comes first and is the default: on the projected gray board, ink that is
// lighter than the board cannot be mistaken for the finger's shadow, which is darker
// than the board. Black ink is as dark as a shadow, so it confuses finger writing.
// (The image the AI reads is always drawn dark: see exportInk.ts.)
export const COLORS = [
  { name: "White", value: "#ffffff" },
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

// A white board makes the projector glare. A black one removes the glare but also
// the finger's shadow, which touch detection needs (docs/02-technical-design.md,
// section 4). A gray board is in between, so its level can be tuned on site.
// Tested with the real projector: the glare only becomes acceptable at about 40% or
// lower, and 35% works well, so that is the default.
export const BRIGHTNESS_LIMITS = { min: 30, max: 100 } as const;
export const BRIGHTNESS_PRESETS = [100, 60, 40, 35] as const;

/** The board's background color for a brightness percent (100 is white). */
export function boardColor(brightness: number): string {
  const level = Math.round((255 * brightness) / 100);
  return `rgb(${level}, ${level}, ${level})`;
}

export const DEFAULT_SETTINGS: WhiteboardSettings = {
  tool: "pen",
  eraserMode: "pixel",
  color: COLORS[0].value,
  penSize: 4,
  eraserSize: 32,
  textSize: 28,
  boardBrightness: 35,
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
