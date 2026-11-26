import { Component, input, output } from "@angular/core";
import { ButtonAtom } from "../button/button-atom.component";

@Component({
  selector: "praxis-operator-unlock",
  imports: [ButtonAtom],
  templateUrl: "./operator-unlock-molecule.component.html",
  styleUrl: "./operator-unlock-molecule.component.css",
})
export class OperatorUnlockMolecule {
  readonly formName = input.required<string>();
  readonly action = input.required<string>();
  readonly busy = input(false);
  readonly credentialSubmitted = output<string>();

  protected submit(event: SubmitEvent, field: HTMLInputElement): void {
    event.preventDefault();
    const credential = field.value.trim();
    field.value = "";
    if (credential && !this.busy()) this.credentialSubmitted.emit(credential);
  }
}
