import { Component, input, output } from "@angular/core";
import { FormControl, ReactiveFormsModule } from "@angular/forms";
import { ButtonAtom } from "../../ui/button/button-atom.component";

@Component({
  selector: "praxis-command-bar",
  imports: [ButtonAtom, ReactiveFormsModule],
  templateUrl: "./command-bar-molecule.component.html",
  styleUrl: "./command-bar-molecule.component.css",
})
export class CommandBarMolecule {
  readonly command = input.required<FormControl<string>>();
  readonly feedback = input.required<string>();
  readonly commandSubmitted = output<string>();

  protected submit(event: SubmitEvent): void {
    event.preventDefault();
    this.commandSubmitted.emit(this.command().value);
  }
}
