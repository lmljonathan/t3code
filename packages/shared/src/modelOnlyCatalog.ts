import {
  USAGE_CONTRACT_VERSION,
  type ModelCapabilities,
  type ModelSelection,
  type ServerProvider,
  type UsageSummary,
} from "@t3tools/contracts";

import { comparableModelName } from "./model.ts";
import { formatDuration, modelUsageWindows, remainingPercent } from "./usageLimits.ts";
import { isCompatibleUsageContractVersion } from "./usageMerge.ts";

/**
 * The fields of a client model option this catalog reads. Web and mobile each have their own
 * option type; both satisfy this structurally, and the helpers hand back the caller's own type.
 */
export interface ModelCandidate {
  readonly key: string;
  readonly label: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly isUnavailable?: boolean | undefined;
  readonly isHidden?: boolean | undefined;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
}

const QUOTA_MAX_AGE_MS = 5 * 60_000;

function quotaScore<T extends ModelCandidate>(
  option: T,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
) {
  const provider = providers.find(
    (provider) => provider.instanceId === option.selection.instanceId,
  );
  if (
    option.isHidden ||
    option.isUnavailable ||
    !provider?.enabled ||
    !provider.installed ||
    provider.status === "error" ||
    provider.status === "disabled" ||
    provider.availability === "unavailable" ||
    provider.auth.status === "unauthenticated"
  )
    return null;
  const limits = provider.usageLimits;
  if (!limits || limits.unavailable) return null;
  const checkedAt = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt > QUOTA_MAX_AGE_MS || checkedAt > now + 60_000)
    return null;
  const windows = modelUsageWindows(limits, {
    driver: provider.driver,
    model: option.selection.model,
  });
  const reported =
    provider.driver === "antigravity"
      ? windows.filter((window) => window.kind === "other" && window.id.endsWith("-quota"))
      : [];
  const sessions = windows.filter((window) => window.kind === "session");
  const current = sessions.length ? sessions : reported;
  // The long-term window: weekly, or the monthly one for plans that have no weekly limit.
  const weeklyWindows = windows.filter((window) => window.kind === "weekly");
  const weeks = weeklyWindows.length
    ? weeklyWindows
    : windows.filter((window) => window.kind === "monthly");
  if (!weeks.length && !reported.length) return null;
  const effectiveCurrent = current.length ? current : weeks;
  if (!effectiveCurrent.length) return null;
  const session = Math.min(...effectiveCurrent.map((window) => 100 - window.usedPercent));
  const longTerm = weeks.length
    ? Math.min(...weeks.map((window) => 100 - window.usedPercent))
    : session;
  if (!Number.isFinite(session) || !Number.isFinite(longTerm) || session <= 0 || longTerm <= 0)
    return null;
  return { session, weekly: longTerm };
}

function candidateRemainingPercent<T extends ModelCandidate>(
  option: T,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): number | null {
  const provider = providers.find(
    (provider) => provider.instanceId === option.selection.instanceId,
  );
  if (!provider) return null;
  const limits = provider.usageLimits;
  if (!limits || limits.unavailable) return null;
  const checkedAt = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt > QUOTA_MAX_AGE_MS || checkedAt > now + 60_000)
    return null;
  const windows = modelUsageWindows(limits, {
    driver: provider.driver,
    model: option.selection.model,
  });
  const reported =
    provider.driver === "antigravity"
      ? windows.filter((window) => window.kind === "other" && window.id.endsWith("-quota"))
      : [];
  const sessions = windows.filter((window) => window.kind === "session");
  const current = sessions.length ? sessions : reported;
  if (current.length) {
    const minSession = Math.min(...current.map((w) => 100 - w.usedPercent));
    if (Number.isFinite(minSession)) {
      return Math.round(Math.max(0, Math.min(100, minSession)));
    }
  }
  if (windows.length) {
    const minAny = Math.min(...windows.map((w) => 100 - w.usedPercent));
    if (Number.isFinite(minAny)) {
      return Math.round(Math.max(0, Math.min(100, minAny)));
    }
  }
  return null;
}

function formatCandidateShortLabel(providerLabel: string): string {
  if (providerLabel.startsWith("Antigravity ")) {
    return providerLabel.slice("Antigravity ".length);
  }
  return providerLabel;
}

