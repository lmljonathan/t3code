import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type ServerProvider,
  type UsageSummary,
} from "@t3tools/contracts";
import type { ModelOption } from "./modelOptions";
import {
  buildModelOnlyCatalog,
  selectModelProvider,
  resolveModelFallback,
  isQuotaUnder20,
  findModelFallback,
  modelTokenTotals,
  favoritesFirstBy,
} from "./modelOnlyCatalog";

const now = Date.parse("2026-10-24T12:00:00Z");
function account(id: string, session: number, weekly: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    version: null,
    checkedAt: new Date(now).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: new Date(now).toISOString(),
      windows: [
        { id: "session", kind: "session", label: "Session", usedPercent: 100 - session },
        { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 - weekly },
      ],
    },
  };
}
function model(id: string, name = "gpt-6.1-sol"): ModelOption {
  return {
    key: `${id}:${name}`,
    label: name,
    subtitle: "",
    providerKey: id,
    providerLabel: id,
    providerDriver: "codex",
    selection: { instanceId: ProviderInstanceId.make(id), model: name },
    isDefault: false,
    isLegacy: false,
    capabilities: null,
  };
}
function usage(
  rows: ReadonlyArray<{ model: string; input: number; output: number; reasoning?: number }>,
): UsageSummary {
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
        uncachedInputTokens: row.input,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: row.output,
        reasoningTokens: row.reasoning ?? 0,
      },
    })),
  };
}

