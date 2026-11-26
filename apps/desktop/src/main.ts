import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, withHashLocation } from "@angular/router";
import { inject } from "@angular/core";
import { ManagerService } from "./app/features/manager";
import { MANAGER_PROMPT } from "./app/shell/manager-prompt";
import { routes } from "./app/shell/shell.routes";
import { ShellTemplate } from "./app/shell/shell-template.component";

void bootstrapApplication(ShellTemplate, {
  providers: [
    provideRouter(routes, withHashLocation()),
    {
      provide: MANAGER_PROMPT,
      useFactory: () => {
        const manager = inject(ManagerService);
        return (text: string) => manager.submit(text);
      },
    },
  ],
});
