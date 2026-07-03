// The --import shim that registers the extensionless-ESM resolve hook for the
// spawned worker child (9.4b). Passed as `node --import ./register-loader.mjs`.
import { register } from "node:module";

register("./resolve-loader.mjs", import.meta.url);
