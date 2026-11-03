import assert from "node:assert/strict";
import { test } from "node:test";
import { STALE_NOTICE_MS, staleNotice, staleNoticeAt } from "../lib/format.ts";

const since = "2026-01-05T10:00:00.000Z";
const at = Date.parse(since);

test("no notice while the cache is in step", () => {
  assert.equal(staleNotice(null, at), null);
  assert.equal(staleNotice({ staleSince: null, reason: null }, at), null);
  assert.equal(staleNoticeAt({ staleSince: null }), null);
});

test("a brief reload shows nothing; a lasting one names its start and cause", () => {
  const health = { staleSince: since, reason: "tasks plugin restarted" };
  assert.equal(staleNoticeAt(health), at + STALE_NOTICE_MS);
  assert.equal(staleNotice(health, at + STALE_NOTICE_MS - 1), null);
  const text = staleNotice(health, at + STALE_NOTICE_MS);
  assert.match(text ?? "", /^Tasks may be out of date since .+ \(tasks plugin restarted\)\. Reloading/);
});