describe("automatic model provider selection", () => {
  it("chooses highest session quota while excluding zero weekly quota", () => {
    expect(
      selectModelProvider(
        [model("a"), model("b"), model("c")],
        [account("a", 99, 0), account("b", 40, 80), account("c", 60, 1)],
        now,
      )?.selection.instanceId,
    ).toBe("c");
  });
  it("uses OpenCode only after the other providers are exhausted", () => {
    const openCode = {
      ...model("open", "openai/gpt-6.1-sol"),
      providerDriver: "opencode" as const,
    };
    const openAccount = {
      ...account("open", 100, 100),
      driver: ProviderDriverKind.make("opencode"),
    };
    expect(
      selectModelProvider([openCode, model("a")], [openAccount, account("a", 1, 1)], now)
        ?.providerKey,
    ).toBe("a");
    expect(
      selectModelProvider([openCode, model("a")], [openAccount, account("a", 0, 1)], now)
        ?.providerKey,
    ).toBe("open");
  });
  it("uses the monthly window as the long-term quota when a plan has no weekly limit", () => {
    const monthly = (id: string, session: number, month: number): ServerProvider => ({
      ...account(id, session, 100),
      usageLimits: {
        checkedAt: new Date(now).toISOString(),
        windows: [
          { id: "five_hour", kind: "session", label: "5-hour", usedPercent: 100 - session },
          { id: "month_total", kind: "monthly", label: "Monthly", usedPercent: 100 - month },
        ],
      },
    });
    const candidates = [model("a", "k3"), model("b", "k3")];
    expect(
      selectModelProvider(candidates, [monthly("a", 90, 50), monthly("b", 60, 50)], now)?.key,
    ).toBe("a:k3");
    // An exhausted month rules the account out, however much of the 5-hour window is left.
    expect(
      selectModelProvider(candidates, [monthly("a", 90, 0), monthly("b", 60, 50)], now)?.key,
    ).toBe("b:k3");
  });
  it("selects weekly-only models like Gemini 4 Argon using weekly quota", () => {
    const option = { ...model("mon", "gemini-4-argon-medium"), providerLabel: "Antigravity Mon" };
    const provider = {
      ...account("mon", 0, 0),
      usageLimits: {
        checkedAt: new Date(now).toISOString(),
        windows: [
          {
            id: "gemini-argon-wtu-weekly",
            kind: "weekly" as const,
            label: "Gemini 4 Argon · Weekly",
            usedPercent: 83,
            resetsAt: new Date(now + 6 * 24 * 3600_000).toISOString(),
          },
        ],
      },
    };
    const catalog = buildModelOnlyCatalog([option], [provider], null, now);
    expect(catalog[0]?.candidateQuotas[0]).toMatchObject({
      isWinner: true,
      remainingPercent: 17,
      shortLabel: "Mon",
    });
    expect(catalog[0]?.resetAndWeeklyLabel).toContain("Weekly 17%");
  });

  it("selects the 99% Gemini account when only model quota is reported", () => {
    const gemini = {
      ...model("mon", "gemini-3.8-flash-high"),
      providerDriver: "antigravity" as const,
    };
    const quota = {
      ...account("mon", 99, 100),
      driver: ProviderDriverKind.make("antigravity"),
      usageLimits: {
        checkedAt: new Date(now).toISOString(),
        windows: [{ id: "gemini-quota", kind: "other" as const, label: "Gemini", usedPercent: 1 }],
      },
    };
    expect(selectModelProvider([gemini], [quota], now)?.providerKey).toBe("mon");
    expect(
      selectModelProvider(
        [gemini],
        [
          {
            ...quota,
            usageLimits: {
              ...quota.usageLimits,
              windows: [{ ...quota.usageLimits.windows[0]!, usedPercent: 100 }],
            },
          },
        ],
        now,
      ),
    ).toBeNull();
  });
  it("uses weekly quota to break session ties, then a stable account key", () => {
    expect(
      selectModelProvider(
        [model("c"), model("b"), model("a")],
        [account("a", 50, 60), account("b", 50, 80), account("c", 50, 80)],
        now,
      )?.providerKey,
    ).toBe("b");
  });
  it("reevaluates the winning provider when quota changes before save", () => {
    const options = [model("a"), model("b")];
    expect(
      selectModelProvider(options, [account("a", 80, 30), account("b", 60, 30)], now)?.providerKey,
    ).toBe("a");
    expect(
      selectModelProvider(options, [account("a", 80, 0), account("b", 60, 30)], now)?.providerKey,
    ).toBe("b");
  });
  it.each([
    "missing",
    "no-weekly",
    "zero-session",
    "stale",
    "invalid-time",
    "disabled",
    "signed-out",
    "failed-probe",
    "hidden",
    "unsupported-options",
  ] as const)("does not auto-select %s quota/accounts", (kind) => {
    let provider = account("a", 80, 50);
    let option = model("a");
    if (kind === "missing") {
      const { usageLimits: _limits, ...rest } = provider;
      provider = rest;
    }
    if (kind === "no-weekly")
      provider = {
        ...provider,
        usageLimits: {
          ...provider.usageLimits!,
          windows: provider.usageLimits!.windows.filter((window) => window.kind !== "weekly"),
        },
      };
    if (kind === "zero-session") provider = account("a", 0, 50);
    if (kind === "stale")
      provider = {
        ...provider,
        usageLimits: {
          ...provider.usageLimits!,
          checkedAt: new Date(now - 6 * 60_000).toISOString(),
        },
      };
    if (kind === "invalid-time")
      provider = { ...provider, usageLimits: { ...provider.usageLimits!, checkedAt: "invalid" } };
    if (kind === "disabled") provider = { ...provider, enabled: false };
    if (kind === "signed-out") provider = { ...provider, auth: { status: "unauthenticated" } };
    if (kind === "failed-probe")
      provider = {
        ...provider,
        usageLimits: {
          ...provider.usageLimits!,
          unavailable: { reason: "probeFailed", message: "offline" },
        },
      };
    if (kind === "hidden") option = { ...option, isHidden: true };
    expect(
      selectModelProvider(
        [option],
        [provider],
        now,
        kind === "unsupported-options" ? [{ id: "effort", value: "max" }] : undefined,
      ),
    ).toBeNull();
  });
  it("preserves selected options when rerouting and skips incompatible candidates", () => {
    const capable = {
      ...model("b"),
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select" as const,
            options: [{ id: "max", label: "Max" }],
          },
        ],
      },
    };
    const selected = selectModelProvider(
      [model("a"), capable],
      [account("a", 90, 50), account("b", 60, 50)],
      now,
      [{ id: "effort", value: "max" }],
    );
    expect(selected?.providerKey).toBe("b");
    expect(selected?.selection.options).toEqual([{ id: "effort", value: "max" }]);
  });
});

