// Find the bright spots in a picture (the projected calibration markers). Plain
// functions, no React.

export interface Blob {
  /** The middle of the spot, in pixels. */
  x: number;
  y: number;
  /** How many pixels it covers. */
  area: number;
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
