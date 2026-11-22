// Find the bright spots in a picture (the projected calibration markers). Plain
// functions, no React.

export interface Blob {
  /** The middle of the spot, in pixels. */
  x: number;
  y: number;
  /** How many pixels it covers. */
  area: number;
}

/** Every connected group of set pixels, numbered from 1, with how big each is and whether it touches the edge. */
export interface Labels {
  /** For each pixel, the number of its group (0 for pixels that are not set). */
  label: Int32Array;
  /** The size of each group, indexed by its number (index 0 is unused). */
  area: number[];
  /** Whether each group reaches the edge of the picture, indexed by its number. */
  touchesEdge: boolean[];
}

/** Number the connected groups of set pixels in a mask (1 = set), four-connected. */
export function labelBlobs(mask: Uint8Array, width: number, height: number): Labels {
  const label = new Int32Array(mask.length);
  const stack = new Int32Array(mask.length);
  const area: number[] = [0];
  const touchesEdge: boolean[] = [false];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = area.length;
    let size = 0;
    let edge = false;
    let top = 0;
    stack[top++] = start;
    label[start] = id;

    while (top > 0) {
      const index = stack[--top];
      const x = index % width;
      const y = (index - x) / width;
      size++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true;

      const neighbors = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ];
      for (const next of neighbors) {
        if (next >= 0 && mask[next] && !label[next]) {
          label[next] = id;
          stack[top++] = next;
        }
      }
    }
    area.push(size);
    touchesEdge.push(edge);
  }
  return { label, area, touchesEdge };
}

/**
 * The connected groups of set pixels in a mask (1 = set), with their middle and
 * size. Groups smaller than `minArea` are left out.
 */
export function findBlobs(mask: Uint8Array, width: number, height: number, minArea: number): Blob[] {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const blobs: Blob[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;

    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let sumX = 0;
    let sumY = 0;
    let area = 0;

    while (top > 0) {
      const index = stack[--top];
      const x = index % width;
      const y = (index - x) / width;
      sumX += x;
      sumY += y;
      area++;

      if (x > 0 && mask[index - 1] && !seen[index - 1]) {
        seen[index - 1] = 1;
        stack[top++] = index - 1;
      }
      if (x < width - 1 && mask[index + 1] && !seen[index + 1]) {
        seen[index + 1] = 1;
        stack[top++] = index + 1;
      }
      if (y > 0 && mask[index - width] && !seen[index - width]) {
        seen[index - width] = 1;
        stack[top++] = index - width;
      }
      if (y < height - 1 && mask[index + width] && !seen[index + width]) {
        seen[index + width] = 1;
        stack[top++] = index + width;
      }
    }

    if (area >= minArea) blobs.push({ x: sumX / area, y: sumY / area, area });
  }
  return blobs;
}
