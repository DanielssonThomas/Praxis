import { afterRenderEffect, Component, computed, ElementRef, input, output, signal, viewChild, viewChildren } from "@angular/core";
import { toObservable, toSignal } from "@angular/core/rxjs-interop";
import { FormControl, ReactiveFormsModule } from "@angular/forms";
import { startWith, switchMap } from "rxjs";
import { ButtonAtom } from "../../ui/button/button-atom.component";
import { matchSlashCommands } from "../shell-navigation";

@Component({
  selector: "praxis-command-bar",
  imports: [ButtonAtom, ReactiveFormsModule],
  templateUrl: "./command-bar-molecule.component.html",
  styleUrl: "./command-bar-molecule.component.css",
})
export class CommandBarMolecule {
  readonly command = input.required<FormControl<string>>();
  readonly feedback = input.required<string>();
  readonly placeholder = input.required<string>();
  readonly commandSubmitted = output<string>();

  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>("field");
  private readonly optionNodes = viewChildren<ElementRef<HTMLLIElement>>("suggestion");
  private readonly showSuggestions = signal(false);
  private readonly selected = signal(-1);
  private readonly value = toSignal(toObservable(this.command).pipe(
    switchMap((command) => command.valueChanges.pipe(startWith(command.value))),
  ), { initialValue: "" });

  protected readonly matches = computed(() => this.showSuggestions() ? matchSlashCommands(this.value()) : []);
  protected readonly active = computed(() => this.matches().find((_, index) => index === this.selected()));
  protected readonly activeId = computed(() => {
    const match = this.active();
    return match ? "command-" + match.id : null;
  });

  constructor() {
    afterRenderEffect(() => {
      if (this.active()) this.optionNodes()[this.selected()]?.nativeElement.scrollIntoView({ block: "nearest" });
    });
  }

  protected updateSuggestions(): void {
    this.selected.set(-1);
    this.showSuggestions.set(true);
  }

  protected closeSuggestions(): void {
    this.showSuggestions.set(false);
    this.selected.set(-1);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const count = this.matches().length;
    if (event.key === "Escape" && count) {
      event.preventDefault();
      event.stopPropagation();
      this.closeSuggestions();
    } else if (count && (event.key === "ArrowDown" || event.key === "ArrowUp") && !event.shiftKey) {
      event.preventDefault();
      const current = this.selected();
      const next = event.key === "ArrowDown" ? current + 1 : current < 0 ? count - 1 : current - 1;
      this.selected.set((next + count) % count);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (event.repeat) return;
      const active = this.active();
      this.send(active ? "/" + active.id : this.command().value);
    }
  }

  protected send(value: string, event?: SubmitEvent): void {
    event?.preventDefault();
    this.field().nativeElement.focus({ preventScroll: true });
    this.closeSuggestions();
    this.commandSubmitted.emit(value);
  }
}
