"use client";

import katex from "katex";
import "katex/dist/katex.min.css";
import { useMemo } from "react";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A paragraph of plain text in which a short formula can sit between $ signs, such as
 * "Use the rule for $x^2$ here." The text is escaped, and only the formulas become
 * markup (from KaTeX), so nothing else in it can inject HTML. Bad LaTeX shows up red.
 */
export function RichText({ text, className }: { text: string; className?: string }) {
  const html = useMemo(
    () =>
      text
        .split(/(\$[^$]+\$)/g)
        .map((part) =>
          part.length > 2 && part.startsWith("$") && part.endsWith("$")
            ? katex.renderToString(part.slice(1, -1), { throwOnError: false, strict: "ignore" })
            : escapeHtml(part),
        )
        .join(""),
    [text],
  );

  return <p className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
