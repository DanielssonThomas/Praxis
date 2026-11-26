import { InjectionToken } from "@angular/core";

export const MANAGER_PROMPT = new InjectionToken<(text: string) => string | undefined>("Manager prompt");
