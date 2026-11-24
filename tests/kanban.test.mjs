import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitHubIssueProvider, KanbanBoard } from "@praxis/kanban";
import { OperationalStore } from "@praxis/state";

const nativeId = "t_aabbcc11";
const task = { schemaVersion: 1, id: "task_hermes_fixture", title: "Native board task" };
const native = { nativeId, task, assignee: "default", status: "ready" };
const fixtureToken = "fixture-github-credential";
const issue = { provider: "github", repository: "owner/project", number: 7 };

async function fixture(t, providerEnabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "praxis-kanban-"));
  const database = join(directory, "state.sqlite");
  const store = new OperationalStore(database);
  const providerCalls = [];
  const provider = createServer((request, response) => {
    providerCalls.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    const send = (status, data) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    if (request.headers.authorization !== `Bearer ${fixtureToken}`) return send(401, {});
    const accepted = request.url === "/repos/owner/project/issues/7";
    if (!accepted) return send(404, {});
    send(200, { number: 7, html_url: "https://github.com/owner/project/issues/7", state: "open" });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  let status = native.status;
  const reader = {
    async list() { return [{ ...native, status }]; },
    async inspect(id) { return id === nativeId ? { ...native, status } : undefined; },
  };
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const github = providerEnabled ? new GitHubIssueProvider({ token: fixtureToken, origin }) : undefined;
  return {
    database, providerCalls, store, github, origin,
    setStatus(value) { status = value; },
    board: new KanbanBoard({ store, reader, provider: github, now: () => Date.parse("2026-07-28T10:30:00Z") }),
  };
}

test("board status comes from the native projection and absent provider capability is explicit", async (t) => {
  const { board, setStatus, providerCalls } = await fixture(t, false);
  const first = await board.list();
  assert.deepEqual(first.tasks, [{ ...native, links: [] }]);
  assert.equal(first.provider.available, false);
  setStatus("blocked");
  assert.equal((await board.list()).tasks[0].status, "blocked");
  await assert.rejects(board.linkIssue({ nativeId, repository: issue.repository, number: issue.number }), { code: "unsupported" });
  assert.deepEqual(providerCalls, []);
});

test("the board verifies GitHub issue IDs before durably linking and replays one association", async (t) => {
  const { board, database, providerCalls } = await fixture(t);
  const posted = await board.linkIssue({ nativeId, repository: "Owner/Project", number: 7 });
  assert.deepEqual(posted.issue, issue);
  const repeated = await board.linkIssue({ nativeId, repository: issue.repository, number: 7 });
  assert.deepEqual(repeated, posted);
  assert.deepEqual((await board.list()).tasks[0].links, [issue]);
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0], {
    method: "GET", path: "/repos/owner/project/issues/7", authorization: `Bearer ${fixtureToken}`,
  });

  const reopened = new OperationalStore(database);
  try {
    const [event] = reopened.eventsFor(task.id);
    assert.equal(event.kind, "task.issue_linked");
    assert.deepEqual(event.details.issue, issue);
    assert.equal(reopened.eventsFor(task.id).length, 1);
  } finally {
    reopened.close();
  }
});

test("invalid external IDs, unscoped native cards and provider denials leave no links", async (t) => {
  const { board, store, origin } = await fixture(t);
  await assert.rejects(board.linkIssue({ nativeId: "../unsafe", repository: issue.repository, number: 7 }), { code: "invalid_input" });
  await assert.rejects(board.linkIssue({ nativeId, repository: "owner/..", number: 7 }), { code: "invalid_input" });
  await assert.rejects(board.linkIssue({ nativeId: "t_ff11bb22", repository: issue.repository, number: 7 }), { code: "not_found" });
  await assert.rejects(board.linkIssue({ nativeId, repository: issue.repository, number: 9 }), { code: "not_found" });
  const unauthorized = new GitHubIssueProvider({ token: "invalid", origin });
  await assert.rejects(unauthorized.verify(issue), { code: "unauthorized" });
  assert.deepEqual(store.eventsFor(task.id), []);
});
