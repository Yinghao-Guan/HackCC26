import { parseAskResult, type AskResult } from "@/lib/ask";
import { parseCheckResult, type CheckResult } from "@/lib/check";
import { parseGraphResult, type GraphResult } from "@/lib/graph";
import { parseSolveResult, type SolveResult } from "@/lib/solve";

/** The things the AI buttons can do. */
export type AiAction = "solve" | "graph" | "check";

/** What the panel shows under the AI buttons. */
export type AiStatus =
  | { state: "idle" }
  | { state: "loading"; action: AiAction | "ask" }
  | { state: "message"; tone: "info" | "error"; text: string };

/** What the panel shows under the mic button. `heard` is what has been made out of the speech so far. */
export type VoiceStatus =
  | { state: "idle" }
  | { state: "listening"; heard?: string }
  | { state: "message"; tone: "info" | "error"; text: string; heard?: string };

const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Send the board's image (and anything else in `payload`) to one of the AI
 * routes and return its JSON reply. Throws an Error with a message that is
 * fine to show the user.
 */
async function post(url: string, payload: Record<string, unknown>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("That took too long. Please try again.");
    }
    throw new Error("Couldn't reach the server. Is the dev server running?");
  }

  const data: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
        ? data.error
        : "Something went wrong.";
    throw new Error(message);
  }
  return data;
}

const UNEXPECTED_FORMAT = "The answer came back in an unexpected format.";

/** Have the AI read the board and solve the problem on it. */
export async function requestSolve(image: string): Promise<SolveResult> {
  const result = parseSolveResult(await post("/api/solve", { image }));
  if (!result) throw new Error(UNEXPECTED_FORMAT);
  return result;
}

/** Have the AI read the equations on the board and say how to graph them. */
export async function requestGraph(image: string): Promise<GraphResult> {
  const result = parseGraphResult(await post("/api/graph", { image }));
  if (!result) throw new Error(UNEXPECTED_FORMAT);
  return result;
}

/**
 * Ask the AI a question. If something is written on the board, pass its image, in case
 * the question is about it.
 */
export async function requestAsk(question: string, image: string | null): Promise<AskResult> {
  const result = parseAskResult(await post("/api/ask", { question, image }));
  if (!result) throw new Error(UNEXPECTED_FORMAT);
  return result;
}

/**
 * Have the AI check worked steps for mistakes. The image has `lineCount`
 * numbered lines, and the AI says which number is the first wrong one.
 */
export async function requestCheck(image: string, lineCount: number): Promise<CheckResult> {
  const result = parseCheckResult(await post("/api/check", { image, lineCount }), lineCount);
  if (!result) throw new Error(UNEXPECTED_FORMAT);
  return result;
}
