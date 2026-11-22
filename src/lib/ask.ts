/** What the "ask a question" API returns. Shared by the server route and the browser. */

/** One piece of an answer: some prose, or a formula shown on its own line. */
export interface ReplyBlock {
  kind: "text" | "math";
  /** Plain sentences (with $...$ around a short formula inside one) or, for "math", LaTeX. */
  content: string;
}

export interface AskResult {
  blocks: ReplyBlock[];
}

const MAX_BLOCKS = 10;

/**
 * Check an unknown value (a model reply or an API response) and return it as an
 * AskResult, or null if it isn't one. Blocks that are empty or malformed are dropped.
 */
export function parseAskResult(value: unknown): AskResult | null {
  if (typeof value !== "object" || value === null || !("blocks" in value) || !Array.isArray(value.blocks)) {
    return null;
  }

  const blocks: ReplyBlock[] = [];
  for (const block of value.blocks) {
    if (typeof block !== "object" || block === null) continue;
    const { kind, content } = block as { kind?: unknown; content?: unknown };
    if ((kind !== "text" && kind !== "math") || typeof content !== "string" || content.trim() === "") continue;
    blocks.push({ kind, content: content.trim() });
  }

  if (blocks.length === 0) return null;
  return { blocks: blocks.slice(0, MAX_BLOCKS) };
}
