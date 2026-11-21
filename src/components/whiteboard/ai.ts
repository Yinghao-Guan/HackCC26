import { parseSolveResult, type SolveRequest, type SolveResult } from "@/lib/solve";

/** What the panel shows under the Solve button. */
export type AiStatus =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "message"; tone: "info" | "error"; text: string };

const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Send the board's image to the server to be read and solved.
 * Throws an Error with a message that is fine to show the user.
 */
export async function requestSolve(image: string): Promise<SolveResult> {
  const body: SolveRequest = { image };

  let response: Response;
  try {
    response = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

  const result = parseSolveResult(data);
  if (!result) throw new Error("The answer came back in an unexpected format.");
  return result;
}
