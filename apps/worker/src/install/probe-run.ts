// Install-doctor shared exec total-guard (task 11.5-a/b/c, §13). The ONE place the injected
// RunCommand is invoked under a §16 never-throw guard — reused by every collector
// (prerequisite / security / posture) so the sibling files never duplicate the guard AND never
// form a value-level import cycle (this module type-imports the port contract; the collectors
// value-import `safeRun` from here).
import type { RunCommand, CommandRequest, CommandOutcome } from "./probe-collectors";

/** Run an injected command TOTALLY — even a thrown port becomes a typed fault (§16 never-throw). */
export async function safeRun(run: RunCommand, req: CommandRequest): Promise<CommandOutcome> {
  try {
    return await run(req);
  } catch {
    return { ok: false, code: "unknown", message: "exec_threw" };
  }
}
