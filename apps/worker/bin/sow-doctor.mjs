#!/usr/bin/env -S node --conditions=sow-built
// The `sow-doctor` entry point.
//
// ⛔ THE DEFECT THIS FIXES: `package.json`'s `bin` pointed DIRECTLY at
// `./dist/install/bin/doctor.js`. That file's emitted ESM carries extensionless relative
// specifiers (`from "../probe-adapters"`), which Node's ESM resolver rejects — the package is
// `"type": "module"`. So the shipped binary died at MODULE LOAD:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/dist/install/probe-adapters'
//   imported from '…/dist/install/bin/doctor.js'                                  exit 1
//
// ⇒ ***`sow-doctor` had NEVER been runnable.*** The forked worker child gets
// `--conditions=sow-built --import register-loader.mjs` (`worker-supervisor.ts`) and therefore
// works; the bin got neither, and nothing ran it.
//
// ⭐ AND THAT IS WHY THE OTHER `sow-doctor` DEFECT WENT UNNOTICED. `### 24.139` found the doctor
// reporting a false `single_owner_lock` finding and exiting 1 on a healthy machine — measured
// through `runInstallDoctor`, the FUNCTION. The BINARY never reached that code at all. Two
// independent defects on one entry point, BOTH producing exit 1, each hiding the other.
//
// This shim supplies BOTH halves the worker-host child already gets, in the one place that was
// missing them:
//   1. `--conditions=sow-built` (in the shebang — it is a PROCESS flag, so a runtime call cannot
//      set it). Without it `@sow/*` resolve through the `default` export condition to `src/*.ts`
//      and Node dies with `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`. That was
//      the SECOND failure, reached only after the first was fixed.
//   2. the extensionless-ESM resolve hook, registered below.
//
// ⚠ `env -S` is required to pass a flag through the shebang. Supported by BSD `env` (macOS) and
// GNU coreutils ≥ 8.30. This is a Mac-first project, so that is in scope — stated because it is
// a real portability boundary, not an accident.
import { register } from "node:module";

register("./resolve-loader.mjs", import.meta.url);

await import("../dist/install/bin/doctor.js");
