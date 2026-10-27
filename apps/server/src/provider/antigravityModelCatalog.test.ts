import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import type * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";

import { applyAntigravityModelCatalog } from "./antigravityModelCatalog.ts";

const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "gemini-test",
  name: "Gemini Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

const entry = (
  overrides: Partial<ModelCatalog.ProviderCatalogModel> & { readonly slug: string },
): ModelCatalog.ProviderCatalogModel => ({
  name: overrides.slug,
  status: "current",
  capabilities: null,
  adapter: undefined,
  profileAdapter: undefined,
  ...overrides,
});

const catalog: ModelCatalog.ProviderCatalog = {
  defaultChatModel: "gemini-3.8-flash-high",
  models: [
    entry({ slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }),
    entry({ slug: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" }),
    entry({
      slug: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      aliases: ["sonnet", "claude-sonnet"],
    }),
    entry({
      slug: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      aliases: ["opus", "claude-opus"],
    }),
    entry({ slug: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", status: "legacy" }),
  ],
};

const draft = (
  models: ReadonlyArray<ServerProviderModel> = [],
  authStatus: "authenticated" | "unauthenticated" = "authenticated",
) => ({
  enabled: true,
  installed: true,
  version: "1.3.0",
  status: "ready" as const,
  auth: { status: authStatus },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
});

describe("applyAntigravityModelCatalog", () => {
  it("returns draft unchanged when catalog is undefined", () => {
    const original = draft([model({ slug: "gemini-discovered" })]);
    assert.deepStrictEqual(applyAntigravityModelCatalog(original, undefined), original);
  });

  it("does not populate models when unauthenticated", () => {
    const unauthenticated = draft([], "unauthenticated");
    assert.deepStrictEqual(applyAntigravityModelCatalog(unauthenticated, catalog).models, []);
  });

  it("merges current Sonnet, Opus and other catalog models missing from session discovery", () => {
    const sessionDraft = draft([
      model({ slug: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" }),
      model({ slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }),
    ]);

    const result = applyAntigravityModelCatalog(sessionDraft, catalog);
    const slugs = result.models.map((m) => m.slug);

    assert.include(slugs, "gemini-4-argon-medium");
    assert.include(slugs, "gemini-3.8-flash-high");
    assert.include(slugs, "gemini-3.8-flash-medium");
    assert.include(slugs, "claude-sonnet-4-6");
    assert.include(slugs, "claude-opus-4-6");
    // Undiscovered legacy catalog models are not added
    assert.notInclude(slugs, "gemini-3.6-flash-high");

    const sonnet = result.models.find((m) => m.slug === "claude-sonnet-4-6");
    assert.isDefined(sonnet);
    assert.strictEqual(sonnet?.name, "Claude Sonnet 4.6");
    assert.deepStrictEqual(sonnet?.aliases, ["sonnet", "claude-sonnet"]);

    const defaultModel = result.models.find((m) => m.slug === "gemini-3.8-flash-high");
    assert.isTrue(defaultModel?.isDefault);
  });
});
