"use client";

import type { ReactNode } from "react";
import type { EraserMode, Tool, WhiteboardSettings } from "./settings";
import type { AiStatus } from "./ai";

interface SettingsPanelProps {
  settings: WhiteboardSettings;
  onSettingsChange: (patch: Partial<WhiteboardSettings>) => void;
  canUndo: boolean;
  canClear: boolean;
  canResetView: boolean;
  ai: AiStatus;
  /** Is the camera page ready to read the marker writing on the board? */
  cameraReady: boolean;
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
  cameraReady,
  onSolve,
  onGraph,
  onCheck,
  onUndo,
  onClear,
  onResetView,
}: SettingsPanelProps) {
  // While the board is being read (a picture taken, or the AI asked), the AI buttons wait.
  const busy = ai.state === "loading" || ai.state === "capturing";
  const busyWith = (action: "solve" | "graph" | "check") =>
    (ai.state === "loading" || ai.state === "capturing") && ai.action === action;
  const { tool, eraserMode } = settings;

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
            disabled={busy}
            className="h-14 rounded-lg bg-neutral-900 text-lg font-semibold text-white transition-colors hover:bg-neutral-700 disabled:pointer-events-none disabled:opacity-60"
          >
            {busyWith("solve") ? "Reading…" : "Solve"}
          </button>
          <button
            type="button"
            onClick={onGraph}
            disabled={busy}
            className="h-14 rounded-lg bg-neutral-900 text-lg font-semibold text-white transition-colors hover:bg-neutral-700 disabled:pointer-events-none disabled:opacity-60"
          >
            {busyWith("graph") ? "Drawing…" : "Graph"}
          </button>
          <button
            type="button"
            onClick={onCheck}
            disabled={busy}
            className="h-14 rounded-lg bg-neutral-900 text-lg font-semibold text-white transition-colors hover:bg-neutral-700 disabled:pointer-events-none disabled:opacity-60"
          >
            {busyWith("check") ? "Checking…" : "Check"}
          </button>
        </div>
        <p
          role="status"
          className={`text-sm ${
            ai.state === "message" && ai.tone === "error" ? "font-medium text-neutral-900" : "text-neutral-500"
          }`}
        >
          {ai.state === "capturing"
            ? "Taking a picture of the board. Take your hand away from it."
            : ai.state === "loading"
            ? ai.action === "graph"
              ? "Reading your equations and drawing the graph. This can take a few seconds."
              : ai.action === "check"
                ? "Reading your steps and checking each one. This can take a few seconds."
                : "Reading your handwriting and solving it. This can take a few seconds."
            : ai.state === "message"
              ? ai.text
              : cameraReady
                ? "Write with a marker, then press a button: the camera reads the board. Solve works out the answer, Graph draws the equations, Check finds the first mistake in your steps."
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
            className={`${buttonBase} ${buttonIdle}`}
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
