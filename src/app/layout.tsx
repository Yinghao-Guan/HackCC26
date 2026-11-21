import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HackCC26 Whiteboard",
  description: "A projected, interactive, AI-assisted whiteboard.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
