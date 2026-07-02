// @sow/worker — the supervised Temporal worker process (§9 / §16 supervision).
//
// The THIN Temporal binding on top of @sow/workflows: worker bootstrap + the
// single-active-instance lease (LIFE-1), activity registration (wiring the
// activity ports to the real @sow/integrations Tool/Connector Gateways +
// @sow/knowledge KnowledgeWriter + @sow/providers Broker adapters), durable
// schedule registration (LIFE-2), and the Temporal-unavailable degraded mode.
// Temporal-server-dependent integration tests are gated behind SOW_TEMPORAL=1
// (default-skipped, mirroring Phase-2's SOW_PG_DOCKER), so a missing dev server
// never blocks the suite.
//
// Synthesis-finalized barrel: a flat `export *` over the worker's modules (NOT
// test/support). Symbol names are unique across the two modules, so no collision
// rename was required at synthesis.

// --- src/lease/ — the PURE single-active-instance lease decision (LIFE-1) ----
export * from "./lease/instanceLease";

// --- src/temporal/ — the worker bootstrap + degraded-mode decision -----------
export * from "./temporal/worker";
