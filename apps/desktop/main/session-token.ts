import { randomBytes } from "node:crypto";

// The per-launch session token (§5 / REQ-S-004, task 9.2). Minted fresh each
// launch, held ONLY in memory, NEVER written to disk and NEVER logged. Electron
// main MINTS it; the worker only VERIFIES it. The renderer receives it solely
// through the preload bridge (`session:getToken`), so other localhost clients
// cannot discover it and reach the loopback worker.

export interface SessionTokenHolder {
  /** Mint a fresh cryptographically-random token, replacing any prior one. */
  mint(): string;
  /** The current token; throws if requested before the launch mint. */
  get(): string;
}

export function makeSessionTokenHolder(): SessionTokenHolder {
  let token: string | null = null;
  return {
    mint(): string {
      token = randomBytes(32).toString("base64url");
      return token;
    },
    get(): string {
      if (token === null) throw new Error("session token requested before mint");
      return token;
    },
  };
}

/** The app-wide holder: main mints at startup; the `session:getToken` IPC reads it. */
export const sessionToken: SessionTokenHolder = makeSessionTokenHolder();
