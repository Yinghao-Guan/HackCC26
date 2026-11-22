export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export const ANSWER_CARD_WIDTH = 380;
export const CHECK_CARD_WIDTH = 440;
export const GRAPH_PLOT_SIZE = 400;
export const GRAPH_CARD_WIDTH = GRAPH_PLOT_SIZE + 40;

const MARGIN = 16; // keep cards this far from the edges of the view
const GAP = 24; // space between the ink and a card

// Cards size themselves to their content; these guesses are close enough for placing them.

export function answerCardSize(stepCount: number): Size {
  return { width: ANSWER_CARD_WIDTH, height: 170 + stepCount * 48 };
}

export function graphCardSize(curveCount: number): Size {
  return { width: GRAPH_CARD_WIDTH, height: 90 + GRAPH_PLOT_SIZE + curveCount * 44 };
}

/** A 3D graph has a hint line under the plot, and a line for each marked point. */
export function graph3dCardSize(surfaceCount: number, pointCount: number): Size {
  return {
    width: GRAPH_CARD_WIDTH,
    height: 130 + GRAPH_PLOT_SIZE + (surfaceCount + pointCount) * 44,
  };
}

export function checkCardSize(stepCount: number): Size {
  return { width: CHECK_CARD_WIDTH, height: 280 + stepCount * 48 };
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/**
 * Where to put a new card of the given size, in board coordinates. It never
 * covers the writing it belongs to (`ink`) or another card. It prefers a spot
 * fully inside the part of the board you can see (`viewport`); if there is
 * none, it goes just below the writing and the view scrolls to it (see
 * `viewToReveal`).
 */
export function placeCard(
  ink: Rect,
  viewport: Rect,
  taken: Rect[],
  { width, height }: Size,
): { x: number; y: number } {
  const left = viewport.x + MARGIN;
  const right = viewport.x + viewport.width - MARGIN;
  const top = viewport.y + MARGIN;
  const bottom = viewport.y + viewport.height - MARGIN;
  const clampX = (x: number) => Math.max(left, Math.min(x, right - width));
  const clampY = (y: number) => Math.max(top, Math.min(y, bottom - height));

  const rightOfInk = { x: ink.x + ink.width + GAP, y: clampY(ink.y) };
  const belowInk = { x: clampX(ink.x), y: ink.y + ink.height + GAP };
  const leftOfInk = { x: ink.x - width - GAP, y: clampY(ink.y) };
  const aboveInk = { x: clampX(ink.x), y: ink.y - height - GAP };

  const clear = (c: { x: number; y: number }) => {
    const rect = { x: c.x, y: c.y, width, height };
    return !overlaps(rect, ink) && !taken.some((t) => overlaps(rect, t));
  };
  const onScreen = (c: { x: number; y: number }) =>
    c.x >= left && c.y >= top && c.x + width <= right && c.y + height <= bottom;

  // 1. Beside the writing and fully on screen.
  const visibleSpot = [rightOfInk, belowInk, leftOfInk, aboveInk].find(
    (c) => onScreen(c) && clear(c),
  );
  if (visibleSpot) return visibleSpot;

  // 2. Beside the writing but partly off screen. Below first, since scrolling down is natural.
  const nearSpot = [belowInk, rightOfInk, leftOfInk, aboveInk].find(clear);
  if (nearSpot) return nearSpot;

  // 3. Below everything.
  const lowest = Math.max(ink.y + ink.height, ...taken.map((t) => t.y + t.height));
  return { x: clampX(ink.x), y: lowest + GAP };
}

/**
 * Where to scroll the view (its top-left corner, in board coordinates) so a
 * new card is seen. If the writing and the card fit on screen together, this
 * scrolls as little as possible to show both. If not, it shows the writing and
 * the start of the card, or just the card when they are far apart.
 */
export function viewToReveal(ink: Rect, card: Rect, viewport: Rect): { x: number; y: number } {
  const axis = (
    inkStart: number,
    inkLength: number,
    cardStart: number,
    cardLength: number,
    viewStart: number,
    viewLength: number,
  ) => {
    const start = Math.min(inkStart, cardStart);
    const end = Math.max(inkStart + inkLength, cardStart + cardLength);

    if (end - start <= viewLength - 2 * MARGIN) {
      if (start < viewStart + MARGIN) return start - MARGIN;
      if (end > viewStart + viewLength - MARGIN) return end - viewLength + MARGIN;
      return viewStart;
    }

    const showBoth = Math.abs(cardStart - inkStart) < viewLength * 0.6;
    return (showBoth ? start : cardStart) - MARGIN;
  };

  return {
    x: axis(ink.x, ink.width, card.x, card.width, viewport.x, viewport.width),
    y: axis(ink.y, ink.height, card.y, card.height, viewport.y, viewport.height),
  };
}
