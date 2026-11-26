import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const desktopEnvironmentKeys = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY',
  'GDK_BACKEND', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'WEBKIT_DISABLE_COMPOSITING_MODE'];
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
export const enter = '\uE007';
export const tab = '\uE004';

async function loopbackPort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function eventually(observe, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const observed = await observe();
    if (observed) return observed;
    await delay(125);
  }
  assert.fail(description);
}

class DriverError extends Error {
  constructor(error, method, pathname, status) {
    super(`WebKitWebDriver ${method} ${pathname}: ${error} (${status})`);
    this.code = error;
  }
}

async function request(origin, method, pathname, payload, timeout = 6_000) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    signal: AbortSignal.timeout(timeout),
    ...(payload === undefined ? {} : {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    }),
  });
  const { value } = await response.json();
  if (!response.ok) throw new DriverError(value?.error ?? 'unknown error', method, pathname, response.status);
  return value;
}

export function desktopPackageRoot(deb, directory) {
  if (process.env.PRAXIS_DESKTOP_USE_INSTALLED === '1') return '/';
  const extracted = join(directory, 'installed');
  execFileSync('dpkg-deb', ['--extract', deb, extracted], { timeout: 20_000 });
  return extracted;
}

export async function startDesktop(binary, { environment = {}, args = [], startupTimeout = 25_000 } = {}) {
  const port = await loopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const hostDesktop = Object.fromEntries(desktopEnvironmentKeys.flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const driver = spawn('WebKitWebDriver', [`--port=${port}`, '--host=127.0.0.1'], {
    env: {
      ...hostDesktop,
      ...environment,
      TAURI_AUTOMATION: 'true',
      TAURI_WEBVIEW_AUTOMATION: 'true',
    },
    stdio: 'ignore',
  });
  let spawnError;
  driver.on('error', (error) => { spawnError = error; });
  let session;
  async function close() {
    try {
      if (session) {
        const closing = session;
        session = undefined;
        try {
          await request(origin, 'DELETE', `/session/${closing}`, undefined, 3_000);
        } catch (error) {
          if (error.code !== 'invalid session id' && error.code !== 'no such window') throw error;
        }
      }
    } finally {
      if (driver.pid && driver.exitCode === null && driver.signalCode === null) {
        const exited = once(driver, 'exit');
        driver.kill('SIGTERM');
        await exited;
      }
    }
  }
  try {
    await eventually(async () => {
      if (spawnError) throw spawnError;
      if (driver.exitCode !== null) throw new Error('WebKitWebDriver exited during startup.');
      try {
        return (await request(origin, 'GET', '/status'))?.ready;
      } catch (error) {
        if (error.cause?.code === 'ECONNREFUSED') return false;
        throw error;
      }
    }, 'WebKitWebDriver did not become ready.');
    const opened = await request(origin, 'POST', '/session', {
      capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': { binary, args } } },
    }, startupTimeout);
    session = opened.sessionId;
    assert.equal(typeof session, 'string');
    return new DesktopWindow(opened.capabilities, (method, path, body) =>
      request(origin, method, `/session/${session}${path}`, body), close);
  } catch (error) {
    await close();
    throw error;
  }
}

class DesktopWindow {
  constructor(capabilities, request, close) {
    this.capabilities = capabilities;
    this.request = request;
    this.close = close;
  }

  execute(script, ...args) {
    return this.request('POST', '/execute/sync', { script, args });
  }

  handles() {
    return this.request('GET', '/window/handles');
  }

  resize(width, height) {
    return this.request('POST', '/window/rect', { width, height });
  }

  async screenshot(file) {
    const encoded = await this.request('GET', '/screenshot');
    await writeFile(file, Buffer.from(encoded, 'base64'));
  }

  async element(selector) {
    const result = await eventually(async () => {
      try {
        return await this.request('POST', '/element', { using: 'css selector', value: selector });
      } catch (error) {
        if (error.code === 'no such element') return undefined;
        throw error;
      }
    }, `Expected desktop control ${selector} did not appear.`);
    const prefix = `/element/${result[elementKey]}`;
    return {
      text: () => this.request('GET', `${prefix}/text`),
      click: () => this.request('POST', `${prefix}/click`, {}),
      clear: () => this.request('POST', `${prefix}/clear`, {}),
      type: (text) => this.request('POST', `${prefix}/value`, { text }),
    };
  }

  async waitForText(selector, expected) {
    const actual = await eventually(async () => {
      const text = await (await this.element(selector)).text();
      return (typeof expected === 'string' ? text === expected : expected.test(text)) ? text : undefined;
    }, `Expected visible desktop text did not appear at ${selector}.`);
    return actual;
  }
}
