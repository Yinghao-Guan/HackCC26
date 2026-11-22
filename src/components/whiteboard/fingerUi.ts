// A pointer on the whiteboard window seen by the camera (a finger, or later a pen).
// It presses buttons and drags sliders like a finger on a touch screen, and (if
// allowed) draws on the board. A button is pressed while the pointer touches it and
// clicked when the pointer lifts off it, if it is still on it (slide off to cancel).
//
// Touch from the camera is not perfect: close above the board it can read as touching.
// So a touch that starts on the board (with drawing off) or on something inert does
// not lock anything: if the pointer then reaches a button while touching, that is a
// press. A press must last a moment, and a button that was just clicked cannot be
// pressed again until the pointer has left it, so one touch never clicks twice.
//
// Nothing near the pointer gets darker while it hovers or presses: the camera finds
// touch from the shadow, by comparing the board with a picture of it taken earlier,
// and a button that turned darker under the pointer would look like a shadow. A
// clicked button flashes only after the click.

import type { Point } from "../camera/shadowTouch";

const BUTTON = "button:not(:disabled), [role='button']";

// A touch on a button shorter than this is not a press.
const MIN_PRESS_MS = 150;
// How long a clicked button flashes.
const FLASH_MS = 350;

type Mode = "none" | "draw" | "button" | "slider";

/** What the pointer is used with. */
export interface FingerTarget {
  /** The drawing canvas. */
  canvas: HTMLCanvasElement | null;
  /** Give the canvas the pointer for drawing: a point relative to the canvas (null when it has none) and whether it is down. */
  draw: (point: Point | null, down: boolean) => void;
  /** Show where the pointer is in the window (null hides it), and whether it is touching. */
  ring: (point: Point | null, touching: boolean) => void;
  /** Say what the pointer is over ("board", a button's name, or null with no pointer) and whether it touches. */
  report: (over: string | null, touching: boolean) => void;
  /** Say that a button was clicked. */
  clicked: (label: string) => void;
}

function buttonAt(x: number, y: number): HTMLElement | null {
  return document.elementFromPoint(x, y)?.closest<HTMLElement>(BUTTON) ?? null;
}

function sliderAt(x: number, y: number): HTMLInputElement | null {
  const element = document.elementFromPoint(x, y);
  return element instanceof HTMLInputElement && element.type === "range" ? element : null;
}

/** A short name for a button or slider, for reports. */
function nameOf(element: HTMLElement): string {
  return (
    element.getAttribute("aria-label") ||
    element.textContent?.trim() ||
    (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent?.trim() : "") ||
    "a control"
  );
}

/** Set a slider from where the pointer is along it, the way React notices a change. */
function setSlider(input: HTMLInputElement, clientX: number) {
  const rect = input.getBoundingClientRect();
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const step = Number(input.step || 1);
  const share = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const value = Math.min(max, Math.max(min, Math.round((share * (max - min)) / step) * step + min));

  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setValue) return;
  setValue.call(input, String(Number(value.toFixed(6))));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Briefly outline a button that was clicked (styled in globals.css). */
function flash(element: HTMLElement) {
  element.dataset.finger = "clicked";
  window.setTimeout(() => {
    if (element.dataset.finger === "clicked") delete element.dataset.finger;
  }, FLASH_MS);
}

export class FingerUi {
  private mode: Mode = "none";
  private pressed: HTMLElement | null = null;
  private pressedAt = 0;
  private overPressed = false;
  private slider: HTMLInputElement | null = null;
  // The button clicked last: it cannot be pressed again until the pointer has been off it.
  private lastClicked: HTMLElement | null = null;

  /**
   * One position of the pointer, in the window's pixels. `writing` is true while it
   * touches the board (for a finger: in the writing pose). `allowDraw` says whether a
   * touch on the board itself may draw; otherwise only buttons and sliders respond.
   */
  update(
    clientX: number,
    clientY: number,
    writing: boolean,
    allowDraw: boolean,
    target: FingerTarget,
    now = performance.now(),
  ) {
    const rect = target.canvas?.getBoundingClientRect();
    const onCanvas = target.canvas !== null && document.elementFromPoint(clientX, clientY) === target.canvas;
    const point = rect ? { x: clientX - rect.left, y: clientY - rect.top } : null;
    const button = onCanvas ? null : buttonAt(clientX, clientY);
    const slider = onCanvas ? null : sliderAt(clientX, clientY);

    target.ring({ x: clientX, y: clientY }, writing);
    target.report(onCanvas ? "board" : button ? nameOf(button) : slider ? nameOf(slider) : null, writing);
    if (this.lastClicked && button !== this.lastClicked) this.lastClicked = null;

    switch (this.mode) {
      case "none":
        if (!writing) return;
        // Touching: what is under the pointer now decides what the touch does.
        if (onCanvas && allowDraw) {
          this.mode = "draw";
          target.draw(point, true);
        } else if (slider) {
          this.mode = "slider";
          this.slider = slider;
          setSlider(slider, clientX);
        } else if (button && button !== this.lastClicked) {
          this.mode = "button";
          this.pressed = button;
          this.pressedAt = now;
          this.overPressed = true;
        }
        // Anything else (the board with drawing off, the panel's background, a button just
        // clicked): nothing yet, and the touch can still become a press on a button.
        return;

      case "draw":
        target.draw(point, writing);
        if (!writing) this.mode = "none";
        return;

      case "slider":
        if (writing && this.slider) setSlider(this.slider, clientX);
        else this.finish(target);
        return;

      case "button":
        if (writing) {
          // Sliding onto another button while touching presses that one instead (a pointer seen by
          // the camera often arrives near the surface, passing over other buttons on the way).
          if (button && button !== this.pressed && button !== this.lastClicked) {
            this.pressed = button;
            this.pressedAt = now;
          }
          this.overPressed = button === this.pressed;
          return;
        }
        // The pointer lifted: it is a click if it lifted off the same button after a real press.
        if (this.pressed && this.overPressed && now - this.pressedAt >= MIN_PRESS_MS) {
          const clicked = this.pressed;
          clicked.click();
          this.lastClicked = clicked;
          flash(clicked);
          target.clicked(nameOf(clicked));
        }
        this.finish(target);
        return;
    }
  }

  /** The pointer is gone. */
  lost(target: FingerTarget) {
    this.finish(target);
    this.lastClicked = null;
    target.ring(null, false);
    target.report(null, false);
  }

  private finish(target: FingerTarget) {
    if (this.mode === "draw") target.draw(null, false);
    this.pressed = null;
    this.slider = null;
    this.overPressed = false;
    this.mode = "none";
  }
}
