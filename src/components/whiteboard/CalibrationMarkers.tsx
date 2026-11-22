import { MARKER_POINTS, type CalibrationScreen } from "@/lib/boardLink";

/**
 * The calibration screen: the whole window in white, with the nine black squares on
 * it when `screen` is "markers". The camera page compares a picture of the plain
 * white window with one of the squares to find them. White everywhere gives every
 * square the same strong contrast: on the dim gray board black squares were too
 * faint to be found.
 */
export function CalibrationMarkers({ screen }: { screen: Exclude<CalibrationScreen, "off"> }) {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-50 bg-white">
      {screen === "markers" &&
        MARKER_POINTS.map((point, index) => (
          <div
            key={index}
            className="absolute size-20 -translate-x-1/2 -translate-y-1/2 bg-black"
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
          />
        ))}
    </div>
  );
}
