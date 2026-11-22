"use client";

import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { AiAction, AiStatus, VoiceStatus } from "./ai";
import {
  CheckWorkIcon,
  CloseIcon,
  GraphIcon,
  MicIcon,
  SolveIcon,
  SparklesIcon,
} from "./icons";
import { HUB_SIZE, menuExtent } from "./radialGeometry";
import {
  focusRing,
  hubSwap,
  itemBase,
  MenuDisc,
  Orbit,
  RadialFrame,
  useFloatingHub,
  usePrefersReducedMotion,
} from "./radialKit";

interface AiMenuProps {
  ai: AiStatus;
  voice: VoiceStatus;
  onSolve: () => void;
  onGraph: () => void;
  onCheck: () => void;
  onVoiceToggle: () => void;
}

type AiItem = AiAction | "speak";
type IconComponent = (props: { size?: number }) => ReactNode;

// Four large buttons on one ring: big enough to hit with a finger on a projected board.
const ITEM_SIZE = 56;
const RING_RADIUS = 90;
const DISC_RADIUS = RING_RADIUS + ITEM_SIZE / 2 + 10;
const EXTENT = menuExtent(DISC_RADIUS);

/** Four buttons, 90° apart: Solve at the top, then clockwise Graph, Check and Speak. */
const ORDER: AiItem[] = ["solve", "graph", "check", "speak"];
const ANGLES: Record<AiItem, number> = { solve: -90, graph: 0, check: 90, speak: 180 };

/** Each button keeps the color its button had in the old side panel. */
const ITEMS: Record<AiItem, { label: string; Icon: IconComponent; tint: string; filled: string }> = {
  solve: {
    label: "Solve",
    Icon: SolveIcon,
    tint: "text-emerald-600",
    filled: "bg-emerald-600 text-white ring-1 ring-emerald-600",
  },
  graph: {
    label: "Graph",
    Icon: GraphIcon,
    tint: "text-blue-600",
    filled: "bg-blue-600 text-white ring-1 ring-blue-600",
  },
  check: {
    label: "Check",
    Icon: CheckWorkIcon,
    tint: "text-violet-600",
    filled: "bg-violet-600 text-white ring-1 ring-violet-600",
  },
  speak: {
    label: "Speak",
    Icon: MicIcon,
    tint: "text-neutral-900",
    filled: "bg-red-600 text-white ring-1 ring-red-600",
  },
};

/** What the hub shows while a request is running: its icon, and the spinner's color. */
const WORKING: Record<AiAction | "ask", { Icon: IconComponent; color: string; doing: string }> = {
  solve: { Icon: SolveIcon, color: "text-emerald-600", doing: "solving" },
  graph: { Icon: GraphIcon, color: "text-blue-600", doing: "graphing" },
  check: { Icon: CheckWorkIcon, color: "text-violet-600", doing: "checking" },
  ask: { Icon: SparklesIcon, color: "text-neutral-700", doing: "answering your question" },
};

const LOADING_TEXT: Record<AiAction | "ask", string> = {
  solve: "Reading your handwriting and solving it. This can take a few seconds.",
  graph: "Reading your equations and drawing the graph. This can take a few seconds.",
  check: "Reading your steps and checking each one. This can take a few seconds.",
  ask: "Thinking about your question. This can take a few seconds.",
};

/** How long a message stays up before it fades on its own. Errors stay longer. */
const AUTO_HIDE_MS = { info: 6000, error: 12000 };
const BUBBLE_WIDTH = 288;
const BUBBLE_GAP = 12;

interface Bubble {
  /** What was heard, and whether it is still being heard or was heard. */
  heard?: string;
  heardLabel: string;
  text: string;
  tone: "info" | "error";
  /** Something is still going on (listening, or a request running), so it can't be dismissed. */
  busy: boolean;
}

/**
 * The AI menu: a floating round button on the board. Tap it and Solve, Graph, Check and Speak fan
 * out around it; drag it to move it anywhere. While a request runs, a ring spins around the
 * button in the action's color; while listening the button turns red and a tap on it stops. A
 * small bubble beside the button says what is happening, what was heard, and any message.
 */
