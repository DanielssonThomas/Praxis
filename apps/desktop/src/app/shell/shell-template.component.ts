import { Component, inject, signal } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { ActivityPanelOrganism, ActivityService } from "../features/activity";
import { CommandBarMolecule } from "./command-bar/command-bar-molecule.component";
import { MANAGER_PROMPT } from "./manager-prompt";
import { HostLaunchMolecule } from "./host-launch/host-launch-molecule.component";
import { ShellMenuOrganism } from "./menu/shell-menu-organism.component";
import { commandHelp, resolveCommand, views } from "./shell-navigation";
import { ShellNavigationService } from "./shell-navigation.service";

@Component({
  selector: "praxis-shell",
  imports: [RouterOutlet, ActivityPanelOrganism, CommandBarMolecule, HostLaunchMolecule, ShellMenuOrganism],
  templateUrl: "./shell-template.component.html",
  styleUrl: "./shell-template.component.css",
})
export class ShellTemplate {
  private readonly managerPrompt = inject(MANAGER_PROMPT);
  protected readonly navigation = inject(ShellNavigationService);
  protected readonly activity = inject(ActivityService);
  protected readonly views = views;
  protected readonly feedback = signal("");

  protected async submit(value: string): Promise<void> {
    const command = resolveCommand(value, this.navigation.view().id);
    switch (command.kind) {
      case "empty":
        return;
      case "navigate":
        this.navigation.command.reset();
        this.feedback.set("");
        await this.navigation.navigate(command.view.id);
        return;
      case "help":
        this.navigation.command.reset();
        this.feedback.set(commandHelp);
        return;
      case "manager-prompt": {
        const error = this.managerPrompt(command.text);
        if (error === undefined) this.navigation.command.reset();
        this.feedback.set(error ?? "");
        return;
      }
      case "unknown":
        this.feedback.set("Unknown command. Try /help.");
    }
  }
}
