import { describe, expect, it } from "vite-plus/test";

import {
  cachedModelUsageRanking,
  sanitizeModelUsageRankingCache,
  withModelUsageRanking,
} from "./modelUsageRankingCache";

describe("sanitizeModelUsageRankingCache", () => {
  it("keeps well-formed rankings", () => {
    expect(sanitizeModelUsageRankingCache({ env: { sol: 900, astra: 0 } })).toEqual({
      env: { sol: 900, astra: 0 },
    });
  });

  it("drops malformed values read from disk", () => {
    expect(sanitizeModelUsageRankingCache(null)).toBeUndefined();
    expect(sanitizeModelUsageRankingCache([])).toBeUndefined();
    expect(
      sanitizeModelUsageRankingCache({
        bad: "x",
        list: [1],
        env: { sol: 5, negative: -1, nan: Number.NaN, text: "9", "": 3 },
      }),
    ).toEqual({ env: { sol: 5 } });
  });

  it("bounds the number of environments and models", () => {
    const environments = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`env-${index}`, { sol: index }]),
    );
    const sanitized = sanitizeModelUsageRankingCache(environments)!;
    expect(Object.keys(sanitized)).toHaveLength(16);
    expect(Object.keys(sanitized).at(-1)).toBe("env-39");

    const models = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`m${index}`, 1]));
    expect(Object.keys(sanitizeModelUsageRankingCache({ env: models })!.env!)).toHaveLength(256);
  });
});

describe("cachedModelUsageRanking", () => {
  it("returns null for an environment that never showed a ranking", () => {
    expect(cachedModelUsageRanking(undefined, "env")).toBeNull();
    expect(cachedModelUsageRanking({ other: { sol: 1 } }, "env")).toBeNull();
  });

  it("returns the totals, including an empty ranking", () => {
    expect(cachedModelUsageRanking({ env: { sol: 900 } }, "env")).toEqual(new Map([["sol", 900]]));
    expect(cachedModelUsageRanking({ env: {} }, "env")).toEqual(new Map());
  });
});

describe("withModelUsageRanking", () => {
  it("stores the totals for the environment", () => {
    expect(withModelUsageRanking(undefined, "env", new Map([["sol", 900]]))).toEqual({
      env: { sol: 900 },
    });
  });

  it("returns the same cache when nothing changed", () => {
    const cache = { env: { sol: 900, astra: 100 } };
    expect(
      withModelUsageRanking(
        cache,
        "env",
        new Map([
          ["astra", 100],
          ["sol", 900],
        ]),
      ),
    ).toBe(cache);
  });

  it("replaces totals that changed, including removed models", () => {
    const cache = { env: { sol: 900, astra: 100 }, other: { sol: 1 } };
    const next = withModelUsageRanking(cache, "env", new Map([["sol", 950]]));
    expect(next).toEqual({ env: { sol: 950 }, other: { sol: 1 } });
    expect(Object.keys(next)).toEqual(["other", "env"]);
  });

  it("trims the least recently updated environments", () => {
    let cache = withModelUsageRanking(undefined, "env-0", new Map([["sol", 0]]));
    for (let index = 1; index < 20; index += 1) {
      cache = withModelUsageRanking(cache, `env-${index}`, new Map([["sol", index]]));
    }
    expect(Object.keys(cache)).toHaveLength(16);
    expect(cache["env-0"]).toBeUndefined();
    expect(cache["env-19"]).toEqual({ sol: 19 });
  });

  it("keeps the most used models when over the cap", () => {
    const totals = new Map(
      Array.from({ length: 300 }, (_, index) => [`m${index}`, index] as const),
    );
    const stored = withModelUsageRanking(undefined, "env", totals).env!;
    expect(Object.keys(stored)).toHaveLength(256);
    expect(stored.m299).toBe(299);
    expect(stored.m0).toBeUndefined();
  });
});
