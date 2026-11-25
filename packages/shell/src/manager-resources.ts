import { sessionIdSchema, taskIdSchema } from "@praxis/contracts";
import type { RuntimeSessionStatus, Session, SessionId, Task, TaskId } from "@praxis/contracts";
import type { HermesRuntime } from "@praxis/hermes-runtime";
import { inspectScopedTask, inspectScopedWorker } from "@praxis/mcp";
import type { McpGrant } from "@praxis/mcp";
import type { OperationalStore } from "@praxis/state";

export type ManagerReference = { kind: "task"; id: TaskId } | { kind: "session"; id: SessionId };
export type ManagerResource = { kind: "task"; task: Task }
  | { kind: "session"; session: Session; status?: RuntimeSessionStatus }
  | { kind: "unavailable"; resource: ManagerReference["kind"] };
export type ReadManagerResources = (references: ManagerReference[]) => Promise<ManagerResource[]>;

const marker = /^\[\[praxis:(task|session):([A-Za-z0-9._-]+)\]\]$/;

export function splitManagerReferences(text: string): { text: string; references: ManagerReference[] } {
  const lines = text.trimEnd().split("\n");
  const references = new Map<string, ManagerReference>();
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    const match = marker.exec(line);
    if (!match) break;
    end -= 1;
    if (match[1] === "task") {
      const parsed = taskIdSchema.safeParse(match[2]);
      if (parsed.success) references.set(line, { kind: "task", id: parsed.data });
    } else {
      const parsed = sessionIdSchema.safeParse(match[2]);
      if (parsed.success) references.set(line, { kind: "session", id: parsed.data });
    }
  }
  return {
    text: end === lines.length ? text : lines.slice(0, end).join("\n").trimEnd(),
    references: [...references.values()].reverse().slice(0, 4),
  };
}

export function unavailableManagerResources(references: ManagerReference[]): ManagerResource[] {
  return references.map(({ kind }) => ({ kind: "unavailable", resource: kind }));
}

export async function resolveManagerResource(
  store: OperationalStore, runtime: Pick<HermesRuntime, "inspectAssignment">, grant: McpGrant, reference: ManagerReference,
): Promise<ManagerResource> {
  try {
    if (reference.kind === "task") return { kind: "task", task: inspectScopedTask(store, grant, reference.id) };
    const worker = await inspectScopedWorker({ store, runtime }, grant, reference.id);
    return { kind: "session", session: worker.session,
      status: worker.runtime.availability === "available" ? worker.runtime.snapshot.status : undefined };
  } catch {
    return { kind: "unavailable", resource: reference.kind };
  }
}
