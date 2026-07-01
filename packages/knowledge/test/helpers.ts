// Test doubles for the KnowledgeWriter core (§6, task 4.1). These are injected
// PORTS, not behavior mocks: `MemoryVaultFs` is a real in-memory tree exercising
// the exact temp-write+rename sequence, and the fault variants prove the atomic
// all-or-nothing guarantee deterministically.
import type { AuditRecord } from "@sow/contracts";
import { ok } from "@sow/contracts";
import type { AuditRepository, AuditQuery, DbResult } from "@sow/db";
import type { VaultFs } from "../src/markdown-vault/atomic-write";
import type {
  CommittedRevision,
  KnowledgeRevisionStore,
} from "../src/knowledge-writer/revision";

/** In-memory VaultFs over a flat path→content map. */
export class MemoryVaultFs implements VaultFs {
  readonly files: Map<string, string>;
  /** Optional fault injection: throw when writing/renaming a matching path. */
  failWriteOn?: (path: string) => boolean;
  failRenameOn?: (path: string) => boolean;

  constructor(initial: Record<string, string> = {}) {
    this.files = new Map(Object.entries(initial));
  }

  async read(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async list(): Promise<string[]> {
    // Canonical files only — temp staging files never surface as vault content.
    return [...this.files.keys()].filter((p) => !p.endsWith(".kwtmp"));
  }

  async write(path: string, content: string): Promise<void> {
    if (this.failWriteOn?.(path)) {
      throw new Error(`injected write fault: ${path}`);
    }
    this.files.set(path, content);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.failRenameOn?.(to)) {
      throw new Error(`injected rename fault: ${to}`);
    }
    const content = this.files.get(from);
    if (content === undefined) {
      throw new Error(`rename source missing: ${from}`);
    }
    this.files.set(to, content);
    this.files.delete(from);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  /** Canonical (non-temp) snapshot for assertions. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.files) {
      if (!k.endsWith(".kwtmp")) out[k] = v;
    }
    return out;
  }
}

/** In-memory idempotency/commit store. */
export class MemoryRevisionStore implements KnowledgeRevisionStore {
  readonly byKey = new Map<string, CommittedRevision>();
  recordCalls = 0;

  async getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CommittedRevision | undefined> {
    return this.byKey.get(idempotencyKey);
  }

  async record(revision: CommittedRevision): Promise<void> {
    this.recordCalls += 1;
    this.byKey.set(revision.idempotencyKey, revision);
  }
}

/** In-memory append-only audit repo counting appends. */
export class MemoryAuditRepo implements AuditRepository {
  readonly records: AuditRecord[] = [];

  async append(record: AuditRecord): DbResult<void> {
    this.records.push(record);
    return ok(undefined);
  }

  async query(_filter: AuditQuery, _limit: number): DbResult<AuditRecord[]> {
    return ok([...this.records]);
  }
}
