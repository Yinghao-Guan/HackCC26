/**
 * The 3D views on the board, so that hand gestures (from the camera service) can turn and
 * zoom them. Each 3D view registers itself while it is shown.
 */
export interface Plot3DControls {
  /** The view's element on the page. */
  element: HTMLElement;
  /** Turn the view, as if dragged by this many pixels. */
  rotate(dx: number, dy: number): void;
  /** How far the camera is from what it looks at. */
  distance(): number;
  /** Move the camera to this distance (kept within the view's limits). */
  setDistance(distance: number): void;
  /** Back to the starting angle and distance. */
  reset(): void;
}

const plots = new Set<Plot3DControls>();

/** Add a 3D view; the function it gives removes it again. */
export function registerPlot3D(plot: Plot3DControls): () => void {
  plots.add(plot);
  return () => {
    plots.delete(plot);
  };
}

/**
 * The 3D view at a point on the screen (CSS pixels), or else the one on screen nearest to
 * it, since a hand in the air rarely lines up exactly with the view it means.
 */
export function plot3DNear(x: number, y: number): Plot3DControls | null {
  const under = document.elementFromPoint(x, y)?.closest("[data-plot3d]");
  let nearest: Plot3DControls | null = null;
  let nearestDistance = Infinity;

  for (const plot of plots) {
    if (under && plot.element === under) return plot;
    const box = plot.element.getBoundingClientRect();
    const offScreen =
      box.bottom < 0 || box.right < 0 || box.top > window.innerHeight || box.left > window.innerWidth;
    if (offScreen) continue;
    const dx = Math.max(box.left - x, 0, x - box.right);
    const dy = Math.max(box.top - y, 0, y - box.bottom);
    const distance = Math.hypot(dx, dy);
    if (distance < nearestDistance) {
      nearest = plot;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** Put every 3D view back to its starting angle and distance. */
export function resetAllPlots3D(): void {
  for (const plot of plots) plot.reset();
}