export interface ModelCandidateQuota<T extends ModelCandidate = ModelCandidate> {
  readonly option: T;
  readonly remainingPercent: number | null;
  readonly isWinner: boolean;
  readonly isExhausted: boolean;
  readonly isUnavailable: boolean;
  readonly shortLabel: string;
}

function evaluateCandidateQuota<T extends ModelCandidate>(
  option: T,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
  isWinner: boolean,
): ModelCandidateQuota<T> {
  const provider = providers.find((p) => p.instanceId === option.selection.instanceId);
  const isUnavailable =
    option.isUnavailable === true ||
    option.isHidden === true ||
    !provider?.enabled ||
    !provider.installed ||
    provider.status === "error" ||
    provider.status === "disabled" ||
    provider.availability === "unavailable" ||
    provider.auth.status === "unauthenticated";

  const remainingPercent = candidateRemainingPercent(option, providers, now);
  const isExhausted = remainingPercent !== null && remainingPercent <= 0;
  const shortLabel = formatCandidateShortLabel(option.providerLabel);

  return {
    option,
    remainingPercent,
    isWinner,
    isExhausted,
    isUnavailable,
    shortLabel,
  };
}

function modelResetAndWeekly<T extends ModelCandidate>(
  candidates: ReadonlyArray<T>,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): {
  readonly earliestReset: string | null;
  readonly maxWeeklyPercent: number | null;
  readonly label: string | null;
} {
  let earliestAt: number | null = null;
  let earliestWeeklyAt: number | null = null;
  let maxWeeklyPercent: number | null = null;

  for (const option of candidates) {
    const provider = providers.find((p) => p.instanceId === option.selection.instanceId);
    if (
      !provider ||
      provider.driver === "opencode" ||
      !provider.enabled ||
      !provider.installed ||
      provider.status === "error" ||
      provider.status === "disabled" ||
      provider.availability === "unavailable" ||
      provider.auth.status === "unauthenticated"
    ) {
      continue;
    }
    const limits = provider.usageLimits;
    if (!limits || limits.unavailable) continue;
    const checkedAt = Date.parse(limits.checkedAt);
    if (
      !Number.isFinite(checkedAt) ||
      now - checkedAt > QUOTA_MAX_AGE_MS ||
      checkedAt > now + 60_000
    ) {
      continue;
    }
    const windows = modelUsageWindows(limits, {
      driver: provider.driver,
      model: option.selection.model,
    });
    for (const window of windows) {
      if (window.kind === "session" || window.kind === "other") {
        if (window.resetsAt !== undefined) {
          const at = Date.parse(window.resetsAt);
          if (Number.isFinite(at) && at > now) {
            if (earliestAt === null || at < earliestAt) {
              earliestAt = at;
            }
          }
        }
      }
      if (window.kind === "weekly") {
        const remaining = Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
        if (maxWeeklyPercent === null || remaining > maxWeeklyPercent) {
          maxWeeklyPercent = remaining;
        }
        if (window.resetsAt !== undefined) {
          const at = Date.parse(window.resetsAt);
          if (Number.isFinite(at) && at > now) {
            if (earliestWeeklyAt === null || at < earliestWeeklyAt) {
              earliestWeeklyAt = at;
            }
          }
        }
      }
    }
  }

  let earliestReset: string | null = null;
  const resetTarget = earliestAt ?? earliestWeeklyAt;
  if (resetTarget !== null) {
    const diff = resetTarget - now;
    if (diff <= 0) {
      earliestReset = "Resets now";
    } else if (diff < 60_000) {
      earliestReset = "Resets momentarily";
    } else {
      earliestReset = `Resets in ${formatDuration(diff)}`;
    }
  }

  const parts: string[] = [];
  if (earliestReset && earliestAt !== null) {
    parts.push(earliestReset);
  }
  if (maxWeeklyPercent !== null) {
    parts.push(`Weekly ${maxWeeklyPercent}%`);
  }
  if (earliestReset && earliestAt === null) {
    parts.push(earliestReset);
  }

  const label = parts.length > 0 ? parts.join(" · ") : null;

  return { earliestReset, maxWeeklyPercent, label };
}

