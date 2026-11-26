import { Component, ElementRef, Injector, afterNextRender, computed, inject } from "@angular/core";
import { ButtonAtom } from "../../../ui/button/button-atom.component";
import { ManagerService } from "../manager.service";
import { ManagerCardMolecule } from "../cards/manager-card-molecule.component";
import type { ManagerCard, ManagerTurn } from "../manager-view.model";

@Component({
  selector: "praxis-manager-conversation",
  imports: [ButtonAtom, ManagerCardMolecule],
  templateUrl: "./manager-conversation-organism.component.html",
  styleUrl: "./manager-conversation-organism.component.css",
})
export class ManagerConversationOrganism {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly manager = inject(ManagerService);
  protected readonly usage = computed(() => {
    const usage = this.manager.usage();
    if (usage?.metering !== "reported") return "";
    return [
      usage.inputTokens == null ? "" : `${usage.inputTokens.toLocaleString()} input tokens`,
      usage.outputTokens == null ? "" : `${usage.outputTokens.toLocaleString()} output tokens`,
    ].filter(Boolean).join(" · ");
  });

  protected selectedCard(turn: ManagerTurn): ManagerCard | undefined {
    const selected = this.manager.selectedCard();
    if (selected?.turnId === turn.id) return turn.cards.find(({ key }) => key === selected.key);
    return undefined;
  }

  protected triggerId(turn: ManagerTurn, card: ManagerCard): string {
    return `manager-card-${turn.id}-${card.key}`;
  }

  protected detailId(turn: ManagerTurn): string {
    return `manager-detail-${turn.id}`;
  }

  protected toggleCard(turn: ManagerTurn, card: ManagerCard): void {
    if (this.selectedCard(turn)?.key === card.key) {
      this.closeCard(turn, card);
      return;
    }
    this.manager.selectCard(turn.id, card.key);
    afterNextRender({ write: () => {
      this.host.nativeElement.ownerDocument.getElementById(this.detailId(turn))
        ?.scrollIntoView({ block: "nearest" });
    } }, { injector: this.injector });
  }

  protected closeCard(turn: ManagerTurn, card: ManagerCard, event?: Event): void {
    event?.stopPropagation();
    this.focusTrigger(turn, card);
    this.manager.closeCard();
  }

  protected dismissCard(turn: ManagerTurn, card: ManagerCard, response: HTMLElement): void {
    const index = turn.cards.indexOf(card);
    const adjacent = turn.cards[index + 1] ?? turn.cards[index - 1];
    if (adjacent) this.focusTrigger(turn, adjacent);
    else response.focus();
    this.manager.dismiss(turn.id, card.key);
  }

  private focusTrigger(turn: ManagerTurn, card: ManagerCard): void {
    this.host.nativeElement.ownerDocument.getElementById(this.triggerId(turn, card))?.focus();
  }
}
