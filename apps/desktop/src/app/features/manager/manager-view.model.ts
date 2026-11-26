import type { ManagerResource } from "../../native/desktop-bridge.service";

export interface ManagerCard {
  readonly key: number;
  readonly value: ManagerResource;
}

export interface ManagerTurn {
  readonly id: string;
  readonly prompt: string;
  readonly response: string;
  readonly cards: readonly ManagerCard[];
}
