import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopBrowserSuite } from "../../shell/desktop-browser-fixture.mjs";

const { open } = desktopBrowserSuite();
const wide = { width: 1280, height: 800 };

test("Setup is a keyboard-accessible configuration destination from a fresh window", async (t) => {
  const page = await open(t, wide, "setup-menu");
  await page.getByRole("heading", { name: "Manager", level: 1 }).waitFor();
  await page.getByRole("button", { name: "Menu" }).press("Enter");
  const config = page.getByRole("group", { name: "Configuration" });
  await config.getByRole("link", { name: "Settings", exact: true }).waitFor();
  const setup = config.getByRole("link", { name: "Setup", exact: true });
  assert.equal(await setup.count(), 1, "the configuration menu must offer a Setup destination");
  await setup.press("Enter");
  await page.getByRole("heading", { name: "Setup", level: 1 }).waitFor();
});
