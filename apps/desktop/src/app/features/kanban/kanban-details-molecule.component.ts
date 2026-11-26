import { Component, ElementRef, afterRenderEffect, input, output, viewChild } from "@angular/core";
import type { KanbanIssue, KanbanIssueTarget, KanbanTask } from "../../../generated/desktop-ipc";
import { ButtonAtom } from "../../ui/button/button-atom.component";
import { nativeStatusLabel, parseIssueTarget } from "./kanban.model";

@Component({
  selector: "praxis-kanban-details",
  imports: [ButtonAtom],
  templateUrl: "./kanban-details-molecule.component.html",
  styleUrl: "./kanban-details-molecule.component.css",
})
export class KanbanDetailsMolecule {
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>("dialog");
  readonly task = input.required<KanbanTask | null>();
  readonly canLink = input.required<boolean>();
  readonly busy = input.required<boolean>();
  readonly status = input.required<string>();
  readonly providerMessage = input.required<string>();
  readonly closed = output<void>();
  readonly refreshRequested = output<void>();
  readonly linkIssue = output<KanbanIssueTarget>();
  readonly openIssue = output<KanbanIssueTarget>();
  readonly invalidIssue = output<string>();
  protected readonly nativeStatusLabel = nativeStatusLabel;

  constructor() {
    afterRenderEffect({ write: () => {
      const dialog = this.dialog().nativeElement;
      if (this.task()) {
        if (!dialog.open) dialog.showModal();
      } else if (dialog.open) {
        dialog.close();
      }
    } });
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected submit(event: SubmitEvent, task: KanbanTask, input: HTMLInputElement): void {
    event.preventDefault();
    if (this.busy() || !this.canLink()) return;
    const target = parseIssueTarget(task.nativeId, input.value);
    if (target) this.linkIssue.emit(target);
    else this.invalidIssue.emit(task.nativeId);
  }

  protected open(task: KanbanTask, issue: KanbanIssue): void {
    if (this.busy()) return;
    this.openIssue.emit({ nativeId: task.nativeId, repository: issue.repository, number: issue.number });
  }
}
