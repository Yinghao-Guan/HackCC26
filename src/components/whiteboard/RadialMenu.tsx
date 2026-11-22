"use client";

import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  BoardIcon,
  CloseIcon,
  EraserIcon,
  MoveIcon,
  PenIcon,
  PlusIcon,
  ResetViewIcon,
  TextIcon,
  TrashIcon,
  UndoIcon,
} from "./icons";
import {
  arcFraction,
  arcPath,
  DISC_RADIUS,
  HUB_SIZE,
  ITEM_SIZE,
  MAIN_ANGLES,
  MAIN_ORDER,
  menuExtent,
  previewDiameter,
  RING_RADIUS,
  SIZE_ARC,
  sizeAtFraction,
  sizeFraction,
  SUB_BAND_WIDTH,
  SUB_ITEM_SIZE,
  SUB_RING_RADIUS,
  subAngles,
  taperedArcPath,
  type ButtonRing,
  type MainItem,
  type SubMenu,
} from "./radialGeometry";
import {
  EASE_IN,
  focusRing,
  GLIDE,
  hubSwap,
  itemClass,
  MenuDisc,
  Orbit,
  polarTransform,
  RadialFrame,
  SPRING,
  useFloatingHub,
  usePrefersReducedMotion,
} from "./radialKit";
import {
  COLORS,
  SIZE_LIMITS,
  sizeOf,
  type EraserMode,
  type SizedTool,
  type Tool,
  type WhiteboardSettings,
} from "./settings";
import { TEXT_FONT_FAMILY } from "./text";

interface RadialMenuProps {
  settings: WhiteboardSettings;
  onSettingsChange: (patch: Partial<WhiteboardSettings>) => void;
  canUndo: boolean;
  canClear: boolean;
  canResetView: boolean;
  onUndo: () => void;
  onClear: () => void;
  onResetView: () => void;
}

const TOOL_LABELS: Record<Tool, string> = {
  pen: "Pen",
  eraser: "Eraser",
  text: "Text",
  move: "Move",
};

const TOOL_ICONS: Record<Tool, (props: { size?: number }) => ReactNode> = {
  pen: PenIcon,
  eraser: EraserIcon,
  text: TextIcon,
  move: MoveIcon,
};

const ERASER_MODES: { value: EraserMode; label: string; hint: string }[] = [
  { value: "pixel", label: "Pixel", hint: "Pixel eraser" },
  { value: "stroke", label: "Stroke", hint: "Stroke eraser" },
];

const SIZE_LABELS: Record<SizedTool, string> = {
  pen: "Pen size",
  eraser: "Eraser size",
  text: "Text size",
};

const RAINBOW =
  "conic-gradient(#ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ec4899, #ef4444)";
/** What the custom color picker starts on when the current color is one of the presets. */
const CUSTOM_START = "#7c3aed";

/** Where the buttons of each button ring sit. */
const SUB_ANGLES: Record<ButtonRing, number[]> = {
  eraser: subAngles("eraser", ERASER_MODES.length),
  board: subAngles("board", 2), // clear, reset view
  color: subAngles("color", COLORS.length + 1), // the presets, then a custom color
};

/** Each outer ring's span (first to last direction), for its band and for keeping it on the board. */
const SUB_SPANS: Record<SubMenu, readonly [number, number]> = {
  eraser: [SUB_ANGLES.eraser[0], SUB_ANGLES.eraser[SUB_ANGLES.eraser.length - 1]],
  board: [SUB_ANGLES.board[0], SUB_ANGLES.board[SUB_ANGLES.board.length - 1]],
  color: [SUB_ANGLES.color[0], SUB_ANGLES.color[SUB_ANGLES.color.length - 1]],
  size: [SIZE_ARC.from, SIZE_ARC.to],
};
const SUB_MENUS: SubMenu[] = ["eraser", "board", "size", "color"];

// The bands behind the outer rings, and the size slider, are drawn in SVGs centered on the menu.
const BAND_BOX = 2 * (SUB_RING_RADIUS + SUB_BAND_WIDTH);
const BAND_CENTER = BAND_BOX / 2;
const BAND_PATHS = Object.fromEntries(
  SUB_MENUS.map((sub) => {
    const [from, to] = SUB_SPANS[sub];
    return [sub, arcPath(BAND_CENTER, BAND_CENTER, SUB_RING_RADIUS, from, to)];
  }),
) as Record<SubMenu, string>;

