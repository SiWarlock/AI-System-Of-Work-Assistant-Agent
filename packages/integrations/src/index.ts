// @sow/integrations — the providers-integrations external-edge layer (§8):
//   • Connector Gateway — the owner of ALL external READS (cursors, bounded
//     exponential backoff, typed health, the connector-unreachable branch;
//     no silent drops).
//   • Tool Gateway — the ONLY external-WRITE path (the external-write envelope:
//     approval policy · idempotencyKey · canonicalObjectKey · mandatory pre-write
//     existence check · payloadHash · persisted write receipt; replay reuses the
//     receipt/matched object → zero duplicate external writes — the §20.1 replay
//     gate). Plus the write outbox (hold-through-outage, replay-safe drain).
//   • NotebookPort — the notebooklm.sync Drive-backed 00–04 managed-doc upsert.
//
// PURE-boundary posture (§16): every cross-subsystem outcome is a typed Result /
// decision, never a thrown error; raw fetched/written content + credential-shaped
// strings never reach a log sink. Synthesis finalizes this barrel.
//
// SYMBOL-COLLISION resolution (Synthesis): the read-path connector transport
// (`connectors/transport.ts`) and the write-path adapter transport
// (`tools/adapters/transport.ts`) each declared a `TransportRequest`. Under a flat
// `export *` barrel those two names collide, so the less-central WRITE-path one was
// renamed `AdapterTransportRequest` (it already sat beside `AdapterTransport`); the
// connector-read `TransportRequest` — sibling of `TransportItem`/`TransportPage`/
// `TransportFailure` — keeps the plain name. No other cross-module name collides.

// ── Foundation (§16 redaction · payload hash · typed health · persistence ports · candidate gate) ──
export * from "./redaction/gateway-log-redaction";
export * from "./hash/payload-hash";
export * from "./health/health-signal";
export * from "./ports/persistence";
export * from "./candidate-gate";

// ── Connector Gateway (external READS: port · transport · backoff · sync · health · source register) ──
export * from "./connectors/port";
export * from "./connectors/transport";
export * from "./connectors/backoff";
export * from "./connectors/gateway";
export * from "./connectors/health";
export * from "./connectors/source-register";
export * from "./connectors/adapters";

// ── Tool Gateway (the ONLY external-WRITE path: envelope · existence check · receipts · gateway · outbox) ──
export * from "./tools/adapter-port";
export * from "./tools/envelope";
export * from "./tools/existence-check";
export * from "./tools/receipt-store";
export * from "./tools/gateway";
export * from "./tools/outbox";
export * from "./tools/outbox-drain";

// ── Tool-Gateway per-target write adapters (behind the envelope; injected transport + clock) ──
export * from "./tools/adapters/transport";
export * from "./tools/adapters/adapter-core";
export * from "./tools/adapters/calendar";
export * from "./tools/adapters/todoist";
export * from "./tools/adapters/linear";
export * from "./tools/adapters/asana";
export * from "./tools/adapters/drive";
export * from "./tools/adapters/github";
export * from "./tools/adapters/telegram";

// ── NotebookPort (notebooklm.sync — Drive-backed 00–04 managed-doc upsert) ──
export * from "./notebook/notebook-port";
export * from "./notebook/notebooklm-sync";
