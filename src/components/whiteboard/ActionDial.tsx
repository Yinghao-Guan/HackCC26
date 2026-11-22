"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AiAction, AiStatus, VoiceStatus } from "./ai";

interface ActionDialProps {
  ai: AiStatus;
  voice: VoiceStatus;
  onSolve: () => void;
  onGraph: () => void;
  onCheck: () => void;
  onVoiceToggle: () => void;
}

/** A small stroke icon, drawn the same way as the rest of the app's icons. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const SolveIcon = () => (
  <Icon>
    <path d="M9 18h6" />
    <path d="M10 21.5h4" />
    <path d="M12 2.5a6.5 6.5 0 0 0-3.9 11.7c.5.4.9 1 1 1.8h5.8c.1-.8.5-1.4 1-1.8A6.5 6.5 0 0 0 12 2.5Z" />
  </Icon>
);

const GraphIcon = () => (
  <Icon>
    <path d="M3 3v18h18" />
    <path d="M7.5 15.5 11 11l3 3 5-6" />
  </Icon>
);

const CheckIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.25 12.5 2.5 2.5 5-6" />
  </Icon>
);

const MicIcon = () => (
  <Icon>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
  </Icon>
);

/** A small ring spinner, used while an AI action is working. */
function Spinner() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6 animate-spin" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2.5} opacity={0.25} />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** What the AI's status means in words, while it is working or has something to say. */
function aiMessage(ai: AiStatus): { text: string; tone: "info" | "error" } | null {
  if (ai.state === "loading") {
    const text = {
      solve: "Reading your handwriting and solving it…",
      graph: "Reading your equations and drawing the graph…",
      check: "Reading your steps and checking each one…",
      ask: "Thinking about your question…",
    }[ai.action];
    return { text, tone: "info" };
  }
  if (ai.state === "capturing") {
    return { text: "Taking a picture of the board. Take your hand away from it.", tone: "info" };
  }
  if (ai.state === "message") return { text: ai.text, tone: ai.tone };
  return null;
}

/** A floating speech-bubble with a status message, shown above the dial. */
function StatusBubble({
  text,
  tone,
  heard,
}: {
  text: string;
  tone: "info" | "error";
  heard?: string;
}) {
  return (
    <div
      role="status"
      className="max-w-[17rem] rounded-2xl border border-neutral-200 bg-white/95 p-3.5 text-sm leading-snug text-neutral-700 shadow-lg shadow-black/10"
    >
      {heard && <p className="mb-1 italic text-neutral-500">“{heard}”</p>}
      <p className={tone === "error" ? "text-red-700" : undefined}>{text}</p>
    </div>
  );
}

// Each action sits on a quarter-circle arc around the main button, from
// straight up (90°) to straight left (180°), measured the usual math way.
// The radius has to clear the chord between adjacent items (2R·sin(step/2))
// by more than their own 56px width, or neighbors overlap.
const RADIUS = 130;
const ARC_START_DEG = 90;
const ARC_END_DEG = 180;

/** Where an item on the arc ends up, as a `translate()` the CSS transition can animate. */
function arcOffset(index: number, count: number): { x: number; y: number } {
  const angle = ARC_START_DEG + ((ARC_END_DEG - ARC_START_DEG) * index) / (count - 1);
  const radians = (angle * Math.PI) / 180;
  return { x: RADIUS * Math.cos(radians), y: -RADIUS * Math.sin(radians) };
}

/**
 * The whole set of AI actions, as a single circular button in the bottom-right
 * corner that fans out into Solve, Graph, Check and Speak along an arc. Keeps
 * the board itself free of any other controls.
 */
