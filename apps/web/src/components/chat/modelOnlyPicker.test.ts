import {
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type ServerProvider,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildModelOnlyPickerEntries,
  selectModelOnlyAccount,
  type ModelOnlyPickerSource,
} from "./modelOnlyPicker";

const now = Date.parse("2026-10-24T12:00:00Z");

function account(id: string, session: number, weekly: number, checkedAt = now): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    version: null,
    checkedAt: new Date(checkedAt).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: new Date(checkedAt).toISOString(),
      windows: [
        { id: "session", kind: "session", label: "Session", usedPercent: 100 - session },
        { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 - weekly },
      ],
    },
  };
}

function item(id: string, slug = "gpt-6.1-sol", name = slug): ModelOnlyPickerSource {
  return {
    slug,
    name,
    instanceId: ProviderInstanceId.make(id),
    driverKind: ProviderDriverKind.make("codex"),
    instanceDisplayName: `Account ${id}`,
  };
}

function usage(rows: ReadonlyArray<{ model: string; tokens: number }>): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: new Date(now).toISOString(),
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-10-01"),
    untilDay: UsageDay.make("2026-10-24"),
    sources: [],
    pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
    scanDurationMs: 0,
    buckets: rows.map((row) => ({
      model: row.model,
      day: UsageDay.make("2026-10-24"),
      provider: "codex",
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      records: 1,
      unpricedRecords: 1,
      sessions: 1,
      totals: {
        uncachedInputTokens: row.tokens,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
    })),
  };
}

describe("buildModelOnlyPickerEntries", () => {
  it("lists a model once however many accounts offer it", () => {
    const entries = buildModelOnlyPickerEntries(
      [item("a"), item("b"), item("c", "gpt-6.1-luna")],
      [account("a", 50, 50), account("b", 50, 50), account("c", 50, 50)],
      null,
      now,
    );
    expect(entries.map((entry) => entry.item.slug).toSorted()).toEqual([
      "gpt-6.1-luna",
      "gpt-6.1-sol",
    ]);
    expect(entries.find((entry) => entry.modelId === "gpt61sol")?.catalog.candidates).toHaveLength(
      2,
    );
  });

  it("matches the same model across namespaced and plain IDs", () => {
    const entries = buildModelOnlyPickerEntries(
      [item("a", "gpt-6.1-sol"), item("open", "openai/gpt-6.1-sol")],
      [account("a", 50, 50), account("open", 90, 90)],
      null,
      now,
    );
    expect(entries).toHaveLength(1);
  });

  it("orders models by recent token use, then name", () => {
    const entries = buildModelOnlyPickerEntries(
      [item("a", "alpha"), item("a", "beta"), item("a", "gamma")],
      [account("a", 50, 50)],
      usage([
        { model: "gamma", tokens: 900 },
        { model: "beta", tokens: 100 },
      ]),
      now,
    );
    expect(entries.map((entry) => entry.item.slug)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("shows the account with the most remaining session quota as the winner", () => {
    const [entry] = buildModelOnlyPickerEntries(
      [item("a"), item("b"), item("c")],
      [account("a", 99, 0), account("b", 40, 80), account("c", 60, 1)],
      null,
      now,
    );
    expect(entry?.winner?.instanceId).toBe("c");
    expect(entry?.item.instanceId).toBe("c");
  });

  it("keeps a model listed without a winner when quota is stale or missing", () => {
    const stale = account("a", 90, 90, now - 10 * 60_000);
    const [entry] = buildModelOnlyPickerEntries([item("a")], [stale], null, now);
    expect(entry?.winner).toBeNull();
    expect(entry?.item.instanceId).toBe("a");
  });

  it("does not choose an unavailable account", () => {
    const [entry] = buildModelOnlyPickerEntries(
      [{ ...item("a"), isUnavailable: true }, item("b")],
      [account("a", 100, 100), account("b", 10, 10)],
      null,
      now,
    );
    expect(entry?.winner?.instanceId).toBe("b");
  });
});

describe("selectModelOnlyAccount", () => {
  it("re-checks quota at selection time", () => {
    const [entry] = buildModelOnlyPickerEntries(
      [item("a"), item("b")],
      [account("a", 80, 80), account("b", 20, 20)],
      null,
      now,
    );
    expect(
      selectModelOnlyAccount(entry!, [account("a", 80, 80), account("b", 20, 20)], now),
    ).toMatchObject({
      instanceId: "a",
    });
    // The first account ran out while the picker stayed open.
    expect(
      selectModelOnlyAccount(entry!, [account("a", 0, 80), account("b", 20, 20)], now),
    ).toMatchObject({
      instanceId: "b",
    });
    // Quota reports older than five minutes no longer qualify.
    expect(
      selectModelOnlyAccount(
        entry!,
        [account("a", 80, 80), account("b", 20, 20)],
        now + 6 * 60_000,
      ),
    ).toBeNull();
  });
});
