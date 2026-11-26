import { Component, input, output } from "@angular/core";
import type { KanbanIssue, KanbanIssueTarget, KanbanTask } from "../../../generated/desktop-ipc";
import { ButtonAtom } from "../../ui/button/button-atom.component";
import { parseIssueTarget } from "./kanban.model";

@Component({
  selector: "praxis-kanban-card",
  imports: [ButtonAtom],
  templateUrl: "./kanban-card-molecule.component.html",
  styleUrl: "./kanban-card-molecule.component.css",
})
export class KanbanCardMolecule {
  readonly task = input.required<KanbanTask>();
  readonly canLink = input.required<boolean>();
  readonly busy = input.required<boolean>();
  readonly linkIssue = output<KanbanIssueTarget>();
  readonly openIssue = output<KanbanIssueTarget>();
  readonly invalidIssue = output<void>();

  protected submit(event: SubmitEvent, input: HTMLInputElement): void {
    event.preventDefault();
    if (this.busy()) return;
    const target = parseIssueTarget(this.task().nativeId, input.value);
    if (target) this.linkIssue.emit(target);
    else this.invalidIssue.emit();
  }

  protected open(issue: KanbanIssue): void {
    this.openIssue.emit({ nativeId: this.task().nativeId, repository: issue.repository, number: issue.number });
  }
}
