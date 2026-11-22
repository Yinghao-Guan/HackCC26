// Which AI reads the board. Gemini goes first; if it fails (an error, a timeout, or a reply the
// route can't use), the same request goes to Claude. Set AI_PROVIDER=claude in .env.local to
// try Claude first instead. A provider without an API key is skipped.
// Only import this from route handlers: the keys must stay on the server.

import { askClaude, fail, type AskOptions, type Outcome } from "./claude";
import { askGemini, geminiModel } from "./gemini";

type Provider = "gemini" | "claude";

const ASK: Record<Provider, (options: AskOptions) => Promise<Outcome<unknown>>> = {
  gemini: askGemini,
  claude: askClaude,
};
const HAS_KEY: Record<Provider, () => boolean> = {
  gemini: () => Boolean(process.env.GEMINI_API_KEY),
  claude: () => Boolean(process.env.ANTHROPIC_API_KEY),
};

function order(): Provider[] {
  const first: Provider = process.env.AI_PROVIDER === "claude" ? "claude" : "gemini";
  const all: Provider[] = first === "gemini" ? ["gemini", "claude"] : ["claude", "gemini"];
  return all.filter((provider) => HAS_KEY[provider]());
}

/**
 * Show the AI the board (if there is an image) and get its reply as JSON in the shape of
 * `schema`, from Gemini or, if that fails, from Claude. The routes still validate the reply.
 * On failure, this gives an error response that is fine to send to the browser.
 */
export async function askAboutBoard(options: AskOptions): Promise<Outcome<unknown>> {
  const providers = order();
  if (providers.length === 0) {
    return {
      ok: false,
      response: fail("No AI key is set. Add GEMINI_API_KEY or ANTHROPIC_API_KEY to .env.local, then restart the dev server.", 500),
    };
  }

  let last: Outcome<unknown> | null = null;
  for (const provider of providers) {
    const started = Date.now();
    const reply = await ASK[provider](options);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const usable = reply.ok && reply.value !== null && (options.accept?.(reply.value) ?? true);
    const name = provider === "gemini" ? `gemini (${geminiModel()})` : "claude";
    if (usable) {
      console.log(`[ai] answered by ${name} in ${seconds}s`);
      return reply;
    }
    console.warn(`[ai] ${name} failed after ${seconds}s${reply.ok ? ": the reply was not in the expected format" : ""}`);
    last = reply;
  }
  return last!;
}
