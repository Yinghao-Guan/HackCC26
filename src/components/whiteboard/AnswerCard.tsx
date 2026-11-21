"use client";

import type { AnswerCardData } from "./board";
import { Latex } from "./Latex";
import { ANSWER_CARD_WIDTH } from "./layout";

const labelClass = "mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500";

interface AnswerCardProps {
  card: AnswerCardData;
  onDismiss: () => void;
}

/** The AI's reading, working and answer, written on the board next to the problem. */
export function AnswerCard({ card, onDismiss }: AnswerCardProps) {
  return (
    // The card lets pointer events through, so you can keep writing around and
    // over it. Only the dismiss button takes clicks.
    <div
      className="pointer-events-none absolute rounded-2xl border-2 border-emerald-500 bg-white/95 p-5 shadow-lg"
      // Grows with long formulas, up to a limit, so they stay inside the card.
      style={{
        left: card.x,
        top: card.y,
        width: "max-content",
        minWidth: ANSWER_CARD_WIDTH,
        maxWidth: 720,
      }}
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss answer"
        className="pointer-events-auto absolute right-2 top-2 grid size-10 place-items-center rounded-full text-2xl leading-none text-neutral-500 transition-colors hover:bg-neutral-100"
      >
        ×
      </button>

      <p className={labelClass}>I read</p>
      <Latex source={card.read} className="mb-3 text-xl" />

      {card.steps.length > 0 && (
        <>
          <p className={labelClass}>Steps</p>
          <ol className="mb-3 flex flex-col">
            {card.steps.map((step, index) => (
              <li key={index} className="py-1">
                <Latex source={step} className="text-lg" />
              </li>
            ))}
          </ol>
        </>
      )}

      <p className={labelClass}>Answer</p>
      <div className="rounded-lg bg-emerald-50 px-3 py-1 text-2xl text-emerald-900">
        <Latex source={card.answer} />
      </div>
    </div>
  );
}
