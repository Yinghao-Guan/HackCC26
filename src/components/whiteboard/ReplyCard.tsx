"use client";

import type { ReplyCardData } from "./board";
import { Latex } from "./Latex";
import { REPLY_CARD_WIDTH } from "./layout";
import { RichText } from "./RichText";

const labelClass = "mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500";

interface ReplyCardProps {
  card: ReplyCardData;
  onDismiss: () => void;
}

/** The AI's answer to a question you asked out loud, written on the board. */
export function ReplyCard({ card, onDismiss }: ReplyCardProps) {
  return (
    // The card lets pointer events through, so you can keep writing around and
    // over it. Only the dismiss button takes clicks.
    <div
      className="pointer-events-none absolute rounded-2xl border-2 border-amber-500 bg-white/95 p-5 shadow-lg"
      style={{ left: card.x, top: card.y, width: REPLY_CARD_WIDTH }}
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss reply"
        className="pointer-events-auto absolute right-2 top-2 grid size-10 place-items-center rounded-full text-2xl leading-none text-neutral-500 transition-colors hover:bg-neutral-100"
      >
        ×
      </button>

      <p className={labelClass}>You asked</p>
      <p className="mb-4 pr-8 text-base italic leading-snug text-neutral-600">“{card.question}”</p>

      <div className="flex flex-col gap-2">
        {card.blocks.map((block, index) =>
          block.kind === "math" ? (
            <Latex key={index} source={block.content} className="py-1 text-xl" />
          ) : (
            <RichText key={index} text={block.content} className="text-lg leading-snug text-neutral-800" />
          ),
        )}
      </div>
    </div>
  );
}
