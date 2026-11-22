import { MARKER_POINTS } from "@/lib/boardLink";

/**
 * The calibration markers: black squares in a three-by-three grid over the whole
 * window. The camera page finds them in the camera picture to learn where the
 * whiteboard is. They are black because black shows up on the gray board and on the
 * white settings panel alike (white ones would vanish on the panel).
 */
export function CalibrationMarkers() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-50">
      {MARKER_POINTS.map((point, index) => (
        <div
          key={index}
          className="absolute size-16 -translate-x-1/2 -translate-y-1/2 bg-black"
          style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
        />
      ))}
    </div>
  );
}