// The size slider's track gets thicker from the small end to the big end.
const TRACK_THIN = 3;
const TRACK_THICK = 12;
const trackHalfWidth = (angle: number) =>
  TRACK_THIN +
  ((angle - SIZE_ARC.from) / (SIZE_ARC.to - SIZE_ARC.from)) * (TRACK_THICK - TRACK_THIN);
const TRACK_PATH = taperedArcPath(
  BAND_CENTER,
  BAND_CENTER,
  SUB_RING_RADIUS,
  SIZE_ARC.from,
  SIZE_ARC.to,
  trackHalfWidth,
);
const THUMB_SIZE = 44;

/** A dot (or letter) that shows how big a size is. */
function SizePreview({
  tool,
  diameter,
  color,
}: {
  tool: SizedTool;
  diameter: number;
  color: string;
}) {
  if (tool === "text") {
    return (
      <span
        aria-hidden="true"
        className="font-semibold leading-none"
        style={{ fontFamily: TEXT_FONT_FAMILY, fontSize: diameter, color }}
      >
        A
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`block shrink-0 rounded-full ${
        tool === "eraser" ? "border-[1.5px] border-dashed border-neutral-500" : ""
      }`}
      style={{
        width: diameter,
        height: diameter,
        backgroundColor: tool === "pen" ? color : undefined,
      }}
    />
  );
}

/**
 * The tool menu: a floating round button on the board. Tap it and eight buttons fan out around
 * it in a circle: pen, eraser, text and move, undo, board actions (clear, reset view), size and
 * color. Some open an outer ring: color swatches, a curved size slider, eraser types or the
 * board actions. It can be dragged anywhere on the board; when it is near an edge, the open menu
 * slides in just far enough to fit.
 */
