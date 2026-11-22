"use client";

import { useId, type ReactNode } from "react";
import {
  BRIGHTNESS_LIMITS,
  BRIGHTNESS_PRESETS,
  boardColor,
  COLORS,
  SIZE_LIMITS,
  sizeOf,
  type EraserMode,
  type SizedTool,
  type Tool,
  type WhiteboardSettings,
} from "./settings";
import type { AiStatus } from "./ai";
import { TEXT_FONT_FAMILY } from "./text";

interface SettingsPanelProps {
  settings: WhiteboardSettings;
  onSettingsChange: (patch: Partial<WhiteboardSettings>) => void;
  canUndo: boolean;
  canClear: boolean;
  canResetView: boolean;
  ai: AiStatus;
  onSolve: () => void;
  onGraph: () => void;
  onCheck: () => void;
  onUndo: () => void;
  onClear: () => void;
  onResetView: () => void;
}

const TOOLS: { value: Tool; label: string }[] = [
  { value: "pen", label: "Pen" },
  { value: "eraser", label: "Eraser" },
  { value: "text", label: "Text" },
  { value: "move", label: "Move" },
];

const TOOL_HINTS: Partial<Record<Tool, string>> = {
  text: "Click the board to type. Click text to edit it. Press Esc or click away to finish.",
  move: "Drag the board to move around. You can also scroll with the mouse wheel or trackpad, or drag with the middle mouse button.",
};

const SIZE_LABELS: Record<SizedTool, string> = {
  pen: "Pen size",
  eraser: "Eraser size",
  text: "Text size",
};

const ERASER_MODES: { value: EraserMode; label: string; hint: string }[] = [
  { value: "pixel", label: "Pixel", hint: "Rub out any part of a stroke." },
  { value: "stroke", label: "Stroke", hint: "Remove a whole stroke or text box with one touch." },
];

// Buttons are large on purpose: the board will be driven by a finger, not just
// a mouse (docs/02-technical-design.md, section 5).
const buttonBase =
  "h-12 rounded-lg border text-base font-medium transition-colors disabled:pointer-events-none disabled:opacity-40";
const buttonIdle = "border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100";
const buttonActive = "border-neutral-900 bg-neutral-900 text-white";