export function selectModelProvider<T extends ModelCandidate>(
  options: ReadonlyArray<T>,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
  requestedOptions?: ModelSelection["options"],
): T | null {
  const candidates = options
    .flatMap((option) => {
      const score = quotaScore(option, providers, now);
      if (!score) return [];
      if (
        requestedOptions?.some((selection) => {
          const descriptor = option.capabilities?.optionDescriptors?.find(
            (descriptor) => descriptor.id === selection.id,
          );
          return (
            !descriptor ||
            (descriptor.type === "boolean"
              ? typeof selection.value !== "boolean"
              : !descriptor.options.some((choice) => choice.id === selection.value))
          );
        })
      )
        return [];
      return [{ option, ...score }];
    })
    .sort(
      (left, right) =>
        Number(left.option.providerDriver === "opencode") -
          Number(right.option.providerDriver === "opencode") ||
        right.session - left.session ||
        right.weekly - left.weekly ||
        left.option.key.localeCompare(right.option.key),
    );
  const winner = candidates[0]?.option;
  if (!winner) return null;
  return requestedOptions === undefined
    ? winner
    : { ...winner, selection: { ...winner.selection, options: requestedOptions } };
}

export interface ModelOnlyEntry<T extends ModelCandidate = ModelCandidate> {
  readonly modelId: string;
  readonly candidates: ReadonlyArray<T>;
  readonly candidateQuotas: ReadonlyArray<ModelCandidateQuota<T>>;
  readonly option: T | null;
  readonly tokens: number;
  readonly earliestReset: string | null;
  readonly maxWeeklyPercent: number | null;
  readonly resetAndWeeklyLabel: string | null;
}

/** Reported tokens per model over the usage window, keyed by `comparableModelName`. */
export type ModelTokenTotals = ReadonlyMap<string, number>;

/** `null` when usage is missing or from an incompatible contract version. */
export function modelTokenTotals(usage: UsageSummary | null): ModelTokenTotals | null {
  if (!usage || !isCompatibleUsageContractVersion(usage.contractVersion, USAGE_CONTRACT_VERSION)) {
    return null;
  }
  const totals = new Map<string, number>();
  for (const bucket of usage.buckets) {
    // Reasoning is already part of output; counting it again inflates usage.
    const total =
      bucket.totals.uncachedInputTokens +
      bucket.totals.cachedInputTokens +
      bucket.totals.cacheCreationTokens +
      bucket.totals.outputTokens;
    const key = comparableModelName(bucket.model);
    totals.set(key, (totals.get(key) ?? 0) + total);
  }
  return totals;
}

/**
 * Pass `ModelTokenTotals` (for example a cached ranking) to order the list without a usage
 * summary in hand.
 */
export function buildModelOnlyCatalog<T extends ModelCandidate>(
  options: ReadonlyArray<T>,
  providers: ReadonlyArray<ServerProvider>,
  usage: UsageSummary | ModelTokenTotals | null,
  now: number,
): ReadonlyArray<ModelOnlyEntry<T>> {
  const tokens: ModelTokenTotals =
    (usage instanceof Map ? usage : modelTokenTotals(usage as UsageSummary | null)) ?? new Map();
  const models = new Map<string, T[]>();
  for (const option of options) {
    const key = comparableModelName(option.selection.model);
    const candidates = models.get(key) ?? [];
    candidates.push(option);
    models.set(key, candidates);
  }
  return [...models]
    .map(([modelId, candidates]) => {
      const winner = selectModelProvider(candidates, providers, now);
      const candidateQuotas = candidates
        .map((candidate) =>
          evaluateCandidateQuota(
            candidate,
            providers,
            now,
            winner !== null && candidate.key === winner.key,
          ),
        )
        .sort((left, right) => {
          if (left.isWinner !== right.isWinner) {
            return left.isWinner ? -1 : 1;
          }
          if (left.isUnavailable !== right.isUnavailable) {
            return left.isUnavailable ? 1 : -1;
          }
          const leftPct = left.remainingPercent ?? -1;
          const rightPct = right.remainingPercent ?? -1;
          if (leftPct !== rightPct) {
            return rightPct - leftPct;
          }
          return left.option.key.localeCompare(right.option.key);
        });

      const {
        earliestReset,
        maxWeeklyPercent,
        label: resetAndWeeklyLabel,
      } = modelResetAndWeekly(candidates, providers, now);

      return {
        modelId,
        candidates,
        candidateQuotas,
        tokens: tokens.get(modelId) ?? 0,
        earliestReset,
        maxWeeklyPercent,
        resetAndWeeklyLabel,
        option: winner,
      };
    })
    .sort(
      (left, right) =>
        right.tokens - left.tokens ||
        (left.candidates[0]?.label ?? left.modelId).localeCompare(
          right.candidates[0]?.label ?? right.modelId,
        ) ||
        left.modelId.localeCompare(right.modelId),
    );
}

