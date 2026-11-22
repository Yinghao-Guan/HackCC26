// A finger on the whiteboard window, as seen by the camera. It draws on the board
// like a pen, and presses buttons and drags sliders like a finger on a touch screen:
// a button is pressed when the finger touches it and clicked when the finger lifts
// off it, if it is still on it (slide off to cancel). Which of these a touch does is
// decided by what is under the fingertip when it lands.

import type { Point } from "../camera/shadowTouch";

const BUTTON = "button:not(:disabled), [role='button']";

type Mode = "none" | "draw" | "button" | "slider" | "ignore";

/** Where the drawing canvas is, and how to hand it the finger. */
export interface FingerTarget {
  canvas: HTMLCanvasElement | null;
  /** Give the canvas the finger: a point relative to the canvas (null when it has none) and whether it is down. */
  draw: (point: Point | null, down: boolean) => void;
}

function buttonAt(x: number, y: number): HTMLElement | null {
  return document.elementFromPoint(x, y)?.closest<HTMLElement>(BUTTON) ?? null;
}

function sliderAt(x: number, y: number): HTMLInputElement | null {
  const element = document.elementFromPoint(x, y);
  return element instanceof HTMLInputElement && element.type === "range" ? element : null;
}

/** Set a slider from where the finger is along it, the way React notices a change. */
function setSlider(input: HTMLInputElement, clientX: number) {
  const rect = input.getBoundingClientRect();
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const step = Number(input.step || 1);
  const share = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const value = Math.min(max, Math.max(min, Math.round((min + share * (max - min) - min) / step) * step + min));

  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setValue) return;
  setValue.call(input, String(Number(value.toFixed(6))));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Highlight an element the finger is over (or pressing), and clear the highlight from the one before. */
function mark(element: HTMLElement | null, state: "hover" | "pressed" | null, previous: HTMLElement | null) {
  if (previous && previous !== element) delete previous.dataset.finger;
  if (element) {
    if (state) element.dataset.finger = state;
    else delete element.dataset.finger;
  }
}

export class FingerUi {
  private mode: Mode = "none";
  private marked: HTMLElement | null = null;
  private pressed: HTMLElement | null = null;
  private overPressed = false;
  private slider: HTMLInputElement | null = null;

  /**
   * One position of the finger, in the window's pixels. `writing` is true while it
   * touches the board in the writing pose.
   */
  update(clientX: number, clientY: number, writing: boolean, target: FingerTarget) {
    const rect = target.canvas?.getBoundingClientRect();
    const onCanvas = target.canvas !== null && document.elementFromPoint(clientX, clientY) === target.canvas;
    const point = rect ? { x: clientX - rect.left, y: clientY - rect.top } : null;

    if (this.mode === "none") {
      if (!writing) {
        // Hovering: show where the pen would land, or which button the finger is over.
        const hovered = onCanvas ? null : buttonAt(clientX, clientY);
        mark(hovered, hovered ? "hover" : null, this.marked);
        this.marked = hovered;
        target.draw(onCanvas ? point : null, false);
        return;
      }

      // A touch has just started: what is under the fingertip decides what it does.
      const slider = onCanvas ? null : sliderAt(clientX, clientY);
      const button = onCanvas || slider ? null : buttonAt(clientX, clientY);
      if (onCanvas) {
        this.mode = "draw";
        target.draw(point, true);
      } else if (slider) {
        this.mode = "slider";
        this.slider = slider;
        setSlider(slider, clientX);
      } else if (button) {
        this.mode = "button";
        this.pressed = button;
        this.overPressed = true;
        mark(button, "pressed", this.marked);
        this.marked = button;
      } else {
        this.mode = "ignore"; // a touch on something that does nothing
      }
      return;
    }

    switch (this.mode) {
      case "draw":
        target.draw(point, writing);
        if (!writing) this.mode = "none";
        break;

      case "slider":
        if (writing && this.slider) setSlider(this.slider, clientX);
        else this.finish(target);
        break;

      case "button": {
        const over = buttonAt(clientX, clientY) === this.pressed;
        if (writing) {
          this.overPressed = over;
          mark(this.pressed, over ? "pressed" : "hover", this.marked);
        } else {
          // The finger lifted: it is a click if it lifted off the same button.
          if (this.overPressed) this.pressed?.click();
          this.finish(target);
        }
        break;
      }

      case "ignore":
        if (!writing) this.mode = "none";
        break;
    }
  }

  /** The hand is gone. */
  lost(target: FingerTarget) {
    this.finish(target);
  }

  private finish(target: FingerTarget) {
    if (this.mode === "draw") target.draw(null, false);
    mark(null, null, this.marked);
    this.marked = null;
    this.pressed = null;
    this.slider = null;
    this.overPressed = false;
    this.mode = "none";
    target.draw(null, false);
  }
}
