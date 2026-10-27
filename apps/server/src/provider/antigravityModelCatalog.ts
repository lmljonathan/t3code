import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";

export function applyAntigravityModelCatalog(
  draft: ServerProviderDraft,
  catalog: ModelCatalog.ProviderCatalog | undefined,
): ServerProviderDraft {
  if (!catalog || draft.auth.status !== "authenticated") return draft;
  const discoveredSlugs = new Set(draft.models.map((model) => model.slug));
  const additionalCatalogModels = catalog.models
    .filter((entry) => entry.status === "current" && !discoveredSlugs.has(entry.slug))
    .map((entry) => ModelCatalog.catalogServerModel(catalog, entry));

  const hasSessionDefault = draft.models.some((m) => m.isDefault);
  const catalogForDraft = hasSessionDefault ? { ...catalog, defaultChatModel: undefined } : catalog;

  let models = [...draft.models, ...additionalCatalogModels];
  if (catalog.defaultChatModel && !hasSessionDefault && !models.some((m) => m.isDefault)) {
    models = models.map((m) =>
      m.slug === catalog.defaultChatModel ? { ...m, isDefault: true } : m,
    );
  }

  const combinedDraft: ServerProviderDraft = {
    ...draft,
    models,
  };
  return ModelCatalog.applyModelCatalog(combinedDraft, catalogForDraft);
}
