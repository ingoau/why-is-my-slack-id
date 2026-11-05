import assert from "node:assert/strict";
import test from "node:test";
import { DAY_MS, DailyRateLimiter } from "./rate-limit.ts";

test("failed work releases the daily slot", () => {
  const limiter = new DailyRateLimiter();
  const first = limiter.tryReserve("U1", 1000);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  first.release();
  assert.equal(limiter.tryReserve("U1", 1001).ok, true);
});

test("successful work remains limited for a day", () => {
  const limiter = new DailyRateLimiter();
  const first = limiter.tryReserve("U1", 1000);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  first.commit();
  const retry = limiter.tryReserve("U1", 1001);
  assert.deepEqual(retry, { ok: false, retryAt: 1000 + DAY_MS });
});

test("a concurrent request is rejected while work is in flight", () => {
  const limiter = new DailyRateLimiter();
  const first = limiter.tryReserve("U1", 1000);
  assert.equal(first.ok, true);
  assert.equal(limiter.tryReserve("U1", 1001).ok, false);
});
