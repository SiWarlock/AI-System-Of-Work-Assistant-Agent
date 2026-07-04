import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Two test tiers:
//   - Node (default): the pure/deterministic units — security invariants, the UI-safe store +
//     reducers, the event-stream client, the window-FREE surface logic (route/select/docpack).
//     These stay DOM-less (apps/desktop LESSONS §3) and typecheck under tsconfig.node.json.
//   - jsdom (per-file `// @vitest-environment jsdom`): component RENDER tests under test-dom/,
//     which mount React surfaces (@testing-library/react) and typecheck under tsconfig.testdom.json.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: [
      "test/**/*.{test,spec}.ts",
      "renderer/**/*.{test,spec}.ts",
      "test-dom/**/*.{test,spec}.tsx",
    ],
  },
});
