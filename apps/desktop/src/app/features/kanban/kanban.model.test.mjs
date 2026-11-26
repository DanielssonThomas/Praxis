import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByNativeStatus, parseIssueTarget } from "./kanban.model.ts";

test("Kanban issue drafts preserve exact positive numbers and reject unsafe input", () => {
  const id = "t_01234567";
  assert.deepEqual(parseIssueTarget(id, " fixture/project#9007199254740991 "), {
    nativeId: id, repository: "fixture/project", number: Number.MAX_SAFE_INTEGER,
  });
  for (const text of ["missing-repository#42", "fixture/project#0", "fixture/project#-1",
    "fixture/project#2.5", "fixture/project#9007199254740992"]) {
    assert.equal(parseIssueTarget(id, text), undefined);
  }
});

test("native task columns follow observed status and retain task identity", () => {
  const first = { nativeId: "t_01234567", status: "ready" };
  const blocked = { nativeId: "t_01234568", status: "blocked" };
  const second = { nativeId: "t_01234569", status: "ready" };
  assert.deepEqual(groupByNativeStatus([first, blocked, second]), [
    { status: "ready", tasks: [first, second] },
    { status: "blocked", tasks: [blocked] },
  ]);
});
