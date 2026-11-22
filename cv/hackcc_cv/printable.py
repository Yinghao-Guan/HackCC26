"""A printable sheet of the static markers (ids 40-47) to stick around the board."""

from __future__ import annotations

from .markers import STATIC_MARKER_IDS, marker_png_data_url

MARKER_CM = 5  # printed size; big enough to see from across the room, small enough to fit


def printable_markers_page() -> str:
    cells = "\n".join(
        f'<figure><img src="{marker_png_data_url(i)}" alt="Marker {i}"><figcaption>{i}</figcaption></figure>'
        for i in STATIC_MARKER_IDS
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Printable Markers</title>
<style>
  :root {{ --ink: #111827; --muted: #6b7280; --line: #d1d5db; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: #fff; color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }}
  main {{ max-width: 900px; margin: 0 auto; padding: 16px; }}
  h1 {{ font-size: 20px; margin: 0 0 8px; }}
  ol {{ padding-left: 20px; margin: 0 0 16px; }}
  .sheet {{ display: grid; grid-template-columns: repeat(auto-fill, minmax({MARKER_CM + 2}cm, 1fr)); gap: 0; }}
  figure {{ margin: 0; padding: 1cm; border: 1px dashed var(--line); text-align: center; }}
  figure img {{ width: {MARKER_CM}cm; height: {MARKER_CM}cm; image-rendering: pixelated; display: block; margin: 0 auto; }}
  figcaption {{ color: var(--muted); font-size: 12px; margin-top: 4px; }}
  button {{ font: inherit; padding: 6px 14px; border: 1px solid var(--line); border-radius: 6px; background: #f9fafb; cursor: pointer; }}
  @media print {{ .no-print {{ display: none; }} main {{ padding: 0; }} }}
</style>
</head>
<body>
<main>
  <div class="no-print">
    <h1>Printed markers for noticing camera moves</h1>
    <ol>
      <li>Print this page at 100% scale (no "fit to page"), then cut along the dashed lines.
        Keep the white border around each marker.</li>
      <li>Stick 3 or 4 of them around the board, <b>outside the projected picture</b>, on things
        that never move (the board frame, the wall), where the camera can see them.</li>
      <li>Calibrate. The service remembers where the markers are. If the camera is moved later,
        it notices, marks the calibration stale, and recalibrates once the camera is still.</li>
    </ol>
    <p><button type="button" onclick="window.print()">Print</button></p>
  </div>
  <div class="sheet">
{cells}
  </div>
</main>
</body>
</html>
"""
