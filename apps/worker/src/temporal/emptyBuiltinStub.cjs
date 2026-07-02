// An EMPTY-module stub the workflow bundler substitutes for the provably-unreachable
// Node built-ins (node:fs / node:crypto) the package barrels drag into the sandbox
// graph. The barrels' fs/crypto code is NEVER CALLED in the workflow path (it runs in
// activities), so an empty module is a sound substitute — and it lets the Temporal
// bundler compile without hitting the `node:`-scheme UnhandledSchemeError. See
// registerWorker.ts `proofSpineWebpackConfigHook` for the substitution wiring.
module.exports = {};