export function AiMenu({ ai, voice, onSolve, onGraph, onCheck, onVoiceToggle }: AiMenuProps) {
  const [open, setOpen] = useState(false);
  // The name of the button under the pointer (or focused), shown in the hub.
  const [hint, setHint] = useState<string | null>(null);
  // Messages that have been dismissed (or faded, or are old news), so the bubble leaves them out.
  const [hiddenAi, setHiddenAi] = useState<AiStatus | null>(null);
  const [hiddenVoice, setHiddenVoice] = useState<VoiceStatus | null>(null);
  const [prevAi, setPrevAi] = useState(ai);
  const reducedMotion = usePrefersReducedMotion();
  const menuId = useId();

  const menuRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLButtonElement>(null);
  // Set when the menu is opened from the keyboard, so focus moves into it.
  const focusOnOpenRef = useRef(false);

  const listening = voice.state === "listening";
  const working = ai.state === "loading" ? ai.action : null;

  // A request just finished and its answer is on the board, so whatever was said to start it
  // ("solve this") is done too.
  if (prevAi !== ai) {
    setPrevAi(ai);
    if (prevAi.state === "loading" && ai.state === "idle") setHiddenVoice(voice);
  }

  // The hub starts at the bottom middle, away from the corner where Next.js shows its dev-mode
  // badge (bottom left).
  const hub = useFloatingHub({ initialPlace: { x: 0.5, y: 1 }, open, extent: EXTENT });

  useEffect(() => {
    if (!open || !focusOnOpenRef.current) return;
    focusOnOpenRef.current = false;
    menuRef.current?.querySelector<HTMLElement>("[data-item]:not(:disabled)")?.focus();
  }, [open]);

  const close = () => {
    // Don't leave focus on a button that is about to be hidden.
    const focused = document.activeElement;
    if (focused !== hubRef.current && menuRef.current?.contains(focused)) {
      hubRef.current?.focus();
    }
    setOpen(false);
    setHint(null);
  };

  const handleEscape = useEffectEvent(() => close());
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      handleEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const dismissMessages = () => {
    setHiddenAi(ai);
    setHiddenVoice(voice);
  };

  const press = (item: AiItem) => {
    if (item !== "speak" && working) return; // one request at a time
    close();
    if (item === "speak") {
      onVoiceToggle();
      return;
    }
    // A new request: the last message, and anything said before it, are old news.
    dismissMessages();
    ({ solve: onSolve, graph: onGraph, check: onCheck })[item]();
  };

  // A tap on the hub opens or closes the menu (or, while listening, stops); a drag moves it.
  const handleHubClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (hub.clickEndsDrag()) return;
    if (open) {
      close();
      return;
    }
    if (listening) {
      onVoiceToggle();
      return;
    }
    // A click with no pointer behind it came from the keyboard (Enter or Space).
    focusOnOpenRef.current = e.detail === 0;
    setOpen(true);
  };

  // Show a button's name in the hub while it is pointed at or focused.
  const hintFor = (label: string) => ({
    onPointerEnter: () => setHint(label),
    onPointerLeave: () => setHint((current) => (current === label ? null : current)),
    onFocus: () => setHint(label),
    onBlur: () => setHint((current) => (current === label ? null : current)),
  });

  // What the bubble beside the hub says.
  const voiceMessage = voice.state === "message" && voice !== hiddenVoice ? voice : null;
  const aiMessage = ai.state === "message" && ai !== hiddenAi ? ai : null;
  let bubble: Bubble | null = null;
  if (voice.state === "listening") {
    bubble = {
      heard: voice.heard,
      heardLabel: "Hearing",
      text: "Listening. Say what you want, or tap the red button to stop.",
      tone: "info",
      busy: true,
    };
  } else if (working) {
    bubble = {
      heard: voiceMessage?.heard,
      heardLabel: "Heard",
      text: LOADING_TEXT[working],
      tone: "info",
      busy: true,
    };
  } else if (aiMessage) {
    bubble = {
      heard: voiceMessage?.heard,
      heardLabel: "Heard",
      text: aiMessage.text,
      tone: aiMessage.tone,
      busy: false,
    };
  } else if (voiceMessage) {
    bubble = {
      heard: voiceMessage.heard,
      heardLabel: "Heard",
      text: voiceMessage.text,
      tone: voiceMessage.tone,
      busy: false,
    };
  }

  // A message fades on its own after a while.
  const messageTone = bubble && !bubble.busy ? bubble.tone : null;
  useEffect(() => {
    if (!messageTone) return;
    const timer = window.setTimeout(() => {
      setHiddenAi(ai);
      setHiddenVoice(voice);
    }, AUTO_HIDE_MS[messageTone]);
    return () => window.clearTimeout(timer);
  }, [messageTone, ai, voice]);

  const hubLabel = open
    ? "Close AI menu"
    : listening
      ? "Stop listening"
      : working
        ? `AI menu (${WORKING[working].doing})`
        : "AI menu: solve, graph, check or speak";
  const showHint = open && hint !== null;
  const WorkingIcon = working ? WORKING[working].Icon : SparklesIcon;

  // The bubble sits above the hub (or below it, when the hub is in the top half of the board).
  const board = hub.board;
  let bubbleStyle: CSSProperties | undefined;
  if (board) {
    const width = Math.min(BUBBLE_WIDTH, board.width - 2 * BUBBLE_GAP);
    const left = Math.min(
      Math.max(BUBBLE_GAP, hub.rest.x - width / 2),
      board.width - width - BUBBLE_GAP,
    );
    const above = hub.rest.y > board.height / 2;
    bubbleStyle = {
      left,
      width,
      ...(above
        ? { bottom: board.height - (hub.rest.y - HUB_SIZE / 2 - BUBBLE_GAP) }
        : { top: hub.rest.y + HUB_SIZE / 2 + BUBBLE_GAP }),
    };
  }

  const statusBubble = (
    // A live region that is always there, so screen readers announce what appears in it.
    <div role="status" aria-live="polite" className="pointer-events-none absolute inset-0">
      {bubble && !open && bubbleStyle && (
        <div
          className={`pointer-events-auto absolute rounded-2xl bg-white/95 px-4 py-3 text-sm shadow-lg ring-1 backdrop-blur-sm transition-[opacity,translate] duration-200 starting:translate-y-1 starting:opacity-0 ${
            bubble.tone === "error" ? "ring-red-200" : "ring-black/10"
          } ${bubble.busy ? "" : "pr-10"}`}
          style={bubbleStyle}
        >
          {bubble.heard && (
            <p className="mb-1 italic text-neutral-800">
              {bubble.heardLabel}: “{bubble.heard}”
            </p>
          )}
          <p className={bubble.tone === "error" ? "text-red-700" : "text-neutral-600"}>
            {bubble.text}
          </p>
          {!bubble.busy && (
            <button
              type="button"
              aria-label="Dismiss message"
              onClick={dismissMessages}
              className={`absolute right-1.5 top-1.5 grid size-8 place-items-center rounded-full text-xl leading-none text-neutral-500 transition-colors hover:bg-neutral-100 ${focusRing}`}
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <RadialFrame
      hub={hub}
      open={open}
      onClose={close}
      reducedMotion={reducedMotion}
      anchorRef={menuRef}
      outside={statusBubble}
    >
      <MenuDisc open={open} radius={DISC_RADIUS} reducedMotion={reducedMotion} />

      <div
        role="menu"
        id={menuId}
        aria-label="AI"
        data-ring="ai"
        inert={!open}
        className="absolute left-0 top-0"
      >
        {ORDER.map((item, index) => {
          const { label, Icon, tint, filled } = ITEMS[item];
          // The action that is running shows filled in its color; the others wait their turn.
          const running = item !== "speak" && working === item;
          const waiting = item !== "speak" && working !== null && !running;
          return (
            <Orbit
              key={item}
              shown={open}
              angle={ANGLES[item]}
              radius={RING_RADIUS}
              fromAngle={ANGLES[item] - 60}
              fromRadius={0}
              size={ITEM_SIZE}
              index={index}
              count={ORDER.length}
              reducedMotion={reducedMotion}
            >
              <button
                type="button"
                role="menuitem"
                aria-label={running ? `${label} (working)` : label}
                aria-disabled={running || undefined}
                disabled={waiting}
                data-item={item}
                onClick={() => press(item)}
                className={`${itemBase(open)} ${
                  running ? filled : "bg-white text-neutral-700 ring-1 ring-black/10 hover:bg-neutral-50"
                }`}
                {...hintFor(label)}
              >
                <span aria-hidden="true" className={running ? "" : tint}>
                  <Icon size={22} />
                </span>
                <span className="text-[10px] font-semibold leading-none">{label}</span>
              </button>
            </Orbit>
          );
        })}
      </div>

      {/* The hub, on top of everything. */}
      <button
        ref={hubRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={hubLabel}
        title={
          open
            ? undefined
            : listening
              ? "Tap to stop listening"
              : "AI: solve, graph, check, speak (drag to move)"
        }
        onClick={handleHubClick}
        {...hub.hubPointerHandlers}
        className={`pointer-events-auto absolute left-0 top-0 touch-none select-none rounded-full shadow-lg ring-1 transition-[scale,box-shadow,background-color,color] duration-150 ${focusRing} ${
          listening && !open
            ? "bg-red-600 text-white ring-red-600 motion-safe:animate-pulse"
            : "bg-white text-neutral-800 ring-black/10"
        } ${
          hub.dragging ? "scale-110 cursor-grabbing shadow-2xl" : "cursor-pointer hover:scale-105 active:scale-95"
        }`}
        style={{ width: HUB_SIZE, height: HUB_SIZE, transform: "translate(-50%, -50%)" }}
      >
        {/* While a request runs, a ring spins around the hub in the action's color. */}
        {working && (
          <svg
            aria-hidden="true"
            viewBox="0 0 74 74"
            className={`pointer-events-none absolute -left-[5px] -top-[5px] motion-safe:animate-spin ${WORKING[working].color}`}
            style={{ width: HUB_SIZE + 10, height: HUB_SIZE + 10 }}
          >
            <circle cx="37" cy="37" r="35" fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={3} />
            <circle
              cx="37"
              cy="37"
              r="35"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeDasharray="56 164"
            />
          </svg>
        )}
        <span
          aria-hidden="true"
          className={`absolute inset-0 grid place-items-center ${
            working && !listening ? WORKING[working].color : ""
          }`}
          style={hubSwap(!open, 90, reducedMotion)}
        >
          {listening ? <MicIcon size={28} /> : <WorkingIcon size={28} />}
        </span>
        <span
          aria-hidden="true"
          className="absolute inset-0 grid place-items-center"
          style={hubSwap(open && !showHint, -90, reducedMotion)}
        >
          <CloseIcon size={26} />
        </span>
        {showHint && (
          <span
            aria-hidden="true"
            className="absolute inset-1 grid place-items-center text-center text-[11px] font-semibold leading-tight text-neutral-900"
          >
            {hint}
          </span>
        )}
      </button>
    </RadialFrame>
  );
}
