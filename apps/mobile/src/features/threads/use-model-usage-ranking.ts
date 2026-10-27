import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { modelTokenTotals } from "@t3tools/shared/modelOnlyCatalog";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { cachedModelUsageRanking, withModelUsageRanking } from "../../lib/modelUsageRankingCache";
import {
  settleModelUsageRankingLock,
  startModelUsageRankingRefresh,
  type ModelUsageRankingLock,
} from "../../lib/modelUsageRankingLock";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export type ModelUsageRankingStatus = "loading" | "ranked" | "unavailable";

/**
 * Token totals that order the Models view. The last ranking is kept in preferences and used as
 * soon as the sheet opens; the list then keeps that order for the rest of the session instead
 * of re-sorting when the fresh usage arrives. The fresh totals are saved for the next open, and
 * a pull to refresh applies them.
 */
export function useModelUsageRanking(environmentId: EnvironmentId | null, enabled: boolean) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [rankingWindow] = useState(() => makeWindow(30));
  const usage = useEnvironmentQuery(
    enabled && environmentId
      ? serverEnvironment.usageSummary({ environmentId, input: rankingWindow })
      : null,
  );
  const fresh = useMemo(() => modelTokenTotals(usage.data), [usage.data]);
  const storedCache = AsyncResult.isSuccess(preferences)
    ? preferences.value.modelUsageRanking
    : undefined;
  const cached = useMemo(
    () => (environmentId ? cachedModelUsageRanking(storedCache, environmentId) : null),
    [environmentId, storedCache],
  );

  const [lock, setLock] = useState<ModelUsageRankingLock | null>(null);
  // Deriving state while rendering applies the order before the first paint, with no flash.
  const settled =
    enabled && environmentId
      ? settleModelUsageRankingLock(lock, { environmentId, cached, fresh, usage: usage.data })
      : lock;
  if (settled !== lock) setLock(settled);

  useEffect(() => {
    if (!environmentId || fresh === null || !AsyncResult.isSuccess(preferences)) return;
    const next = withModelUsageRanking(preferences.value.modelUsageRanking, environmentId, fresh);
    if (next !== preferences.value.modelUsageRanking) savePreferences({ modelUsageRanking: next });
  }, [environmentId, fresh, preferences, savePreferences]);

  const totals = settled?.totals ?? cached ?? fresh;
  const status: ModelUsageRankingStatus =
    totals !== null ? "ranked" : usage.isPending ? "loading" : "unavailable";

  return {
    totals,
    status,
    refresh: () => {
      setLock(startModelUsageRankingRefresh(settled, usage.data));
      usage.refresh();
    },
  };
}
