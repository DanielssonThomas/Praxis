import { Component, inject, signal } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { CommandBarMolecule } from "./command-bar/command-bar-molecule.component";
import { ShellMenuOrganism } from "./menu/shell-menu-organism.component";
import { commandHelp, resolveCommand, views } from "./shell-navigation";
import { ShellNavigationService } from "./shell-navigation.service";

@Component({
  selector: "praxis-shell",
  imports: [RouterOutlet, CommandBarMolecule, ShellMenuOrganism],
  templateUrl: "./shell-template.component.html",
  styleUrl: "./shell-template.component.css",
})
export class ShellTemplate {
  protected readonly navigation = inject(ShellNavigationService);
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
      case "manager-prompt":
        this.feedback.set("The desktop Manager connection is unavailable.");
        return;
      case "unknown":
        this.feedback.set("Unknown command. Try /help.");
    }
  }
}
