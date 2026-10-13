import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src"), "next/font/google": path.resolve(__dirname, "tests/mocks/next-font-google.ts") } },
  test: { include: ["tests/**/*.test.{ts,tsx}"] },
});
