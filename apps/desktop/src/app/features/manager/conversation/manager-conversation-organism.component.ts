import { Component, computed, inject } from "@angular/core";
import { ManagerService } from "../manager.service";
import { ManagerCardMolecule } from "../cards/manager-card-molecule.component";

@Component({
  selector: "praxis-manager-conversation",
  imports: [ManagerCardMolecule],
  templateUrl: "./manager-conversation-organism.component.html",
  styleUrl: "./manager-conversation-organism.component.css",
})
export class ManagerConversationOrganism {
  protected readonly manager = inject(ManagerService);
  protected readonly usage = computed(() => {
    const usage = this.manager.usage();
    if (usage?.metering !== "reported") return "";
    return [
      usage.inputTokens == null ? "" : `${usage.inputTokens.toLocaleString()} input`,
      usage.outputTokens == null ? "" : `${usage.outputTokens.toLocaleString()} output`,
    ].filter(Boolean).join(" · ");
  });
}
