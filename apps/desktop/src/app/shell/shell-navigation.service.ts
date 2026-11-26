import { inject, Injectable, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { FormControl } from "@angular/forms";
import { NavigationEnd, Router } from "@angular/router";
import { filter } from "rxjs";
import { managerView, views } from "./shell-navigation";
import type { ShellView } from "./shell-view.model";

@Injectable({ providedIn: "root" })
export class ShellNavigationService {
  private readonly router = inject(Router);
  private readonly drafts = new Map<string, string>();
  private readonly current = signal<ShellView>(managerView);

  readonly view = this.current.asReadonly();
  readonly command = new FormControl("", { nonNullable: true });

  constructor() {
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      takeUntilDestroyed(),
    ).subscribe(({ urlAfterRedirects }) => {
      const path = this.router.parseUrl(urlAfterRedirects).root.children["primary"]?.segments[0]?.path;
      const next = views.find(({ id }) => id === path) ?? managerView;
      const previous = this.current().id;
      if (previous === next.id) return;
      if (this.command.value) this.drafts.set(previous, this.command.value);
      else this.drafts.delete(previous);
      this.current.set(next);
      this.command.setValue(this.drafts.get(next.id) ?? "");
    });
  }

  async navigate(viewId: string): Promise<void> {
    await this.router.navigate(["/", viewId]);
  }
}