export function RadialMenu({
  settings,
  onSettingsChange,
  canUndo,
  canClear,
  canResetView,
  onUndo,
  onClear,
  onResetView,
}: RadialMenuProps) {
  const { tool, color, eraserMode } = settings;
  const sizedTool: SizedTool | null = tool === "move" ? null : tool;
  const size = sizeOf(settings);

  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<SubMenu | null>(null);
  // The name of the item under the pointer (or focused), shown in the hub.
  const [hint, setHint] = useState<string | null>(null);
  // True while the size slider is being dragged.
  const [sliding, setSliding] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const menuId = useId();

  const menuRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLButtonElement>(null);
  const slidePointerRef = useRef<number | null>(null);
  // Set when a ring is opened from the keyboard, so focus moves into it once it is showing.
  const focusRingRef = useRef<"main" | SubMenu | null>(null);

  // An outer ring with nothing to do closes: no size for the Move tool, and no board actions
  // when the board is empty and already at its starting view.
  const boardHasActions = canClear || canResetView;
  const activeSub =
    (sub === "size" && !sizedTool) || (sub === "board" && !boardHasActions) ? null : sub;
  const sizeShown = open && activeSub === "size";

  // The hub starts at the bottom right.
  const hub = useFloatingHub({
    initialPlace: { x: 1, y: 1 },
    open,
    extent: menuExtent(DISC_RADIUS, activeSub ? SUB_SPANS[activeSub] : null),
  });

  // A ring opened from the keyboard: focus its current value, or else its first item.
  useEffect(() => {
    const ring = focusRingRef.current;
    if (!ring || !open || (ring !== "main" && activeSub !== ring)) return;
    focusRingRef.current = null;
    const container = menuRef.current?.querySelector(`[data-ring="${ring}"]`);
    const target =
      container?.querySelector<HTMLElement>('[data-item][aria-checked="true"]') ??
      container?.querySelector<HTMLElement>("[data-item]:not(:disabled)");
    target?.focus();
  }, [open, activeSub]);

  const close = () => {
    // Don't leave focus on a button that is about to be hidden.
    const focused = document.activeElement;
    if (focused !== hubRef.current && menuRef.current?.contains(focused)) {
      hubRef.current?.focus();
    }
    setOpen(false);
    setSub(null);
    setHint(null);
  };

  // Esc closes the outer ring, then the menu.
  const handleEscape = useEffectEvent(() => {
    if (!activeSub) {
      close();
      return;
    }
    const menu = menuRef.current;
    if (menu?.querySelector(`[data-ring="${activeSub}"]`)?.contains(document.activeElement)) {
      menu.querySelector<HTMLElement>(`[data-item="${activeSub}"]`)?.focus();
    }
    setSub(null);
    setHint(null);
  });
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

  const toggleSub = (next: SubMenu, fromKeyboard: boolean) => {
    const opening = activeSub !== next;
    focusRingRef.current = opening && fromKeyboard ? next : null;
    setSub(opening ? next : null);
    setHint(null);
  };

  const pickTool = (next: Tool) => {
    onSettingsChange({ tool: next });
    close();
  };

  // Tap the eraser to pick it (one tap, then erase); tap it again while picked for its type.
  const pressEraser = (fromKeyboard: boolean) => {
    if (tool === "eraser") {
      toggleSub("eraser", fromKeyboard);
    } else {
      onSettingsChange({ tool: "eraser" });
      close();
    }
  };

  const pickEraserMode = (mode: EraserMode) => {
    onSettingsChange({ tool: "eraser", eraserMode: mode });
    close();
  };

  // A color keeps the text tool, and otherwise switches to the pen (you pick a color to draw with it).
  const colorPatch = (value: string): Partial<WhiteboardSettings> =>
    tool === "text" ? { color: value } : { tool: "pen", color: value };

  const pickColor = (value: string) => {
    onSettingsChange(colorPatch(value));
    close();
  };

  /** Set the current tool's size. */
  const setSize = (value: number) => {
    if (!sizedTool) return;
    const { min, max } = SIZE_LIMITS[sizedTool];
    const next = Math.min(max, Math.max(min, Math.round(value)));
    if (next === size) return;
    if (sizedTool === "pen") onSettingsChange({ penSize: next });
    else if (sizedTool === "eraser") onSettingsChange({ eraserSize: next });
    else onSettingsChange({ textSize: next });
  };

  // The size slider: the size follows the pointer's direction from the menu's center, so a drag
  // along the arc (or a tap anywhere on it) sets it.
  const sizeFromPointer = (clientX: number, clientY: number) => {
    const center = menuRef.current?.getBoundingClientRect();
    if (!center || !sizedTool) return;
    const angle = (Math.atan2(clientY - center.top, clientX - center.left) * 180) / Math.PI;
    setSize(sizeAtFraction(sizedTool, arcFraction(angle, SIZE_ARC.from, SIZE_ARC.to)));
  };

  const handleSliderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !sizeShown) return;
    e.preventDefault(); // no text selection or focus change; focus the slider ourselves
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    slidePointerRef.current = e.pointerId;
    setSliding(true);
    sizeFromPointer(e.clientX, e.clientY);
  };

  const handleSliderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (slidePointerRef.current !== e.pointerId) return;
    sizeFromPointer(e.clientX, e.clientY);
  };

  const finishSlide = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (slidePointerRef.current !== e.pointerId) return;
    slidePointerRef.current = null;
    setSliding(false);
  };

  // Arrow keys nudge the size by 1 px, Page Up/Down by a tenth of the range, Home/End jump to
  // the ends, and Enter is done.
  const handleSliderKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!sizedTool) return;
    const { min, max } = SIZE_LIMITS[sizedTool];
    const big = Math.max(2, Math.round((max - min) / 10));
    const steps: Record<string, number> = {
      ArrowRight: size + 1,
      ArrowUp: size + 1,
      ArrowLeft: size - 1,
      ArrowDown: size - 1,
      PageUp: size + big,
      PageDown: size - big,
      Home: min,
      End: max,
    };
    if (e.key === "Enter") {
      e.preventDefault();
      close();
      return;
    }
    if (!(e.key in steps)) return;
    e.preventDefault();
    e.stopPropagation(); // the arrows belong to the slider here, not to moving around the ring
    setSize(steps[e.key]);
  };

  // Show an item's name in the hub while it is pointed at or focused.
  const hintFor = (label: string) => ({
    onPointerEnter: () => setHint(label),
    onPointerLeave: () => setHint((current) => (current === label ? null : current)),
    onFocus: () => setHint(label),
    onBlur: () => setHint((current) => (current === label ? null : current)),
  });

  // A tap on the hub opens or closes the menu; a drag moves it.
  const handleHubClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (hub.clickEndsDrag()) return;
    if (open) {
      close();
      return;
    }
    // A click with no pointer behind it came from the keyboard (Enter or Space).
    focusRingRef.current = e.detail === 0 ? "main" : null;
    setOpen(true);
  };

  const colorName = COLORS.find((c) => c.value === color)?.name;
  const isCustomColor = colorName === undefined;
  const ToolIcon = TOOL_ICONS[tool];
  const hubSummary = [
    tool === "eraser" ? `${TOOL_LABELS[tool]} (${eraserMode})` : TOOL_LABELS[tool],
    colorName ?? `custom color ${color}`,
    sizedTool ? `${size} px` : null,
  ]
    .filter(Boolean)
    .join(", ");

  // While the size slider is out, the hub shows the size as it changes.
  const showSizeReadout = sizeShown && sizedTool !== null;
  const showHint = open && !showSizeReadout && hint !== null;

  const mainOrbit = (item: MainItem, index: number) => ({
    shown: open,
    angle: MAIN_ANGLES[item],
    radius: RING_RADIUS,
    fromAngle: MAIN_ANGLES[item] - 60,
    fromRadius: 0,
    size: ITEM_SIZE,
    index,
    count: MAIN_ORDER.length,
    reducedMotion,
  });

  const subOrbit = (ring: ButtonRing, index: number) => ({
    shown: open && activeSub === ring,
    angle: SUB_ANGLES[ring][index],
    radius: SUB_RING_RADIUS,
    fromAngle: MAIN_ANGLES[ring],
    fromRadius: RING_RADIUS,
    size: SUB_ITEM_SIZE,
    index,
    count: SUB_ANGLES[ring].length,
    reducedMotion,
  });

  const renderMainItem = (item: MainItem, index: number) => {
    const orbit = mainOrbit(item, index);

    if (item === "eraser") {
      const selected = tool === "eraser";
      return (
        <Orbit key={item} {...orbit}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            aria-label={selected ? `Eraser (${eraserMode}), press again to change type` : "Eraser"}
            data-item={item}
            onClick={(e) => pressEraser(e.detail === 0)}
            className={itemClass(open, activeSub === "eraser" ? "open" : selected ? "selected" : "plain")}
            {...hintFor(selected ? "Eraser type" : "Eraser")}
          >
            <EraserIcon size={selected ? 20 : 24} />
            {selected && (
              <span className="text-[9px] font-semibold uppercase leading-none tracking-wide">
                {eraserMode}
              </span>
            )}
          </button>
        </Orbit>
      );
    }

    if (item === "undo") {
      // Undo leaves the menu open, so it can be tapped again and again.
      return (
        <Orbit key={item} {...orbit}>
          <button
            type="button"
            role="menuitem"
            aria-label="Undo"
            data-item={item}
            disabled={!canUndo}
            onClick={onUndo}
            className={itemClass(open, "plain")}
            {...hintFor("Undo")}
          >
            <UndoIcon size={24} />
          </button>
        </Orbit>
      );
    }

    if (item === "board") {
      return (
        <Orbit key={item} {...orbit}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeSub === "board"}
            aria-controls={`${menuId}-board`}
            aria-label="Board: clear or reset view"
            data-item={item}
            disabled={!boardHasActions}
            onClick={(e) => toggleSub("board", e.detail === 0)}
            className={itemClass(open, activeSub === "board" ? "open" : "plain")}
            {...hintFor("Board")}
          >
            <BoardIcon size={24} />
          </button>
        </Orbit>
      );
    }

    if (item === "color") {
      return (
        <Orbit key={item} {...orbit}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeSub === "color"}
            aria-controls={`${menuId}-color`}
            aria-label={`Color: ${colorName ?? color}`}
            data-item={item}
            onClick={(e) => toggleSub("color", e.detail === 0)}
            className={itemClass(open, activeSub === "color" ? "open" : "plain")}
            {...hintFor("Color")}
          >
            <span
              aria-hidden="true"
              className="grid size-8 place-items-center rounded-full"
              style={{ background: RAINBOW }}
            >
              <span
                className="size-5 rounded-full border-2 border-white"
                style={{ backgroundColor: color }}
              />
            </span>
          </button>
        </Orbit>
      );
    }

    if (item === "size") {
      return (
        <Orbit key={item} {...orbit}>
          <button
            type="button"
            role="menuitem"
            aria-expanded={activeSub === "size"}
            aria-controls={`${menuId}-size`}
            aria-label={sizedTool ? `${SIZE_LABELS[sizedTool]}: ${size} px` : "Size (Move has none)"}
            data-item={item}
            disabled={!sizedTool}
            onClick={(e) => toggleSub("size", e.detail === 0)}
            className={itemClass(open, activeSub === "size" ? "open" : "plain")}
            {...hintFor(sizedTool ? SIZE_LABELS[sizedTool] : "Size")}
          >
            {sizedTool ? (
              <SizePreview
                tool={sizedTool}
                diameter={previewDiameter(sizedTool, size, sizedTool === "text" ? 13 : 5, 24)}
                color={color}
              />
            ) : (
              <span aria-hidden="true" className="size-3 rounded-full bg-neutral-400" />
            )}
          </button>
        </Orbit>
      );
    }

    // Pen, text and move.
    const Icon = TOOL_ICONS[item];
    return (
      <Orbit key={item} {...orbit}>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={tool === item}
          aria-label={TOOL_LABELS[item]}
          data-item={item}
          onClick={() => pickTool(item)}
          className={itemClass(open, tool === item ? "selected" : "plain")}
          {...hintFor(TOOL_LABELS[item])}
        >
          <Icon size={24} />
        </button>
      </Orbit>
    );
  };

  // The slider shows the current tool's size (or the pen's, while hidden for the Move tool).
  const sliderTool: SizedTool = sizedTool ?? "pen";
  const sliderSize = sizedTool ? size : settings.penSize;
  const sliderLimits = SIZE_LIMITS[sliderTool];
  const thumbAngle =
    SIZE_ARC.from + sizeFraction(sliderTool, sliderSize) * (SIZE_ARC.to - SIZE_ARC.from);
  const filledTrack = taperedArcPath(
    BAND_CENTER,
    BAND_CENTER,
    SUB_RING_RADIUS,
    SIZE_ARC.from,
    thumbAngle,
    trackHalfWidth,
  );

  return (
    <RadialFrame
      hub={hub}
      open={open}
      onClose={close}
      reducedMotion={reducedMotion}
      anchorRef={menuRef}
    >
      <MenuDisc open={open} radius={DISC_RADIUS} reducedMotion={reducedMotion} />

      {/* The band behind an outer ring. It sweeps out both ways from the item that opened it. */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 overflow-visible"
        width={BAND_BOX}
        height={BAND_BOX}
        style={{
          transform: "translate(-50%, -50%)",
          filter: "drop-shadow(0 6px 14px rgb(0 0 0 / 0.12))",
        }}
      >
        {SUB_MENUS.map((ring) => {
          const shown = open && activeSub === ring;
          const length = shown ? 1 : 0;
          const sweep: CSSProperties = {
            strokeDasharray: `${length} 2`,
            strokeDashoffset: -(1 - length) / 2,
            transition: reducedMotion
              ? "none"
              : `stroke-dasharray 320ms ${GLIDE}, stroke-dashoffset 320ms ${GLIDE}`,
            pointerEvents: shown ? "stroke" : "none",
          };
          return (
            <g
              key={ring}
              onPointerDown={(e) => e.preventDefault()}
              style={{
                opacity: shown ? 1 : 0,
                transition: reducedMotion ? "none" : `opacity ${shown ? 120 : 220}ms ease-out`,
              }}
            >
              <path
                d={BAND_PATHS[ring]}
                pathLength={1}
                fill="none"
                stroke="rgb(0 0 0 / 0.07)"
                strokeWidth={SUB_BAND_WIDTH + 2}
                strokeLinecap="round"
                style={sweep}
              />
              <path
                d={BAND_PATHS[ring]}
                pathLength={1}
                fill="none"
                stroke="rgb(255 255 255 / 0.94)"
                strokeWidth={SUB_BAND_WIDTH}
                strokeLinecap="round"
                style={sweep}
              />
            </g>
          );
        })}
      </svg>

      {/* Main ring. */}
      <div
        role="menu"
        id={menuId}
        aria-label="Tools"
        data-ring="main"
        inert={!open}
        className="absolute left-0 top-0"
      >
        {MAIN_ORDER.map(renderMainItem)}
      </div>

      {/* Outer ring: eraser type. */}
      <div
        role="menu"
        id={`${menuId}-eraser`}
        aria-label="Eraser type"
        data-ring="eraser"
        inert={!(open && activeSub === "eraser")}
        className="absolute left-0 top-0"
      >
        {ERASER_MODES.map((mode, index) => {
          const shown = open && activeSub === "eraser";
          const chosen = eraserMode === mode.value;
          return (
            <Orbit key={mode.value} {...subOrbit("eraser", index)}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={chosen}
                aria-label={mode.hint}
                data-item={`eraser-${mode.value}`}
                onClick={() => pickEraserMode(mode.value)}
                className={`${itemClass(shown, chosen ? "chosen" : "plain")} text-xs font-semibold`}
                {...hintFor(mode.hint)}
              >
                {mode.label}
              </button>
            </Orbit>
          );
        })}
      </div>

      {/* Outer ring: board actions. Clear can be undone, so it doesn't ask first. */}
      <div
        role="menu"
        id={`${menuId}-board`}
        aria-label="Board"
        data-ring="board"
        inert={!(open && activeSub === "board")}
        className="absolute left-0 top-0"
      >
        <Orbit {...subOrbit("board", 0)}>
          <button
            type="button"
            role="menuitem"
            aria-label="Clear the board"
            data-item="board-clear"
            disabled={!canClear}
            onClick={() => {
              onClear();
              close();
            }}
            className={itemClass(open && activeSub === "board", "danger")}
            {...hintFor("Clear board")}
          >
            <TrashIcon size={22} />
          </button>
        </Orbit>
        <Orbit {...subOrbit("board", 1)}>
          <button
            type="button"
            role="menuitem"
            aria-label="Reset view"
            data-item="board-reset"
            disabled={!canResetView}
            onClick={() => {
              onResetView();
              close();
            }}
            className={itemClass(open && activeSub === "board", "plain")}
            {...hintFor("Reset view")}
          >
            <ResetViewIcon size={22} />
          </button>
        </Orbit>
      </div>

      {/* Outer ring: the size slider, a curved track from small (bottom) to big (top). */}
      <div
        role="group"
        id={`${menuId}-size`}
        aria-label={SIZE_LABELS[sliderTool]}
        data-ring="size"
        inert={!sizeShown}
        className="absolute left-0 top-0"
      >
        <div
          role="slider"
          tabIndex={0}
          aria-label={SIZE_LABELS[sliderTool]}
          aria-valuemin={sliderLimits.min}
          aria-valuemax={sliderLimits.max}
          aria-valuenow={sliderSize}
          aria-valuetext={`${sliderSize} px`}
          data-item="size-slider"
          className="group absolute left-0 top-0 outline-none"
          onPointerDown={handleSliderPointerDown}
          onPointerMove={handleSliderPointerMove}
          onPointerUp={finishSlide}
          onPointerCancel={finishSlide}
          onKeyDown={handleSliderKeyDown}
        >
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            width={BAND_BOX}
            height={BAND_BOX}
            style={{
              transform: "translate(-50%, -50%)",
              opacity: sizeShown ? 1 : 0,
              transition: reducedMotion
                ? "none"
                : sizeShown
                  ? "opacity 200ms ease-out 120ms"
                  : "opacity 120ms ease-in",
            }}
          >
            <path d={TRACK_PATH} fill="rgb(0 0 0 / 0.1)" />
            <path d={filledTrack} fill="#262626" />
            {/* Catches taps and drags anywhere on the band. */}
            <path
              d={BAND_PATHS.size}
              fill="none"
              stroke="transparent"
              strokeWidth={SUB_BAND_WIDTH}
              strokeLinecap="round"
              style={{ pointerEvents: sizeShown ? "stroke" : "none", cursor: "pointer" }}
            />
          </svg>
          <div
            aria-hidden="true"
            className={`absolute left-0 top-0 grid place-items-center rounded-full bg-white shadow-lg ring-1 ring-black/15 group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-neutral-900 ${
              sizeShown ? "pointer-events-auto" : "pointer-events-none"
            } ${sliding ? "cursor-grabbing" : "cursor-grab"}`}
            style={{
              width: THUMB_SIZE,
              height: THUMB_SIZE,
              transform: sizeShown
                ? polarTransform(thumbAngle, SUB_RING_RADIUS, 1)
                : polarTransform(MAIN_ANGLES.size, RING_RADIUS, 0.4),
              opacity: sizeShown ? 1 : 0,
              // Follows the finger exactly while dragging; glides for taps and keys.
              transition: reducedMotion
                ? "none"
                : sliding
                  ? "opacity 150ms ease-out"
                  : sizeShown
                    ? `transform 300ms ${SPRING}, opacity 160ms ease-out`
                    : `transform 180ms ${EASE_IN}, opacity 150ms ease-in`,
            }}
          >
            <SizePreview
              tool={sliderTool}
              diameter={previewDiameter(sliderTool, sliderSize, sliderTool === "text" ? 12 : 4, 28)}
              color={color}
            />
          </div>
        </div>
      </div>

      {/* Outer ring: colors, then a custom color. */}
      <div
        role="menu"
        id={`${menuId}-color`}
        aria-label="Colors"
        data-ring="color"
        inert={!(open && activeSub === "color")}
        className="absolute left-0 top-0"
      >
        {COLORS.map(({ name, value }, index) => {
          const shown = open && activeSub === "color";
          const chosen = color === value;
          return (
            <Orbit key={value} {...subOrbit("color", index)}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={chosen}
                aria-label={name}
                data-item={`color-${index}`}
                onClick={() => pickColor(value)}
                className={`${itemClass(shown, chosen ? "chosen" : "plain")} border-[3px] border-white`}
                style={{ backgroundColor: value }}
                {...hintFor(name)}
              />
            </Orbit>
          );
        })}
        <Orbit key="custom" {...subOrbit("color", COLORS.length)}>
          {/* The native color picker, opened by tapping the rainbow swatch. Stays open while you pick. */}
          <label
            className={`relative grid size-full cursor-pointer place-items-center rounded-full border-[3px] border-white shadow-md transition-[scale] duration-150 hover:scale-110 active:scale-95 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-neutral-900 ${
              open && activeSub === "color" ? "pointer-events-auto" : "pointer-events-none"
            } ${isCustomColor ? "ring-[2.5px] ring-neutral-900" : "ring-1 ring-black/10"}`}
            style={{ background: RAINBOW }}
            onPointerEnter={() => setHint("Custom color")}
            onPointerLeave={() =>
              setHint((current) => (current === "Custom color" ? null : current))
            }
          >
            <input
              type="color"
              aria-label="Custom color"
              data-item="color-custom"
              value={isCustomColor ? color : CUSTOM_START}
              onChange={(e) => onSettingsChange(colorPatch(e.target.value))}
              onFocus={() => setHint("Custom color")}
              onBlur={() => setHint((current) => (current === "Custom color" ? null : current))}
              className="sr-only"
            />
            {isCustomColor ? (
              <span
                aria-hidden="true"
                className="size-5 rounded-full border-2 border-white"
                style={{ backgroundColor: color }}
              />
            ) : (
              <span aria-hidden="true" className="text-white drop-shadow">
                <PlusIcon size={20} />
              </span>
            )}
          </label>
        </Orbit>
      </div>

      {/* The hub, on top of everything. */}
      <button
        ref={hubRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={open ? "Close tools menu" : `Tools menu: ${hubSummary}`}
        title={open ? undefined : "Tools (drag to move)"}
        onClick={handleHubClick}
        {...hub.hubPointerHandlers}
        className={`pointer-events-auto absolute left-0 top-0 touch-none select-none rounded-full bg-white text-neutral-800 shadow-lg ring-1 ring-black/10 transition-[scale,box-shadow] duration-150 ${focusRing} ${
          hub.dragging ? "scale-110 cursor-grabbing shadow-2xl" : "cursor-pointer hover:scale-105 active:scale-95"
        }`}
        style={{ width: HUB_SIZE, height: HUB_SIZE, transform: "translate(-50%, -50%)" }}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 grid place-items-center"
          style={hubSwap(!open, 90, reducedMotion)}
        >
          <ToolIcon size={28} />
        </span>
        <span
          aria-hidden="true"
          className="absolute inset-0 grid place-items-center"
          style={hubSwap(open && !showHint && !showSizeReadout, -90, reducedMotion)}
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
        {showSizeReadout && (
          <span
            aria-hidden="true"
            className="absolute inset-0 flex flex-col items-center justify-center leading-none text-neutral-900"
          >
            <span className="text-xl font-semibold tabular-nums">{size}</span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">px</span>
          </span>
        )}
        {/* The ink color, as a small dot on the closed hub. */}
        <span
          aria-hidden="true"
          className="absolute right-0 top-0 size-[18px] rounded-full border-2 border-white shadow"
          style={{
            backgroundColor: color,
            opacity: open ? 0 : 1,
            transition: reducedMotion ? "none" : "opacity 150ms ease-out",
          }}
        />
      </button>
    </RadialFrame>
  );
}
