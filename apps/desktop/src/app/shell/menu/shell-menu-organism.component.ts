import { Component, ElementRef, input, signal, viewChild } from "@angular/core";
import { RouterLink } from "@angular/router";
import { ButtonAtom } from "../../ui/button/button-atom.component";
import type { ShellView } from "../shell-view.model";

@Component({
  selector: "praxis-shell-menu",
  imports: [ButtonAtom, RouterLink],
  templateUrl: "./shell-menu-organism.component.html",
  styleUrl: "./shell-menu-organism.component.css",
  host: { "(document:keydown.escape)": "close()" },
})
export class ShellMenuOrganism {
  readonly views = input.required<readonly ShellView[]>();
  readonly activeView = input.required<string>();
  protected readonly open = signal(false);
  private readonly toggle = viewChild.required("toggle", { read: ElementRef<HTMLButtonElement> });

  protected close(event?: MouseEvent): void {
    if (!this.open() || event?.ctrlKey || event?.metaKey || event?.shiftKey || event?.altKey || (event && event.button !== 0)) return;
    this.open.set(false);
    this.toggle().nativeElement.focus();
  }
}
