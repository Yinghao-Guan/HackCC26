import type { BusStatus } from "./cvBus";

/** What, if anything, is keeping the camera from working, in plain words. */
function problems(status: BusStatus): string[] {
  if (status.connection === "connecting") return [];
  if (status.connection === "closed") {
    return ["Camera service not running. Start it with: cd cv && uv run python -m hackcc_cv"];
  }

  const found: string[] = [];
  const { camera, calibration, tracking } = status;
  const detail = (message: string) => (message ? `: ${message}` : "");

  if (camera && camera.status !== "ok") found.push(`Camera ${camera.status}${detail(camera.message)}`);
  if (calibration) {
    if (calibration.status === "none") found.push("Not calibrated yet. Open 127.0.0.1:8765/calibrate");
    else if (calibration.status === "stale") found.push("Calibration is out of date. Calibrate again.");
    else if (calibration.status === "calibrating") found.push(`Calibrating${detail(calibration.message)}`);
    else if (calibration.status === "error") found.push(`Calibration failed${detail(calibration.message)}`);
  }
  if (tracking && tracking.status !== "ok") found.push(`Hand tracking ${tracking.status}${detail(tracking.message)}`);
  return found;
}

/**
 * A small note in the top-left corner while the camera service is missing or not ready,
 * so it never silently does nothing. When everything works it shows only a green dot.
 */
export function CvStatus({ status }: { status: BusStatus }) {
  const list = problems(status);

  if (list.length === 0) {
    if (status.connection !== "open") return null;
    return (
      <span
        role="status"
        aria-label="Camera service connected"
        title="Camera service connected"
        className="pointer-events-none fixed left-3 top-3 z-30 size-2.5 rounded-full bg-emerald-500"
      />
    );
  }

  return (
    <div
      role="status"
      className="pointer-events-none fixed left-3 top-3 z-30 flex max-w-sm flex-col gap-0.5 rounded-xl border border-amber-300 bg-amber-50/95 px-3 py-2 text-xs leading-snug text-amber-900 shadow-sm"
    >
      {list.map((text) => (
        <span key={text}>{text}</span>
      ))}
    </div>
  );
}
