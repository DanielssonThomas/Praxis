import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, withHashLocation } from "@angular/router";
import { routes } from "./app/shell/shell.routes";
import { ShellTemplate } from "./app/shell/shell-template.component";

void bootstrapApplication(ShellTemplate, {
  providers: [provideRouter(routes, withHashLocation())],
});
