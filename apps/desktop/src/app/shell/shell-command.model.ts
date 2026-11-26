import type { ShellView } from "./shell-view.model";

export type ShellCommand =
  | { kind: "empty" }
  | { kind: "navigate"; view: ShellView }
  | { kind: "help" }
  | { kind: "unknown" }
  | { kind: "manager-prompt"; text: string };
