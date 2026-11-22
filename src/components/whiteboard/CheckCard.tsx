"use client";

import type { CheckCardData } from "./board";
import { Latex } from "./Latex";
import { CHECK_CARD_WIDTH } from "./layout";

const labelClass = "mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500";

interface CheckCardProps {
  card: CheckCardData;
  onDismiss: () => void;
}

/** The AI's verdict on worked steps: what went wrong, how it should read, and the way to the right answer. */
export function CheckCard({ card, onDismiss }: CheckCardProps) {
  const mistake = card.verdict === "mistake";

  return (
    // The card lets pointer events through, so you can keep writing around and
    // over it. Only the dismiss button takes clicks.
    <div
      className={`pointer-events-none absolute rounded-2xl border-2 bg-white/95 p-5 shadow-lg ${
        mistake ? "border-neutral-900" : "border-neutral-500"
      }`}
      style={{ left: card.x, top: card.y, width: CHECK_CARD_WIDTH }}
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss check"
        className="pointer-events-auto absolute right-2 top-2 grid size-10 place-items-center rounded-full text-2xl leading-none text-neutral-500 transition-colors hover:bg-neutral-100"
      >
        ×
      </button>

      <p className={labelClass}>Check</p>
      <p className={`mb-2 text-2xl font-semibold text-neutral-900`}>
        {mistake
          ? card.step
            ? `Step ${card.step} has a mistake`
            : "There is a mistake"
          : "No mistakes found"}
      </p>
      <p className="mb-4 text-lg leading-snug text-neutral-800">{card.explanation}</p>

      {mistake && card.correctedLine && (
        <>
          <p className={labelClass}>It should be</p>
          <Latex source={card.correctedLine} className="mb-3 text-xl" />
        </>
      )}

      {card.steps.length > 0 && (
        <>
          <p className={labelClass}>Carrying on from there</p>
          <ol className="mb-3 flex flex-col">
            {card.steps.map((step, index) => (
              <li key={index} className="py-1">
                <Latex source={step} className="text-lg" />
              </li>
            ))}
          </ol>
        </>
      )}

      {card.answer && (
        <>
          <p className={labelClass}>{mistake ? "Correct answer" : "Final answer"}</p>
          <div className="rounded-lg bg-neutral-100 px-3 py-1 text-2xl text-neutral-900">
            <Latex source={card.answer} />
          </div>
        </>
      )}
    </div>
  );
}