/** A titled group of controls. Add new settings by adding more sections. */
function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function SettingsPanel({
  settings,
  onSettingsChange,
  canUndo,
  canClear,
  canResetView,
  ai,
  onSolve,
  onGraph,
  onCheck,
  onUndo,
  onClear,
  onResetView,
}: SettingsPanelProps) {
  const sizeId = useId();
  const brightnessId = useId();
  const { tool, eraserMode, color, boardBrightness } = settings;

  // The Move tool has no size.
  const sizedTool: SizedTool | null = tool === "move" ? null : tool;
  const size = sizeOf(settings);

  const handleSizeChange = (value: number) => {
    if (tool === "pen") onSettingsChange({ penSize: value });
    else if (tool === "eraser") onSettingsChange({ eraserSize: value });
    else if (tool === "text") onSettingsChange({ textSize: value });
  };

  return (
    <aside
      aria-label="Whiteboard settings"
      className="flex w-80 shrink-0 flex-col gap-8 overflow-y-auto border-l border-neutral-200 bg-neutral-50 p-5"
    >
      <h2 className="text-lg font-semibold tracking-tight">Settings</h2>

      <PanelSection title="AI">
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={onSolve}
            disabled={ai.state === "loading"}
            className="h-14 rounded-lg bg-emerald-600 text-lg font-semibold text-white transition-colors hover:bg-emerald-700 disabled:pointer-events-none disabled:opacity-60"
          >
            {ai.state === "loading" && ai.action === "solve" ? "Reading…" : "Solve"}
          </button>
          <button
            type="button"
            onClick={onGraph}
            disabled={ai.state === "loading"}
            className="h-14 rounded-lg bg-blue-600 text-lg font-semibold text-white transition-colors hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-60"
          >
            {ai.state === "loading" && ai.action === "graph" ? "Drawing…" : "Graph"}
          </button>
          <button
            type="button"
            onClick={onCheck}
            disabled={ai.state === "loading"}
            className="h-14 rounded-lg bg-violet-600 text-lg font-semibold text-white transition-colors hover:bg-violet-700 disabled:pointer-events-none disabled:opacity-60"
          >
            {ai.state === "loading" && ai.action === "check" ? "Checking…" : "Check"}
          </button>
        </div>
        <p
          role="status"
          className={`text-sm ${
            ai.state === "message" && ai.tone === "error" ? "text-red-700" : "text-neutral-500"
          }`}
        >
          {ai.state === "loading"
            ? ai.action === "graph"
              ? "Reading your equations and drawing the graph. This can take a few seconds."
              : ai.action === "check"
                ? "Reading your steps and checking each one. This can take a few seconds."
                : "Reading your handwriting and solving it. This can take a few seconds."
            : ai.state === "message"
              ? ai.text
              : "Solve works out the answer. Graph draws equations in 2D or 3D (typed ones instantly). Check finds the first mistake in your steps."}
        </p>
      </PanelSection>

      <PanelSection title="Tool">
        <div className="grid grid-cols-4 gap-2">
          {TOOLS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={tool === value}
              onClick={() => onSettingsChange({ tool: value })}
              className={`${buttonBase} px-0 text-[15px] ${
                tool === value ? buttonActive : buttonIdle
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {TOOL_HINTS[tool] && <p className="text-sm text-neutral-500">{TOOL_HINTS[tool]}</p>}
      </PanelSection>

      {tool === "eraser" && (
        <PanelSection title="Eraser type">
          <div className="grid grid-cols-2 gap-2">
            {ERASER_MODES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={eraserMode === value}
                onClick={() => onSettingsChange({ eraserMode: value })}
                className={`${buttonBase} ${
                  eraserMode === value ? buttonActive : buttonIdle
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-sm text-neutral-500">
            {ERASER_MODES.find((mode) => mode.value === eraserMode)?.hint}
          </p>
        </PanelSection>
      )}

      <PanelSection title="Color">
        <div className="flex flex-wrap gap-3">
          {COLORS.map(({ name, value }) => {
            const selected = (tool === "pen" || tool === "text") && color === value;
            return (
              <button
                key={value}
                type="button"
                aria-label={name}
                aria-pressed={selected}
                // Picking a color keeps the text tool, and otherwise switches to the pen.
                onClick={() =>
                  onSettingsChange(tool === "text" ? { color: value } : { tool: "pen", color: value })
                }
                className={`size-11 rounded-full border border-black/10 transition-shadow ${
                  selected ? "ring-2 ring-neutral-900 ring-offset-2" : ""
                }`}
                style={{ backgroundColor: value }}
              />
            );
          })}
        </div>
      </PanelSection>

      {sizedTool && (
        <PanelSection title="Size">
          <div
            className="grid h-28 place-items-center overflow-hidden rounded-lg border border-neutral-200"
            // The same gray as the board, so that light ink shows up in the preview.
            style={{ backgroundColor: boardColor(boardBrightness) }}
          >
            {sizedTool === "text" ? (
              <span
                aria-hidden="true"
                className="leading-none"
                style={{
                  fontFamily: TEXT_FONT_FAMILY,
                  fontSize: Math.min(size, 72),
                  color,
                }}
              >
                Aa
              </span>
            ) : (
              <div
                aria-hidden="true"
                className={`rounded-full ${
                  sizedTool === "eraser" ? "border border-dashed border-neutral-400" : ""
                }`}
                style={{
                  width: size,
                  height: size,
                  backgroundColor: sizedTool === "pen" ? color : undefined,
                }}
              />
            )}
          </div>
          <div className="flex items-center justify-between text-sm">
            <label htmlFor={sizeId} className="font-medium">
              {SIZE_LABELS[sizedTool]}
            </label>
            <span className="tabular-nums text-neutral-500">{size}px</span>
          </div>
          <input
            id={sizeId}
            type="range"
            min={SIZE_LIMITS[sizedTool].min}
            max={SIZE_LIMITS[sizedTool].max}
            step={1}
            value={size}
            onChange={(e) => handleSizeChange(Number(e.target.value))}
            className="h-8 w-full cursor-pointer accent-neutral-900"
          />
        </PanelSection>
      )}

      <PanelSection title="Board brightness">
        <div className="grid grid-cols-4 gap-2">
          {BRIGHTNESS_PRESETS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={boardBrightness === value}
              onClick={() => onSettingsChange({ boardBrightness: value })}
              className={`${buttonBase} px-0 text-[15px] ${
                boardBrightness === value ? buttonActive : buttonIdle
              }`}
            >
              {value}%
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between text-sm">
          <label htmlFor={brightnessId} className="font-medium">
            Brightness
          </label>
          <span className="tabular-nums text-neutral-500">{boardBrightness}%</span>
        </div>
        <input
          id={brightnessId}
          type="range"
          min={BRIGHTNESS_LIMITS.min}
          max={BRIGHTNESS_LIMITS.max}
          step={1}
          value={boardBrightness}
          onChange={(e) => onSettingsChange({ boardBrightness: Number(e.target.value) })}
          className="h-8 w-full cursor-pointer accent-neutral-900"
        />
        <p className="text-sm text-neutral-500">
          A dimmer board glares less, but the finger&apos;s shadow on it is fainter. Find the level
          where the shadow still shows.
        </p>
      </PanelSection>

      <PanelSection title="Board">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl/Cmd+Z)"
            className={`${buttonBase} ${buttonIdle}`}
          >
            Undo
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={!canClear}
            className={`${buttonBase} border-red-200 bg-white text-red-700 hover:bg-red-50`}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onResetView}
            disabled={!canResetView}
            className={`${buttonBase} ${buttonIdle} col-span-2`}
          >
            Reset view
          </button>
        </div>
      </PanelSection>
    </aside>
  );
}
