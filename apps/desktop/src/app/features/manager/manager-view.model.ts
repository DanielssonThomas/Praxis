import type { ManagerResource } from "../../native/desktop-bridge.service";

export interface ManagerCard {
  readonly key: string;
  readonly title: string;
  readonly value: ManagerResource;
}

export interface ManagerCardSelection {
  readonly turnId: string;
  readonly key: string;
}

export interface ManagerTurn {
  readonly id: string;
  readonly prompt: string;
  readonly response: string;
  readonly cards: readonly ManagerCard[];
  readonly dismissedCards: readonly string[];
  readonly presentedCards: boolean;
}

export function managerCards(resources: ManagerResource[]): ManagerCard[] {
  const unavailable = { task: 0, session: 0 };
  return resources.map((value) => {
    switch (value.kind) {
      case "task":
        return { key: `task:${value.task.id}`, title: value.task.title, value };
      case "session":
        return { key: `session:${value.session.id}`, title: "Worker session", value };
      case "unavailable":
        // Only the ordered occurrence of each type is exposed for unavailable references.
        return {
          key: `unavailable:${value.resource}:${unavailable[value.resource]++}`,
          title: value.resource === "task" ? "Task unavailable" : "Worker session unavailable",
          value,
        };
    }
  });
}
