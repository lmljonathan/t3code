import type { ModelTokenTotals } from "@t3tools/shared/modelOnlyCatalog";

/**
 * The totals the Models view is ordered by for one sheet session. They are fixed once chosen, so
 * fresh usage arriving after the list is on screen does not move rows under the user.
 */
export interface ModelUsageRankingLock {
  readonly environmentId: string;
  readonly totals: ModelTokenTotals;
  /** Set by a pull to refresh: the usage it started from. Different usage replaces the totals. */
  readonly refreshingFrom: { readonly usage: unknown } | null;
}

/** Locks the cached ranking when there is one, else the first fresh usage. */
export function settleModelUsageRankingLock(
  lock: ModelUsageRankingLock | null,
  input: {
    readonly environmentId: string;
    readonly cached: ModelTokenTotals | null;
    readonly fresh: ModelTokenTotals | null;
    /** Identifies the usage `fresh` came from. */
    readonly usage: unknown;
  },
): ModelUsageRankingLock | null {
  const current = lock?.environmentId === input.environmentId ? lock : null;
  if (current === null) {
    const seed = input.cached ?? input.fresh;
    return seed === null
      ? null
      : { environmentId: input.environmentId, totals: seed, refreshingFrom: null };
  }
  if (current.refreshingFrom !== null && input.fresh !== null) {
    return input.usage === current.refreshingFrom.usage
      ? current
      : { environmentId: input.environmentId, totals: input.fresh, refreshingFrom: null };
  }
  return current;
}

/** Lets the next different usage replace the locked totals. Nothing to unlock before a lock exists. */
export function startModelUsageRankingRefresh(
  lock: ModelUsageRankingLock | null,
  usage: unknown,
): ModelUsageRankingLock | null {
  return lock === null ? null : { ...lock, refreshingFrom: { usage } };
}
