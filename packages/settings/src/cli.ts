import { createSettingsServer } from "./http.js";
import { settingsPath } from "./index.js";

const port = Number(process.env.PRAXIS_PORT ?? 3210);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("Set PRAXIS_PORT to an integer from 0 to 65535.");
}

const server = createSettingsServer(settingsPath());
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address !== null && typeof address !== "string") {
    console.log(`Praxis settings at http://127.0.0.1:${address.port}/settings`);
  }
});
