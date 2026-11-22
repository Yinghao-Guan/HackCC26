"use client";

import type { GraphCardData } from "./board";
import { CURVE_COLORS, FunctionPlot } from "./FunctionPlot";
import { Latex } from "./Latex";
import { GRAPH_CARD_WIDTH, GRAPH_PLOT_SIZE } from "./layout";

interface GraphCardProps {
  card: GraphCardData;
  onDismiss: () => void;
}

/** A graph of the equations on the board, drawn next to them with a color key. */
export function GraphCard({ card, onDismiss }: GraphCardProps) {
  return (
    // The card lets pointer events through, so you can keep writing around and
    // over it. Only the dismiss button takes clicks.
    <div
      className="pointer-events-none absolute rounded-2xl border-2 border-neutral-900 bg-white/95 p-5 shadow-lg"
      style={{ left: card.x, top: card.y, width: GRAPH_CARD_WIDTH }}
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss graph"
        className="pointer-events-auto absolute right-2 top-2 grid size-10 place-items-center rounded-full text-2xl leading-none text-neutral-500 transition-colors hover:bg-neutral-100"
      >
        ×
      </button>

      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Graph</p>
      <FunctionPlot curves={card.curves} window={card.window} size={GRAPH_PLOT_SIZE} />

      <ul className="mt-3 flex flex-col gap-1">
        {card.curves.map((curve, index) => (
          <li key={index} className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="h-1.5 w-8 shrink-0 rounded-full"
              style={{ backgroundColor: CURVE_COLORS[index % CURVE_COLORS.length] }}
            />
            <Latex source={curve.label} className="text-lg" />
          </li>
        ))}
      </ul>
    </div>
  );
}
