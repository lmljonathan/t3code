import { describe, expect, it } from "vite-plus/test";

import {
  settleModelUsageRankingLock,
  startModelUsageRankingRefresh,
} from "./modelUsageRankingLock";

const cached = new Map([["sol", 900]]);
const fresh = new Map([["astra", 500]]);
const usage = { id: "usage-1" };

function settle(
  lock: ReturnType<typeof settleModelUsageRankingLock>,
  input: Partial<Parameters<typeof settleModelUsageRankingLock>[1]> = {},
) {
  return settleModelUsageRankingLock(lock, {
    environmentId: "env",
    cached: null,
    fresh: null,
    usage: null,
    ...input,
  });
}

describe("settleModelUsageRankingLock", () => {
  it("stays unlocked until a ranking is available", () => {
    expect(settle(null)).toBeNull();
  });

  it("locks the cached ranking before usage loads", () => {
    expect(settle(null, { cached })?.totals).toBe(cached);
  });

  it("prefers the cache over usage that arrives at the same time", () => {
    expect(settle(null, { cached, fresh, usage })?.totals).toBe(cached);
  });

  it("locks the first fresh usage when nothing was cached", () => {
    expect(settle(null, { fresh, usage })?.totals).toBe(fresh);
  });

  it("keeps the locked order when fresh usage arrives", () => {
    const lock = settle(null, { cached });
    expect(settle(lock, { cached, fresh, usage })).toBe(lock);
  });

  it("returns the same lock while nothing changes", () => {
    const lock = settle(null, { cached });
    expect(settle(lock, { cached })).toBe(lock);
  });

  it("starts over for a different environment", () => {
    const lock = settle(null, { cached });
    expect(settle(lock, { environmentId: "other", fresh, usage })?.totals).toBe(fresh);
    expect(settle(lock, { environmentId: "other" })).toBeNull();
  });
});

describe("pull to refresh", () => {
  it("keeps the locked order until different usage arrives", () => {
    const refreshing = startModelUsageRankingRefresh(settle(null, { cached }), usage);
    expect(settle(refreshing, { fresh: null, usage })).toBe(refreshing);
    expect(settle(refreshing, { fresh, usage })).toBe(refreshing);
  });

  it("applies the new usage once it replaces the one the refresh started from", () => {
    const refreshing = startModelUsageRankingRefresh(settle(null, { cached }), usage);
    const settled = settle(refreshing, { fresh, usage: { id: "usage-2" } });
    expect(settled?.totals).toBe(fresh);
    expect(settled?.refreshingFrom).toBeNull();
  });

  it("ignores new usage that has no usable totals", () => {
    const refreshing = startModelUsageRankingRefresh(settle(null, { cached }), usage);
    expect(settle(refreshing, { fresh: null, usage: { id: "usage-2" } })).toBe(refreshing);
  });

  it("does nothing before a lock exists", () => {
    expect(startModelUsageRankingRefresh(null, usage)).toBeNull();
  });
});
