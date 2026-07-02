// @sow/evals · worker-api-auth — the §12 named conformance suites for the local
// worker API boundary (Task 8.7). Three DoD gates for phase-exit 8, each driving
// the REAL worker API modules as the system-under-test:
//   · AUTH               (session-token + Origin/Host + loopback-bind, both the
//                          tRPC command/query boundary AND the WS handshake)
//   · UI-SAFE LEAKAGE    (the 8.2 projectors + the 8.5 stream vs injected secrets)
//   · APPROVAL EXACTLY-ONCE (Mac+Telegram cross-channel double-apply collapse)
export * from "./suite-core";
export * from "./fixtures";
export * from "./auth-suite";
export * from "./leakage-suite";
export * from "./exactly-once-suite";
