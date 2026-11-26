import { Component, ElementRef, computed, input, output, signal, viewChild } from "@angular/core";
import type { KanbanIssueTarget } from "../../../generated/desktop-ipc";
import { nativeStatusLabel, taskTriggerId } from "./kanban.model";
import type { KanbanColumn, KanbanTaskFeedback } from "./kanban.model";
import { KanbanCardMolecule } from "./kanban-card-molecule.component";
import { KanbanDetailsMolecule } from "./kanban-details-molecule.component";

@Component({
  selector: "praxis-kanban-board",
  imports: [KanbanCardMolecule, KanbanDetailsMolecule],
  templateUrl: "./kanban-board-organism.component.html",
  styleUrl: "./kanban-board-organism.component.css",
})
export class KanbanBoardOrganism {
  private readonly region = viewChild.required<ElementRef<HTMLElement>>("region");
  private readonly selection = signal<string | null>(null);
  readonly columns = input.required<KanbanColumn[]>();
  readonly canLink = input.required<boolean>();
  readonly busy = input.required<boolean>();
  readonly boardStatus = input.required<string>();
  readonly providerMessage = input.required<string>();
  readonly taskFeedback = input.required<KanbanTaskFeedback | null>();
  readonly refreshRequested = output<void>();
  readonly linkIssue = output<KanbanIssueTarget>();
  readonly openIssue = output<KanbanIssueTarget>();
  readonly invalidIssue = output<string>();
  protected readonly nativeStatusLabel = nativeStatusLabel;
  protected readonly announcement = signal("");
  protected readonly selectedTask = computed(() => {
    const selected = this.selection();
    if (selected === null) return null;
    return this.columns().flatMap(({ tasks }) => tasks).find(({ nativeId }) => nativeId === selected) ?? null;
  });
  protected readonly detailStatus = computed(() => {
    const feedback = this.taskFeedback();
    return feedback && feedback.nativeId === this.selection() ? feedback.message : this.boardStatus();
  });

  protected open(nativeId: string): void {
    this.announcement.set("");
    this.selection.set(nativeId);
  }

  protected close(): void {
    const selected = this.selection();
    if (selected === null) return;
    const region = this.region().nativeElement;
    const trigger = region.ownerDocument.getElementById(taskTriggerId(selected));
    if (!trigger) this.announcement.set("The selected task is no longer on the board.");
    this.selection.set(null);
    (trigger ?? region).focus();
  }
}
