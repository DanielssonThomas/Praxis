import { Component, computed, ElementRef, input, output, signal, viewChild, viewChildren } from "@angular/core";
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
  readonly activityAvailable = input(false);
  readonly activityOpened = input(false);
  readonly activityToggled = output<void>();
  protected readonly open = signal(false);
  protected readonly sections = computed(() => [
    { id: "workspace", label: "Workspace", views: this.views().filter(({ section }) => section === "workspace") },
    { id: "configuration", label: "Configuration", views: this.views().filter(({ section }) => section === "configuration") },
  ]);
  private readonly toggle = viewChild.required("toggle", { read: ElementRef<HTMLButtonElement> });
  private readonly destinations = viewChildren<ElementRef<HTMLAnchorElement>>("destination");

  protected focusNavigation(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    this.destinations()[0]?.nativeElement.focus();
  }

  protected close(event?: MouseEvent): void {
    if (!this.open() || event?.ctrlKey || event?.metaKey || event?.shiftKey || event?.altKey || (event && event.button !== 0)) return;
    this.open.set(false);
    this.toggle().nativeElement.focus();
  }
}
