import { describe, expect, it } from "vite-plus/test";

import { isKimiCodeCommand, kimiUsageResponseToLimits, parseKimiCodeConfig } from "./kimiUsage.ts";

describe("isKimiCodeCommand", () => {
  it("matches the CLI executable wherever it lives", () => {
    expect(isKimiCodeCommand("/Users/me/.kimi-code/bin/kimi")).toBe(true);
    expect(isKimiCodeCommand("kimi")).toBe(true);
    expect(isKimiCodeCommand("C:\\Kimi\\kimi.exe")).toBe(true);
  });

  it("ignores other commands", () => {
    expect(isKimiCodeCommand("/usr/bin/kimi-helper")).toBe(false);
    expect(isKimiCodeCommand("/usr/bin/codex")).toBe(false);
    expect(isKimiCodeCommand("")).toBe(false);
  });
});

describe("parseKimiCodeConfig", () => {
  const toml = `
default_model = "kimi-code/k3"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://api.kimi.ai/coding/v1/"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-abc123"
oauth_host = "https://auth.kimi.ai"

[services.moonshot_search.oauth]
key = "oauth/other"
`;

  it("reads the endpoint and credential file name of the managed provider", () => {
    expect(parseKimiCodeConfig(toml)).toEqual({
      baseUrl: "https://api.kimi.ai/coding/v1",
      credentialName: "kimi-code-env-abc123",
    });
  });

  it("falls back to the default endpoint and reports a missing login", () => {
    expect(parseKimiCodeConfig('default_model = "x"\n')).toEqual({
      baseUrl: "https://api.kimi.ai/coding/v1",
      credentialName: undefined,
    });
  });
});

describe("kimiUsageResponseToLimits", () => {
  const checkedAt = "2026-10-26T20:00:00.000Z";

  it("maps the 5-hour and monthly limits to usage windows", () => {
    const limits = kimiUsageResponseToLimits(
      {
        usages: {
          limit_5h: { used_ratio: 0.25, reset_time: "2026-10-26T22:58:54Z" },
          limit_month_total: { used_ratio: 0.3729, reset_time: "2026-11-16T00:00:00Z" },
          limit_month_code: { used_ratio: 0 },
        },
      },
      checkedAt,
    );
    expect(limits.checkedAt).toBe(checkedAt);
    expect(limits.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "5-hour",
        usedPercent: 25,
        resetsAt: "2026-10-26T22:58:54.000Z",
        windowDurationMins: 300,
      },
      {
        id: "month_code",
        kind: "monthly",
        label: "Monthly (code)",
        usedPercent: 0,
      },
      {
        id: "month_total",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 37.29,
        resetsAt: "2026-11-16T00:00:00.000Z",
      },
    ]);
  });

  it("clamps ratios and ignores windows it does not know", () => {
    const limits = kimiUsageResponseToLimits(
      { usages: { limit_5h: { used_ratio: 1.4 }, limit_other: { used_ratio: 0.5 } } },
      checkedAt,
    );
    expect(limits.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["five_hour", 100],
    ]);
  });

  it("reports a failed probe when nothing usable came back", () => {
    expect(kimiUsageResponseToLimits({}, checkedAt)).toMatchObject({
      windows: [],
      unavailable: { reason: "probeFailed" },
    });
  });
});
