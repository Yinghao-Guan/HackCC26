import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No "N" button in the corner during `npm run dev`: the board is projected and filmed.
  // Compile and runtime errors still show.
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
