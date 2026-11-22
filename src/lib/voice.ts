/** Turning what someone said into one of the board's commands. Shared by the browser and the tests. */

export type VoiceCommand = "solve" | "graph" | "check" | "undo";

// The words and phrases that ask for each command. Several are listed for each,
// because people say it many ways ("plot this", "draw a 3D coordinate system").
const PHRASES: Record<VoiceCommand, RegExp> = {
  check:
    /\b(check|mistakes?|wrong|errors?|incorrect|correct|verify|proofread|is (?:this|that|it|my \w+) right)\b/,
  solve:
    /\b(solve|solution|work out|figure out|calculate|compute|evaluate|simplify|what(?:'s| is) the answer|find (?:x|y|z|the (?:value|answer)))\b/,
  graph: /\b(graph|plot|draw|sketch|visuali[sz]e|coordinate|3[- ]?d|three[- ]dimensional)\b/,
  undo: /\b(undo|take (?:that|it) back)\b/,
};

/** Lower case, straight apostrophes, no sentence punctuation. */
const tidy = (transcript: string) =>
  transcript
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.,!?;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Which command was asked for, or null if nothing in `transcript` sounds like one.
 * If several are mentioned, the one said first wins ("solve this, then graph it" solves).
 */
export function parseVoiceCommand(transcript: string): VoiceCommand | null {
  const text = tidy(transcript);

  let best: { command: VoiceCommand; at: number } | null = null;
  for (const command of Object.keys(PHRASES) as VoiceCommand[]) {
    const at = text.search(PHRASES[command]);
    if (at !== -1 && (best === null || at < best.at)) best = { command, at };
  }
  return best?.command ?? null;
}

/** What a spoken sentence is: a board command, a question for the AI, or neither. */
export type Spoken =
  | { kind: "command"; command: VoiceCommand }
  | { kind: "question" }
  | { kind: "unknown" };

// Sentences that start like this are questions even if they mention a command word:
// "how do I solve a quadratic" is a question about solving, not a request to solve.
const QUESTION_OPENERS =
  /^(?:(?:please|hey|ok|okay|so) )*(?:(?:can|could|would) you (?:please )?)?(?:how|why|explain|describe|define|tell me|give me|teach me)\b/;

// Anything shorter than this that isn't a command is probably noise ("uh", "hello"), not a question.
const MIN_QUESTION_WORDS = 3;

/** Decide what a spoken sentence is. Commands are checked first, unless it opens like a question. */
export function parseSpoken(transcript: string): Spoken {
  if (!QUESTION_OPENERS.test(tidy(transcript))) {
    const command = parseVoiceCommand(transcript);
    if (command) return { kind: "command", command };
  }
  const words = tidy(transcript).split(" ").filter(Boolean).length;
  return words >= MIN_QUESTION_WORDS ? { kind: "question" } : { kind: "unknown" };
}
