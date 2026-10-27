import type { ModelTokenTotals } from "@t3tools/shared/modelOnlyCatalog";

/** Reported tokens per comparable model name, by environment: the last ranking the Models view showed. */
export type ModelUsageRankingCache = Readonly<Record<string, Readonly<Record<string, number>>>>;

const MAX_ENVIRONMENTS = 16;
const MAX_MODELS_PER_ENVIRONMENT = 256;

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Drops malformed entries and bounds the size, since the value comes from disk. */
export function sanitizeModelUsageRankingCache(value: unknown): ModelUsageRankingCache | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const cache: Record<string, Record<string, number>> = {};
  for (const [environmentId, totals] of Object.entries(value).slice(-MAX_ENVIRONMENTS)) {
    if (typeof totals !== "object" || totals === null || Array.isArray(totals)) continue;
    const models: Record<string, number> = {};
    for (const [model, tokens] of Object.entries(totals).slice(0, MAX_MODELS_PER_ENVIRONMENT)) {
      if (model.length > 0 && isTokenCount(tokens)) models[model] = tokens;
    }
    cache[environmentId] = models;
  }
  return cache;
}

/** `null` when this environment has never shown a ranking. */
export function cachedModelUsageRanking(
  cache: ModelUsageRankingCache | undefined,
  environmentId: string,
): ModelTokenTotals | null {
  const totals = cache?.[environmentId];
  return totals ? new Map(Object.entries(totals)) : null;
}

/**
 * The cache with this environment's ranking replaced. Returns the same object when nothing
 * changed, so callers can skip the write.
 */
export function withModelUsageRanking(
  cache: ModelUsageRankingCache | undefined,
  environmentId: string,
  totals: ModelTokenTotals,
): ModelUsageRankingCache {
  // Bounded to keep the preferences blob small; models past the cap sort as unused.
  const next = Object.fromEntries(
    [...totals]
      .sort(([a, left], [b, right]) => right - left || a.localeCompare(b))
      .slice(0, MAX_MODELS_PER_ENVIRONMENT),
  );
  const current = cache?.[environmentId];
  if (
    cache &&
    current &&
    Object.keys(current).length === Object.keys(next).length &&
    Object.entries(next).every(([model, tokens]) => current[model] === tokens)
  ) {
    return cache;
  }
  // Re-insert last so the least recently updated environments are the ones trimmed.
  const { [environmentId]: _replaced, ...others } = cache ?? {};
  return Object.fromEntries(
    Object.entries({ ...others, [environmentId]: next }).slice(-MAX_ENVIRONMENTS),
  );
}
