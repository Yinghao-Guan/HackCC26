"use client";

import { useRef } from "react";
import type { Marker, Target } from "./cvBus";

export interface Probe {
  key: number;
  x: number;
  y: number;
}

interface CalibrationLayerProps {
  /** The marker grid of an automatic calibration, or null when none is showing. */
  pattern: { run: number; markers: Marker[] } | null;
  /** Numbered crosses for a manual calibration. */
  targets: Target[];
  /** Red crosses where a check click landed. */
  probes: Probe[];
  /** The pattern of this run is on screen, so the camera can look at it now. */
  onPatternShown: (run: number) => void;
}

/** What the camera service asks the board to show while it calibrates (cv/README.md). */
export function CalibrationLayer({ pattern, targets, probes, onPatternShown }: CalibrationLayerProps) {
  return (
    <>
      {(targets.length > 0 || probes.length > 0) && (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[60]">
          {targets.map((target) => (
            <div key={target.id} className="absolute" style={{ left: target.x, top: target.y }}>
              <div className="absolute -left-10 -top-0.5 h-1 w-20 bg-black" />
              <div className="absolute -left-0.5 -top-10 h-20 w-1 bg-black" />
              <span className="absolute left-3.5 top-2.5 text-[28px] font-bold leading-none text-black">
                {target.id}
              </span>
            </div>
          ))}
          {probes.map((probe) => (
            <div key={probe.key} className="absolute" style={{ left: probe.x, top: probe.y }}>
              <div className="absolute -left-[18px] -top-[1.5px] h-[3px] w-9 bg-red-600" />
              <div className="absolute -left-[1.5px] -top-[18px] h-9 w-[3px] bg-red-600" />
            </div>
          ))}
        </div>
      )}

      {pattern && pattern.markers.length > 0 && (
        // A new run is a fresh layer, so its images are counted from zero.
        <MarkerPattern key={pattern.run} run={pattern.run} markers={pattern.markers} onShown={onPatternShown} />
      )}
    </>
  );
}

/**
 * The whole page pure white with each marker at its place. Once every image has loaded
 * and been painted, it tells the service, which then looks with the camera.
 */
function MarkerPattern({
  run,
  markers,
  onShown,
}: {
  run: number;
  markers: Marker[];
  onShown: (run: number) => void;
}) {
  const loaded = useRef(0);
  const failed = useRef(false);

  const handleLoad = () => {
    loaded.current += 1;
    if (loaded.current === markers.length && !failed.current) {
      // Two frames later the images have really been drawn on the projector.
      requestAnimationFrame(() => requestAnimationFrame(() => onShown(run)));
    }
  };

  return (
    <div aria-hidden="true" className="fixed inset-0 z-[100] bg-white">
      {markers.map((marker) => (
        // A plain img on purpose: data URLs, drawn pixel for pixel, never resized by Next.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={marker.id}
          src={marker.png}
          alt=""
          onLoad={handleLoad}
          onError={() => {
            failed.current = true;
          }}
          className="absolute"
          style={{
            left: marker.x,
            top: marker.y,
            width: marker.size,
            height: marker.size,
            imageRendering: "pixelated",
          }}
        />
      ))}
    </div>
  );
}