/** Moves favorites ahead of the rest, keeping each group's existing (token-use) order. */
export function favoritesFirstBy<E>(
  entries: ReadonlyArray<E>,
  isFavorite: (entry: E) => boolean,
): ReadonlyArray<E> {
  const favorites: E[] = [];
  const others: E[] = [];
  for (const entry of entries) {
    (isFavorite(entry) ? favorites : others).push(entry);
  }
  return [...favorites, ...others];
}

export function isQuotaUnder20<T extends ModelCandidate>(
  option: T | null,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): boolean {
  if (!option) return false;
  const provider = providers.find((p) => p.instanceId === option.selection.instanceId);
  if (!provider?.usageLimits || provider.usageLimits.unavailable) return false;

  const checkedAt = Date.parse(provider.usageLimits.checkedAt);
  if (
    !Number.isFinite(checkedAt) ||
    now - checkedAt > QUOTA_MAX_AGE_MS ||
    checkedAt > now + 60_000
  ) {
    return false;
  }

  const windows = modelUsageWindows(provider.usageLimits, {
    driver: provider.driver,
    model: option.selection.model,
  });
  if (!windows.length) return false;

  const reported =
    provider.driver === "antigravity"
      ? windows.filter((window) => window.kind === "other" && window.id.endsWith("-quota"))
      : [];
  const sessions = windows.filter((window) => window.kind === "session");
  const current = sessions.length ? sessions : reported;
  if (current.length) {
    const minSession = Math.min(...current.map(remainingPercent));
    if (Number.isFinite(minSession) && minSession < 20) {
      return true;
    }
  }

  const minAny = Math.min(...windows.map(remainingPercent));
  return Number.isFinite(minAny) && minAny < 20;
}

export interface ModelFallbackResult<T extends ModelCandidate = ModelCandidate> {
  readonly fallbackOption: T | null;
  readonly fallbackPercent: number | null;
  readonly label: string;
}

export function findModelFallback<T extends ModelCandidate>(
  currentSelection: ModelSelection,
  currentOption: T | null,
  modelOptions: ReadonlyArray<T>,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): ModelFallbackResult<T> {
  const currentDriver = currentOption?.providerDriver;

  const candidates = modelOptions.filter((option) => {
    if (option.selection.instanceId === currentSelection.instanceId) return false;
    if (
      comparableModelName(option.selection.model) !== comparableModelName(currentSelection.model)
    ) {
      return false;
    }
    if (option.isUnavailable || option.isHidden) return false;
    const candDriver = option.providerDriver;
    if (
      currentDriver &&
      candDriver !== currentDriver &&
      candDriver !== "opencode" &&
      currentDriver !== "opencode"
    ) {
      return false;
    }
    const pct = candidateRemainingPercent(option, providers, now);
    if (pct !== null && pct <= 0) return false;
    return true;
  });

  if (candidates.length === 0) {
    return { fallbackOption: null, fallbackPercent: null, label: "No fallback" };
  }

  const sorted = [...candidates].sort((a, b) => {
    const aIsOpenCode = a.providerDriver === "opencode" ? 1 : 0;
    const bIsOpenCode = b.providerDriver === "opencode" ? 1 : 0;
    if (aIsOpenCode !== bIsOpenCode) return aIsOpenCode - bIsOpenCode;

    const aPct = candidateRemainingPercent(a, providers, now) ?? 100;
    const bPct = candidateRemainingPercent(b, providers, now) ?? 100;
    if (bPct !== aPct) return bPct - aPct;

    return a.key.localeCompare(b.key);
  });

  const best = sorted[0]!;
  const pct = candidateRemainingPercent(best, providers, now);
  const label = pct !== null ? `Fallback ${pct}%` : "Fallback";
  return { fallbackOption: best, fallbackPercent: pct, label };
}

export function resolveModelFallback<T extends ModelCandidate>(
  currentSelection: ModelSelection,
  currentOption: T | null,
  modelOptions: ReadonlyArray<T>,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): ModelFallbackResult<T> | null {
  if (!isQuotaUnder20(currentOption, providers, now)) {
    return null;
  }
  return findModelFallback(currentSelection, currentOption, modelOptions, providers, now);
}
