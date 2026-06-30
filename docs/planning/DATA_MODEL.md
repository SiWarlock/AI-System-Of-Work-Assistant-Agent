# Data Model

Status: rough-draft planning artifact for `/arch-finalize`.

## Source-of-Truth Matrix

| Data | Authoritative System | Assistant Representation | Notes |
|---|---|---|---|
| Semantic project/meeting/person/decision/source knowledge | Workspace Markdown repo/vault | Markdown notes, frontmatter, assistant-managed sections | Obsidian editable; KnowledgeWriter is sole autonomous writer |
| Global sanitized coordination | GCL operational DB | projections, identity map, busy/free, sanitized summaries | copied to Global/Coordination Markdown for inspectability |
| Search/graph/index | GBrain per workspace | derived brain/index | rebuildable from Markdown and approved external refs |
| Workflow history | Temporal | workflow state/history | separate persistence from app operational DB |
| Operational ledger/read models | Control-plane DB | events, audit, approvals, outboxes, connector cursors, provider status, read models | SQLite local + Postgres adapter |
| Calendar events | Google Calendar | snapshots, refs, proposals | external authoritative |
| Tasks | Todoist/Linear/Asana | task refs, status snapshots, proposed actions | external authoritative |
| Raw transcripts | Granola | transcript refs/source records, synthesis in Markdown | do not re-store raw by default |
| Notebook sources | Drive/Docs + NotebookLM | managed source docs and links | direct API spike only |
| Secrets | macOS Keychain | references only | never Markdown or operational DB plaintext |

## Operational Store Domains

The app-owned operational store must support both SQLite and standard Postgres through Drizzle.

| Domain | Records | Persistence Notes |
|---|---|---|
| Workspace config | workspaces, provider matrix, egress policy, repo paths, GBrain brain refs | sensitive secrets remain Keychain refs |
| Event log | canonical product events, source envelopes, workflow triggers | append-only where practical |
| Audit | actor/action summaries, payload hashes, before/after summaries, approvals, provider use | immutable/tombstoned for deletion |
| Approvals | proposed actions, status, channel, payload hash, expiry | exactly-once state transitions |
| Outboxes | KnowledgeWriter retries, Tool Gateway retries, connector retries, GBrain sync retries | visible in System Health |
| Connector state | cursors, sync checkpoints, health, rate-limit state | no raw secret material |
| Provider state | provider profiles, capability conformance, model availability, cost/runtime defaults | API keys in Keychain |
| Read models | dashboard/project/brief/system-health projections | rebuildable from canonical records |
| GCL projections | sanitized identity, availability, deadlines, priorities, summary refs | raw workspace content forbidden by default |

## Core Contract Sketches

```ts
Workspace {
  id: string
  name: string
  type: "employer_work" | "personal_business" | "personal_life"
  dataOwner: "employer" | "user" | "client"
  markdownRepoPath: string
  gbrainBrainId: string
  defaultVisibility: "isolated" | "coordination" | "sanitized" | "full"
  egressPolicy: EgressPolicy
  providerMatrix: ProviderMatrix
}

ProviderMatrix {
  workspaceId: string
  capabilityDefaults: Record<Capability, ProviderRoute>
  allowedProviders: ProviderId[]
  rawCloudEgressEnabled: boolean
  localProviderPreference?: ProviderId
}

AgentJob {
  id: string
  workflowRunId: string
  workspaceId: string
  capability: Capability
  contextRefs: ContextRef[]
  outputSchemaId: string
  toolPolicy: ToolPolicy
  providerRoute: ProviderRoute
  maxRuntimeSeconds: number
  maxCostUsd?: number
  idempotencyKey: string
}

KnowledgeMutationPlan {
  planId: string
  workspaceId: string
  sourceRefs: SourceRef[]
  creates: NoteCreate[]
  patches: NotePatch[]
  linkMutations: LinkMutation[]
  frontmatterUpdates: FrontmatterPatch[]
  externalActionProposals: ProposedAction[]
  confidence: number
  requiresApproval: boolean
}

ExternalWriteEnvelope {
  actionId: string
  targetSystem: "calendar" | "todoist" | "linear" | "asana" | "drive" | "github" | "telegram"
  canonicalObjectKey: string
  idempotencyKey: string
  preconditions: Record<string, unknown>
  payloadHash: string
  approvalId?: string
  writeReceipt?: WriteReceipt
}
```

## Data Lifecycle Rules

- SourceEnvelope is registered before extraction.
- Agent outputs remain candidate data until schema-valid and accepted.
- KnowledgeMutationPlan becomes canonical only at KnowledgeWriter Markdown commit.
- GBrain sync/index is asynchronous after Markdown commit and never rolls back committed Markdown.
- External action becomes complete only after Tool Gateway receipt.
- Deleted source/meeting/project is purged/tombstoned across Markdown, GBrain, operational store, and read models.
- Human-owned Markdown sections are never overwritten by automated writes.

## Migration and Compatibility Rules

- Drizzle migrations must be generated and tested for SQLite and Postgres.
- Domain services depend on repository interfaces, not a concrete DB driver.
- Postgres adapter must not be a fake placeholder; it must pass the same repository contract suite as SQLite before V1 DoD.
- Supabase-specific features are out of contract unless a future ADR unlocks them.
- Temporal DB schema is managed by Temporal only.
- GBrain PGLite schema is managed by GBrain only.

