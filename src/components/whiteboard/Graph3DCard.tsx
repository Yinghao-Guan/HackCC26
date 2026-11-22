"use client";

import dynamic from "next/dynamic";
import type { Graph3DCardData } from "./board";
import { CURVE_COLORS } from "./FunctionPlot";
import { Latex } from "./Latex";
import { GRAPH_CARD_WIDTH, GRAPH_PLOT_SIZE } from "./layout";

// The 3D library is big, so it is only loaded when a 3D graph is actually shown.
const Plot3D = dynamic(() => import("./Plot3D"), {
  ssr: false,
  loading: () => (
    <div
      className="grid place-items-center rounded-lg border border-neutral-200 text-neutral-500"
      style={{ width: GRAPH_PLOT_SIZE, height: GRAPH_PLOT_SIZE }}
    >
      Loading 3D…
    </div>
  ),
});

interface Graph3DCardProps {
  card: Graph3DCardData;
  onDismiss: () => void;
}

/** A 3D graph of the equations on the board that you can turn around and zoom. */
export function Graph3DCard({ card, onDismiss }: Graph3DCardProps) {
  return (
    // The card lets pointer events through so you can keep writing around it. Only the
    // dismiss button and the 3D view take them.
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

      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">3D graph</p>
      <div className="pointer-events-auto">
        <Plot3D surfaces={card.surfaces} points={card.points} box={card.window} size={GRAPH_PLOT_SIZE} />
      </div>
      <p className="mt-2 text-sm text-neutral-500">
        Drag to turn it. Scroll or pinch to zoom. Right-drag or use two fingers to move it.
      </p>

      <ul className="mt-3 flex flex-col gap-1">
        {card.surfaces.map((surface, index) => (
          <li key={`s${index}`} className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="h-1.5 w-8 shrink-0 rounded-full"
              style={{ backgroundColor: CURVE_COLORS[index % CURVE_COLORS.length] }}
            />
            <Latex source={surface.label} className="text-lg" />
          </li>
        ))}
        {card.points.map((point, index) => (
          <li key={`p${index}`} className="flex items-center gap-3">
            <span aria-hidden="true" className="size-3 shrink-0 rounded-full bg-neutral-900" />
            <Latex source={point.label} className="text-lg" />
          </li>
        ))}
      </ul>
    </div>
  );
}