export function ActionDial({ ai, voice, onSolve, onGraph, onCheck, onVoiceToggle }: ActionDialProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // While the board is being read (a picture taken, or the AI asked), the AI buttons wait.
  const busy = ai.state === "loading" || ai.state === "capturing";
  const busyWith = (action: AiAction) => (ai.state === "loading" || ai.state === "capturing") && ai.action === action;
  const listening = voice.state === "listening";

  // Close on Escape, and on a click or tap outside the dial.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const items: {
    id: AiAction | "speak";
    label: string;
    icon: ReactNode;
    onClick: () => void;
    tone: string;
    activeTone?: string;
    active?: boolean;
    disabled?: boolean;
  }[] = [
    {
      id: "solve",
      label: "Solve",
      icon: busyWith("solve") ? <Spinner /> : <SolveIcon />,
      onClick: onSolve,
      tone: "bg-emerald-600 hover:bg-emerald-700",
      disabled: busy,
    },
    {
      id: "graph",
      label: "Graph",
      icon: busyWith("graph") ? <Spinner /> : <GraphIcon />,
      onClick: onGraph,
      tone: "bg-blue-600 hover:bg-blue-700",
      disabled: busy,
    },
    {
      id: "check",
      label: "Check",
      icon: busyWith("check") ? <Spinner /> : <CheckIcon />,
      onClick: onCheck,
      tone: "bg-violet-600 hover:bg-violet-700",
      disabled: busy,
    },
    {
      id: "speak",
      label: listening ? "Listening…" : "Speak",
      icon: <MicIcon />,
      onClick: onVoiceToggle,
      tone: "bg-neutral-900 hover:bg-neutral-700",
      activeTone: "bg-red-600 hover:bg-red-700",
      active: listening,
    },
  ];

  const message = aiMessage(ai);
  const voiceMessage =
    voice.state === "message"
      ? { text: voice.text, tone: voice.tone, heard: voice.heard }
      : listening
        ? { text: "Say what you want. It stops when you pause, or tap the mic again.", tone: "info" as const, heard: voice.heard }
        : null;

  return (
    <>
      {/* A soft scrim brings focus to the open dial, and a tap on it closes it. No blur: it has
          to animate every frame while open/closes, and a blurred backdrop is what made that feel
          laggy. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-neutral-900/10 transition-opacity duration-300 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <div ref={rootRef} className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
        {message && <StatusBubble text={message.text} tone={message.tone} />}
        {voiceMessage && <StatusBubble {...voiceMessage} />}

        {/* Sized to the main button; the items are positioned absolutely so they don't
            affect this box's layout, and animate outward from its corner along the arc. */}
        <div role="menu" aria-label="AI actions" className="relative size-16">
          {items.map((item, index) => {
            const { x, y } = arcOffset(index, items.length);
            const style: CSSProperties = {
              transform: open ? `translate(${x}px, ${y}px) scale(1)` : "translate(0, 0) scale(0)",
              transitionDelay: open ? `${index * 30}ms` : `${(items.length - 1 - index) * 25}ms`,
            };
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                title={item.label}
                aria-label={item.label}
                disabled={item.disabled}
                onClick={() => {
                  item.onClick();
                  if (item.id !== "speak") setOpen(false);
                }}
                style={style}
                className={`absolute bottom-0 right-0 flex size-14 shrink-0 items-center justify-center rounded-full text-white shadow-lg shadow-black/20 transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] disabled:pointer-events-none disabled:opacity-50 ${
                  open ? "opacity-100" : "pointer-events-none opacity-0"
                } ${item.active && item.activeTone ? `${item.activeTone} animate-pulse` : item.tone}`}
              >
                {item.icon}
              </button>
            );
          })}

          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Close actions" : "Open actions: Solve, Graph, Check, Speak"}
            onClick={() => setOpen((v) => !v)}
            className={`absolute bottom-0 right-0 flex size-16 shrink-0 items-center justify-center rounded-full text-white shadow-xl shadow-black/25 transition-colors ${
              listening ? "bg-red-600 hover:bg-red-700" : "bg-neutral-900 hover:bg-neutral-700"
            }`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className={`size-7 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                open ? "rotate-45" : "rotate-0"
              }`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}
