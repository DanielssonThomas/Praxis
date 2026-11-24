import assert from "node:assert/strict";
import test from "node:test";
import { OperationalStore } from "@praxis/state";
import { populateReports } from "./fixtures/reports.mjs";

const now = new Date("2026-08-20T13:00:00Z");
const preferences = {
  collectionEnabled: true, retentionDays: 90, visibleMetrics: [],
  allowExport: true, allowClearHistory: true,
};

test("reports deduplicate local delivery, usage and approval events and pair task timing", async (t) => {
  const { projectReports } = await import("../packages/shell/dist/report-projection.js");
  const store = new OperationalStore(":memory:");
  t.after(() => store.close());
  const { earlierDay, latestDay } = populateReports(store);
  const buckets = projectReports(store, preferences, 30, now).buckets;
  assert.equal(buckets.length, 30);
  assert.deepEqual(buckets.find(({ day }) => day === earlierDay).metrics, {
    prsOpened: 1, prsMerged: 0, ticketsCompleted: 0, taskMinutes: null,
    tokens: null, costUsd: null, interventions: 0,
  });
  assert.deepEqual(buckets.find(({ day }) => day === latestDay).metrics, {
    prsOpened: 1, prsMerged: 1, ticketsCompleted: 1, taskMinutes: 12 * 24 * 60,
    tokens: 20, costUsd: 0, interventions: 1,
  });
});

test("report preferences bound projection without deleting events or turning unavailable sources into zero", async (t) => {
  const { projectReports } = await import("../packages/shell/dist/report-projection.js");
  const store = new OperationalStore(":memory:");
  t.after(() => store.close());
  const empty = projectReports(store, preferences, 7, now);
  assert.equal(empty.buckets.at(-1).metrics.prsOpened, null);
  assert.equal(empty.buckets.at(-1).metrics.tokens, null);
  populateReports(store);
  assert.equal(projectReports(store, { ...preferences, retentionDays: 7 }, 90, now).buckets.length, 7);
  assert.deepEqual(projectReports(store, { ...preferences, collectionEnabled: false }, 7, now).buckets, []);
  const cleared = projectReports(store, { ...preferences, clearedBefore: now.toISOString() }, 7, now);
  assert.equal(cleared.buckets.length, 1);
  assert.equal(cleared.buckets[0].metrics.prsOpened, null);
  assert.equal(cleared.buckets[0].metrics.tokens, null);
  assert.ok(store.getEvent("event_opened"), "operational history survives clearing reports");
});
