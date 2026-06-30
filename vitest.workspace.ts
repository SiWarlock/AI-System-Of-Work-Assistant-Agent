import { defineWorkspace } from "vitest/config";

// Each workspace package that ships tests carries its own vitest.config.ts.
// `pnpm vitest run` at the repo root runs every project; `--project <name>`
// (the package name, e.g. @sow/contracts) scopes to one.
export default defineWorkspace(["packages/*", "apps/*"]);
