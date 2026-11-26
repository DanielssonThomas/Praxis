# Praxis desktop development

Use Node.js 24.22.3 from [`.node-version`](../.node-version) and its bundled npm 11.19.1. The npm lockfile pins Angular 21.2.26, Angular CLI and builder 21.2.31, TypeScript 5.9.3 and Playwright 1.65.1.

```sh
npm ci
npm run start:desktop
npm run build:desktop
npm run check:desktop-composition
npm exec -- playwright install chromium
npm run test:desktop
```

The Angular CLI handles the single frontend application in the existing npm workspace. The current build and CI have no project orchestration requirement that needs Nx. The production build writes the web assets for Tauri to `apps/desktop/dist/browser`. The app uses hash-based Angular routing so the same bundled entry point serves every route.

`apps/desktop/src/app/shell` owns bootstrap composition, routes and the permanent command bar. Domain views expose an entry point in `features/<domain>/index.ts`; keep components and services that serve only that domain inside it. Use `*.model.ts` for named frontend models and colocate a page's component, template, styles and related checks. The shared UI directory owns reusable primitives. The menu and command bar use the same accessible native button atom.

Follow Axiom's pinned [Atomic UI profile](https://github.com/DanielssonThomas/Axiom/blob/96014e73ca14111be83c448898e41559f0f87f88/profiles/ui-atomic/PROFILE.md). Components import strictly lower layers in the atom, molecule, organism and template hierarchy. The composition check reads the TypeScript dependencies and verifies layer direction, feature entry points and colocated component resources. The shell browser suite exercises the built output at 1280 × 800 and 360 × 620 for layout, keyboard focus, command feedback and draft restoration. Set `PRAXIS_UI_EVIDENCE_DIR` to retain Playwright traces. CI uploads them from the Angular desktop shell job.

For the existing Node host's browser surface and integration commands, see [application shell](shell.md).
