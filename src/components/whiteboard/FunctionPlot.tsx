"use client";

import { useId, useMemo } from "react";
import { tryCompileFormula } from "@/lib/expression";
import type { GraphCurve, GraphWindow } from "@/lib/graph";
import { explicitPath, formatTick, implicitPath, niceStep, tickValues } from "@/lib/plot";

/**
 * One color per curve, in order. The legend and the 3D surfaces use the same list.
 * Only grays: the projected board shows no color, so the camera can find the blue cap
 * of the marker that presses the buttons. Dark enough to read on the white card, and
 * light enough that a 3D surface does not shade to black.
 */
export const CURVE_COLORS = ["#404040", "#8a8a8a", "#b5b5b5", "#5c5c5c", "#9e9e9e", "#2b2b2b"];

const GRID_COLOR = "#e5e5e5";
const AXIS_COLOR = "#525252";

interface FunctionPlotProps {
  curves: GraphCurve[];
  /** The part of the coordinate plane to show. */
  window: GraphWindow;
  /** Width and height of the plot, in pixels. */
  size: number;
}

/** Axes, grid and curves drawn as a crisp, themeable SVG. */
export function FunctionPlot({ curves, window, size }: FunctionPlotProps) {
  const clipId = `plot-clip-${useId().replace(/:/g, "")}`;

  const paths = useMemo(
    () =>
      curves.map((curve) => {
        const formula = tryCompileFormula(curve.expression);
        if (!formula) return "";
        return curve.kind === "explicit"
          ? explicitPath(formula, window, size, size)
          : implicitPath(formula, window, size, size);
      }),
    [curves, window, size],
  );

  const xSpan = window.xMax - window.xMin;
  const ySpan = window.yMax - window.yMin;
  const toX = (x: number) => ((x - window.xMin) / xSpan) * size;
  const toY = (y: number) => size - ((y - window.yMin) / ySpan) * size;

  const xStep = niceStep(xSpan);
  const yStep = niceStep(ySpan);
  const xTicks = tickValues(window.xMin, window.xMax, xStep);
  const yTicks = tickValues(window.yMin, window.yMax, yStep);

  // The axes sit at zero, or at the nearest edge when zero is off screen.
  const axisY = toY(Math.min(Math.max(0, window.yMin), window.yMax));
  const axisX = toX(Math.min(Math.max(0, window.xMin), window.xMax));
  const xLabelsAbove = axisY > size - 22; // the x-axis hugs the bottom edge
  const yLabelsRight = axisX < 34; // the y-axis hugs the left edge

  const labelProps = {
    fontSize: 13,
    fill: AXIS_COLOR,
    // A white halo keeps numbers readable where a curve passes under them.
    stroke: "#ffffff",
    strokeWidth: 3,
    paintOrder: "stroke",
  } as const;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={`Graph of ${curves.map((curve) => curve.label).join(", ")}`}
      className="block overflow-hidden rounded-lg border border-neutral-200 bg-white"
    >
      <defs>
        <clipPath id={clipId}>
          <rect width={size} height={size} />
        </clipPath>
      </defs>

      {xTicks.map((t) => (
        <line key={`gx${t}`} x1={toX(t)} y1={0} x2={toX(t)} y2={size} stroke={GRID_COLOR} />
      ))}
      {yTicks.map((t) => (
        <line key={`gy${t}`} x1={0} y1={toY(t)} x2={size} y2={toY(t)} stroke={GRID_COLOR} />
      ))}

      <line x1={0} y1={axisY} x2={size} y2={axisY} stroke={AXIS_COLOR} strokeWidth={1.5} />
      <line x1={axisX} y1={0} x2={axisX} y2={size} stroke={AXIS_COLOR} strokeWidth={1.5} />

      <g clipPath={`url(#${clipId})`} fill="none" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
        {paths.map((d, index) => (
          <path key={index} d={d} stroke={CURVE_COLORS[index % CURVE_COLORS.length]} />
        ))}
      </g>

      {/* Labels are skipped near the edges, where they would be cut in half. */}
      {xTicks
        .filter((t) => toX(t) > 16 && toX(t) < size - 16)
        .map((t) => (
          <text
            key={`tx${t}`}
            x={toX(t)}
            y={xLabelsAbove ? axisY - 7 : axisY + 17}
            textAnchor="middle"
            {...labelProps}
          >
            {formatTick(t, xStep)}
          </text>
        ))}
      {yTicks
        .filter((t) => t !== 0 && toY(t) > 12 && toY(t) < size - 12)
        .map((t) => (
          <text
            key={`ty${t}`}
            x={yLabelsRight ? axisX + 7 : axisX - 7}
            y={toY(t) + 4}
            textAnchor={yLabelsRight ? "start" : "end"}
            {...labelProps}
          >
            {formatTick(t, yStep)}
          </text>
        ))}
    </svg>
  );
}
