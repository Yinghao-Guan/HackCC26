"use client";

import katex from "katex";
import "katex/dist/katex.min.css";
import { useMemo } from "react";

/**
 * Renders a LaTeX formula on its own line, left-aligned. Bad LaTeX shows up red
 * instead of crashing.
 */
export function Latex({ source, className }: { source: string; className?: string }) {
  const html = useMemo(
    () =>
      // Inline math keeps the line height tight; \displaystyle keeps fractions full size.
      katex.renderToString(`\\displaystyle ${source}`, {
        displayMode: false,
        throwOnError: false,
        strict: "ignore",
      }),
    [source],
  );

  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
