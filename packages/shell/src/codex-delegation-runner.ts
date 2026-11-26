import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventIdSchema } from "@praxis/contracts";
import { CodexDelegationError, codexDelegationFromEnv } from "./codex-delegation.js";

function send(value: unknown): Promise<void> {
  return new Promise((resolve) => {
    if (!process.connected || !process.send) return resolve();
    try {
      process.send(value as object, () => {
        if (process.connected) process.disconnect?.();
        resolve();
      });
    } catch { resolve(); }
  });
}

async function trustedOperator(): Promise<void> {
  const expected = process.env.PRAXIS_OPERATOR_TOKEN_DIGEST;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || process.stdin.isTTY) throw new Error("Supply the local operator credential through stdin.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 260) throw new Error("The local operator credential is invalid.");
    chunks.push(chunk);
  }
  const token = Buffer.concat(chunks).toString("utf8").trimEnd();
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)
    || !timingSafeEqual(createHash("sha256").update(token).digest(), Buffer.from(expected, "hex"))) {
    throw new Error("The local operator credential is invalid.");
  }
}

async function inVerificationEnvironment<T>(operation: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "praxis-verifier-"));
  const keep = new Set(["PATH", "LANG", "LC_ALL", "TMPDIR"]);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  process.env.HOME = home;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try { return await operation(); } finally { await rm(home, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  const [operation, request, sourceDigest, receiptDigest] = process.argv.slice(2);
  const requestId = eventIdSchema.parse(request);
  const service = await codexDelegationFromEnv();
  if (!service) throw new Error("Codex delegation is unavailable.");
  try {
    if (operation === "run") {
      if (!sourceDigest || !/^[a-f0-9]{64}$/.test(sourceDigest)) throw new Error("The delegation approval is unavailable.");
      await service.runApproved(requestId, sourceDigest, send);
      return;
    }

    await trustedOperator();
    if (operation === "result") console.log(JSON.stringify(await service.result(requestId)));
    else if (operation === "review") console.log(JSON.stringify(await service.review(requestId)));
    else if (operation === "complete" && /^sha256:[a-f0-9]{64}$/.test(sourceDigest ?? "") && /^sha256:[a-f0-9]{64}$/.test(receiptDigest ?? "")) {
      const result = await inVerificationEnvironment(() => service.complete(requestId, sourceDigest, receiptDigest));
      console.log(JSON.stringify(result));
      if (!result.verification.conforms) process.exitCode = 1;
    } else throw new Error("Use result, review, or complete with the reviewed source and receipt digests.");
  } finally {
    service.close();
  }
}

void main().catch(async (error) => {
  if (process.argv[2] === "run") {
    if (error instanceof CodexDelegationError && error.code === "invalidated") await send({ invalidated: true });
  } else {
    console.error("The local worker result, operator authority or effective-policy review is unavailable.");
  }
  process.exitCode = 1;
});