describe("model-only catalog", () => {
  it("merges exact model IDs across accounts and sorts by aggregate token usage", () => {
    const catalog = buildModelOnlyCatalog(
      [model("a", "less"), model("a", "most"), model("b", "most")],
      [account("a", 40, 20), account("b", 80, 20)],
      usage([
        { model: "less", input: 100, output: 10 },
        { model: "most", input: 80, output: 10 },
        { model: "most", input: 70, output: 10 },
      ]),
      now,
    );
    expect(catalog.map((entry) => entry.modelId)).toEqual(["most", "less"]);
    expect(catalog[0]?.tokens).toBe(170);
    expect(catalog[0]?.candidates).toHaveLength(2);
    expect(catalog[0]?.option?.providerKey).toBe("b");
  });
  it("groups namespaced OpenCode models with the native model and keeps wire IDs", () => {
    const openCode = {
      ...model("open", "openai/gpt-6.1-sol"),
      providerDriver: "opencode" as const,
    };
    const openAccount = {
      ...account("open", 100, 100),
      driver: ProviderDriverKind.make("opencode"),
    };
    const catalog = buildModelOnlyCatalog(
      [openCode, model("a")],
      [openAccount, account("a", 0, 1)],
      usage([
        { model: "gpt-6.1-sol", input: 10, output: 1 },
        { model: "openai/gpt-6.1-sol", input: 5, output: 1 },
      ]),
      now,
    );
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.candidates).toHaveLength(2);
    expect(catalog[0]?.tokens).toBe(17);
    expect(catalog[0]?.option?.selection.model).toBe("openai/gpt-6.1-sol");
  });
  it("does not count reasoning tokens twice", () => {
    const catalog = buildModelOnlyCatalog(
      [model("a", "x")],
      [account("a", 10, 10)],
      usage([{ model: "x", input: 10, output: 20, reasoning: 15 }]),
      now,
    );
    expect(catalog[0]?.tokens).toBe(30);
  });
  it("keeps different IDs distinct even when their display names match", () => {
    const catalog = buildModelOnlyCatalog(
      [
        { ...model("a", "x"), label: "Same" },
        { ...model("b", "y"), label: "Same" },
      ],
      [account("a", 10, 10), account("b", 20, 10)],
      null,
      now,
    );
    expect(catalog.map((entry) => entry.modelId)).toEqual(["x", "y"]);
  });
  it("keeps exhausted models visible without choosing an account", () => {
    const catalog = buildModelOnlyCatalog([model("a")], [account("a", 90, 0)], null, now);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.option).toBeNull();
  });
  it("populates candidateQuotas for all accounts with winner first and descending quota", () => {
    const candidates = [
      { ...model("mon", "m1"), providerLabel: "Antigravity Mon" },
      { ...model("sat", "m1"), providerLabel: "Antigravity Sat" },
      { ...model("sun", "m1"), providerLabel: "Antigravity Sun" },
    ];
    const providers = [account("mon", 99, 100), account("sat", 60, 80), account("sun", 0, 50)];
    const catalog = buildModelOnlyCatalog(candidates, providers, null, now);
    expect(catalog[0]?.candidateQuotas).toHaveLength(3);
    expect(catalog[0]?.candidateQuotas[0]).toMatchObject({
      isWinner: true,
      remainingPercent: 99,
      shortLabel: "Mon",
    });
    expect(catalog[0]?.candidateQuotas[1]).toMatchObject({
      isWinner: false,
      remainingPercent: 60,
      shortLabel: "Sat",
    });
    expect(catalog[0]?.candidateQuotas[2]).toMatchObject({
      isWinner: false,
      remainingPercent: 0,
      isExhausted: true,
      shortLabel: "Sun",
    });
  });
  it("computes earliest reset and greatest weekly quota across candidate providers", () => {
    const candidates = [
      { ...model("mon", "m1"), providerLabel: "Antigravity Mon" },
      { ...model("sat", "m1"), providerLabel: "Antigravity Sat" },
    ];
    const providers = [
      {
        ...account("mon", 50, 40),
        usageLimits: {
          checkedAt: new Date(now).toISOString(),
          windows: [
            {
              id: "session",
              kind: "session" as const,
              label: "Session",
              usedPercent: 50,
              resetsAt: new Date(now + 2 * 3600_000).toISOString(),
            },
            {
              id: "weekly",
              kind: "weekly" as const,
              label: "Weekly",
              usedPercent: 40,
            },
          ],
        },
      },
      {
        ...account("sat", 70, 10),
        usageLimits: {
          checkedAt: new Date(now).toISOString(),
          windows: [
            {
              id: "session",
              kind: "session" as const,
              label: "Session",
              usedPercent: 70,
              resetsAt: new Date(now + 45 * 60_000).toISOString(),
            },
            {
              id: "weekly",
              kind: "weekly" as const,
              label: "Weekly",
              usedPercent: 10,
            },
          ],
        },
      },
    ];
    const catalog = buildModelOnlyCatalog(candidates, providers, null, now);
    expect(catalog[0]?.earliestReset).toBe("Resets in 45m");
    expect(catalog[0]?.maxWeeklyPercent).toBe(90);
    expect(catalog[0]?.resetAndWeeklyLabel).toBe("Resets in 45m · Weekly 90%");
  });
  it("uses alphabetical order when usage is unavailable or incompatible", () => {
    const options = [model("a", "z"), model("a", "a")];
    const summary = { ...usage([{ model: "z", input: 100, output: 20 }]), contractVersion: 999 };
    expect(
      buildModelOnlyCatalog(options, [account("a", 50, 50)], summary, now).map(
        (entry) => entry.modelId,
      ),
    ).toEqual(["a", "z"]);
  });
});

