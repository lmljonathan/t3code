import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  UsageSummary,
} from "@t3tools/contracts";
import {
  buildModelOnlyCatalog,
  selectModelProvider,
  type ModelCandidate,
  type ModelOnlyEntry,
} from "@t3tools/shared/modelOnlyCatalog";

import { modelPickerModelKey } from "./modelPickerKeys";

/** The picker item fields the model-only view reads. */
export interface ModelOnlyPickerSource {
  readonly slug: string;
  readonly name: string;
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly instanceDisplayName: string;
  readonly isUnavailable?: boolean | undefined;
}

type PickerCandidate<T extends ModelOnlyPickerSource> = ModelCandidate & { readonly item: T };

export interface ModelOnlyPickerEntry<T extends ModelOnlyPickerSource> {
  readonly modelId: string;
  /** What the row shows: the account that would be used, else the first account offering it. */
  readonly item: T;
  /** The account selecting this model would use now, or `null` when none reports fresh quota. */
  readonly winner: T | null;
  readonly catalog: ModelOnlyEntry<PickerCandidate<T>>;
}

function toCandidate<T extends ModelOnlyPickerSource>(item: T): PickerCandidate<T> {
  return {
    item,
    key: modelPickerModelKey(item.instanceId, item.slug),
    label: item.name,
    providerLabel: item.instanceDisplayName,
    providerDriver: item.driverKind,
    isUnavailable: item.isUnavailable === true,
    capabilities: null,
    selection: { instanceId: item.instanceId, model: item.slug },
  };
}

/**
 * One entry per exact model, however many accounts offer it, ordered by recent token use.
 * Callers pass only the items the picker may select (locked-thread and project filters applied).
 */
export function buildModelOnlyPickerEntries<T extends ModelOnlyPickerSource>(
  items: ReadonlyArray<T>,
  providers: ReadonlyArray<ServerProvider>,
  usage: UsageSummary | null,
  now: number,
): ReadonlyArray<ModelOnlyPickerEntry<T>> {
  return buildModelOnlyCatalog(items.map(toCandidate), providers, usage, now).flatMap((catalog) => {
    const winner = catalog.option?.item ?? null;
    const shown =
      winner ?? (catalog.candidates.find((c) => !c.isUnavailable) ?? catalog.candidates[0])?.item;
    return shown ? [{ modelId: catalog.modelId, item: shown, winner, catalog }] : [];
  });
}

/** Re-evaluates quota at selection time; the list may have been rendered minutes earlier. */
export function selectModelOnlyAccount<T extends ModelOnlyPickerSource>(
  entry: ModelOnlyPickerEntry<T>,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): T | null {
  return selectModelProvider(entry.catalog.candidates, providers, now)?.item ?? null;
}
