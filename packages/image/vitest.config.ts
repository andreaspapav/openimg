import { defineConfig } from "vitest/config";

// In the web app, these go in its existing Vitest config instead
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
