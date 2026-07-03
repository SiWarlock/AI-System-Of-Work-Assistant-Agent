import { defineConfig } from "vitest/config";

// Desktop unit tests (security invariants, the UI-safe renderer store, the
// event-stream client) are pure/deterministic and run in a Node environment.
// Component/e2e coverage is added per-surface with its own environment.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.{test,spec}.ts", "renderer/**/*.{test,spec}.ts"],
  },
});
