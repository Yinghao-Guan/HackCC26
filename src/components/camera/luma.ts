// Brightness helpers for looking at the camera picture. They show whether the
// finger's shadow is dark enough, next to the lit board, to be found by software.
// Plain functions on pixel data, no React.

/** How bright an RGB color looks, from 0 (black) to 255 (white). */
export const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The average brightness of a whole picture. */
export function meanLuminance(image: ImageData): number {
  const { data } = image;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += luminance(data[i], data[i + 1], data[i + 2]);
  return sum / (data.length / 4);
}

/**
 * The brightness around a point, averaged over a small square so that camera
 * noise does not jump around. `fx` and `fy` are 0 to 1 across the picture. Null
 * if the point is outside it.
 */
export function luminanceAround(image: ImageData, fx: number, fy: number, radius = 2): number | null {
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;

  const cx = Math.round(fx * (image.width - 1));
  const cy = Math.round(fy * (image.height - 1));
  let sum = 0;
  let count = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(image.height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(image.width - 1, cx + radius); x++) {
      const i = (y * image.width + x) * 4;
      sum += luminance(image.data[i], image.data[i + 1], image.data[i + 2]);
      count++;
    }
  }
  return sum / count;
}

/**
 * Paint every pixel of `source` that is darker than `threshold` red, into `out`
 * (which must be the same size), and leave the rest clear. Returns the share of
 * the picture that is darker than the threshold (0 to 1).
 */
export function paintDarkMask(source: ImageData, out: ImageData, threshold: number): number {
  const from = source.data;
  const to = out.data;
  let dark = 0;
  for (let i = 0; i < from.length; i += 4) {
    if (luminance(from[i], from[i + 1], from[i + 2]) < threshold) {
      to[i] = 239;
      to[i + 1] = 68;
      to[i + 2] = 68;
      to[i + 3] = 170;
      dark++;
    } else {
      to[i + 3] = 0;
    }
  }
  return dark / (from.length / 4);
}
