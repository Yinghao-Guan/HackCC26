"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { measureText, TEXT_FONT_FAMILY, TEXT_LINE_HEIGHT, TEXT_PADDING } from "./text";

/** A piece of text being typed: a new one (`id` is null) or an existing one being edited. */
export interface TextEdit {
  /** Tells one editing session from the next, so a late event from an old one is ignored. */
  key: number;
  id: number | null;
  /** Top-left corner of the text on the board. */
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
}

const MIN_WIDTH = 160;
const CARET_ROOM = 6; // so the caret at the end of a line isn't clipped

interface TextEditorProps {
  edit: TextEdit;
  onChange: (text: string) => void;
  /** Finish editing and keep what was typed (an empty box is discarded). */
  onFinish: () => void;
}

/** A text box on the board that grows as you type. */
export function TextEditor({ edit, onChange, onFinish }: TextEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const focusAtEnd = () => {
      const el = ref.current;
      if (!el || document.activeElement === el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    };

    // Focus right away so nothing typed is lost, and check again on the next
    // frame in case the click that opened the box moved focus away from it.
    focusAtEnd();
    const frame = requestAnimationFrame(focusAtEnd);
    return () => cancelAnimationFrame(frame);
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter adds a new line. Escape or Ctrl/Cmd+Enter finishes.
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      onFinish();
    }
  };

  const measured = measureText(edit.text, edit.size);

  return (
    <textarea
      ref={ref}
      value={edit.text}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onFinish}
      onKeyDown={handleKeyDown}
      aria-label="Text box"
      placeholder="Type here"
      wrap="off"
      spellCheck={false}
      autoComplete="off"
      className="absolute resize-none overflow-hidden whitespace-pre rounded-sm bg-transparent outline-2 outline-dashed outline-neutral-400 placeholder:text-neutral-300"
      style={{
        // The text itself starts at (x, y), so the box sits one padding out.
        left: edit.x - TEXT_PADDING,
        top: edit.y - TEXT_PADDING,
        width: Math.max(MIN_WIDTH, measured.width + CARET_ROOM) + TEXT_PADDING * 2,
        height: measured.height + TEXT_PADDING * 2,
        padding: TEXT_PADDING,
        fontFamily: TEXT_FONT_FAMILY,
        fontSize: edit.size,
        lineHeight: TEXT_LINE_HEIGHT,
        color: edit.color,
      }}
    />
  );
}