describe("model token totals", () => {
  it("sums reported tokens per comparable model without counting reasoning twice", () => {
    expect(
      modelTokenTotals(
        usage([
          { model: "gpt-6.1-sol", input: 10, output: 20, reasoning: 15 },
          { model: "openai/gpt-6.1-sol", input: 5, output: 1 },
        ]),
      ),
    ).toEqual(new Map([["gpt61sol", 36]]));
  });
  it("is null when usage is missing or from an incompatible contract", () => {
    expect(modelTokenTotals(null)).toBeNull();
    expect(
      modelTokenTotals({ ...usage([{ model: "z", input: 1, output: 1 }]), contractVersion: 999 }),
    ).toBeNull();
  });
  it("orders the catalog from precomputed totals, as a cached ranking does", () => {
    const options = [model("a", "alpha"), model("a", "beta"), model("a", "gamma")];
    const catalog = buildModelOnlyCatalog(
      options,
      [account("a", 50, 50)],
      new Map([
        ["gamma", 900],
        ["beta", 100],
      ]),
      now,
    );
    expect(catalog.map((entry) => entry.modelId)).toEqual(["gamma", "beta", "alpha"]);
    expect(catalog[0]?.tokens).toBe(900);
  });
  it("matches ordering from the usage summary the totals came from", () => {
    const summary = usage([
      { model: "gamma", input: 900, output: 0 },
      { model: "beta", input: 100, output: 0 },
    ]);
    const options = [model("a", "alpha"), model("a", "beta"), model("a", "gamma")];
    const providers = [account("a", 50, 50)];
    expect(
      buildModelOnlyCatalog(options, providers, modelTokenTotals(summary), now).map(
        (entry) => entry.modelId,
      ),
    ).toEqual(
      buildModelOnlyCatalog(options, providers, summary, now).map((entry) => entry.modelId),
    );
  });
});

describe("resolveModelFallback", () => {
  it("returns null when current model quota is 20% or more", () => {
    const currentOpt = model("a", "gpt-6.1-sol");
    const fallbackOpt = model("b", "gpt-6.1-sol");
    const providers = [account("a", 20, 50), account("b", 80, 50)];

    const result = resolveModelFallback(
      currentOpt.selection,
      currentOpt,
      [currentOpt, fallbackOpt],
      providers,
      now,
    );
    expect(result).toBeNull();
  });

  it("returns Fallback X% with greatest available fallback quota when under 20%", () => {
    const currentOpt = model("a", "gpt-6.1-sol");
    const fallbackB = model("b", "gpt-6.1-sol");
    const fallbackC = model("c", "gpt-6.1-sol");
    // Account A: 13% remaining (< 20%)
    // Account B: 86% remaining
    // Account C: 40% remaining
    const providers = [account("a", 13, 86), account("b", 86, 90), account("c", 40, 50)];

    const result = resolveModelFallback(
      currentOpt.selection,
      currentOpt,
      [currentOpt, fallbackB, fallbackC],
      providers,
      now,
    );
    expect(result).not.toBeNull();
    expect(result?.fallbackPercent).toBe(86);
    expect(result?.label).toBe("Fallback 86%");
    expect(result?.fallbackOption?.selection.instanceId).toBe("b");
  });

  it("returns No fallback when under 20% but no other provider exists", () => {
    const currentOpt = model("a", "gpt-6.1-sol");
    const providers = [account("a", 13, 86)];

    const result = resolveModelFallback(
      currentOpt.selection,
      currentOpt,
      [currentOpt],
      providers,
      now,
    );
    expect(result).not.toBeNull();
    expect(result?.fallbackOption).toBeNull();
    expect(result?.fallbackPercent).toBeNull();
    expect(result?.label).toBe("No fallback");
  });

  it("returns No fallback when under 20% but other providers are exhausted (0%)", () => {
    const currentOpt = model("a", "gpt-6.1-sol");
    const exhaustedOpt = model("b", "gpt-6.1-sol");
    const providers = [account("a", 13, 86), account("b", 0, 0)];

    const result = resolveModelFallback(
      currentOpt.selection,
      currentOpt,
      [currentOpt, exhaustedOpt],
      providers,
      now,
    );
    expect(result).not.toBeNull();
    expect(result?.fallbackOption).toBeNull();
    expect(result?.label).toBe("No fallback");
  });

  it("detects under 20% when weekly quota is under 20% even if session is higher", () => {
    const currentOpt = model("a", "gpt-6.1-sol");
    const fallbackOpt = model("b", "gpt-6.1-sol");
    const providers = [account("a", 50, 15), account("b", 80, 80)];

    const result = resolveModelFallback(
      currentOpt.selection,
      currentOpt,
      [currentOpt, fallbackOpt],
      providers,
      now,
    );
    expect(result).not.toBeNull();
    expect(result?.label).toBe("Fallback 80%");
  });
});

describe("favoritesFirstBy", () => {
  it("moves favorites ahead and keeps each group's order", () => {
    const entries = ["a", "b", "c", "d"];
    expect(favoritesFirstBy(entries, (entry) => entry === "c" || entry === "b")).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("returns the original order when nothing is a favorite", () => {
    expect(favoritesFirstBy(["x", "y"], () => false)).toEqual(["x", "y"]);
  });
});
