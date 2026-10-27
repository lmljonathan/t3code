import type {
  ModelCandidateQuota as SharedModelCandidateQuota,
  ModelFallbackResult as SharedModelFallbackResult,
  ModelOnlyEntry as SharedModelOnlyEntry,
} from "@t3tools/shared/modelOnlyCatalog";
import type { ModelOption } from "./modelOptions";

// The catalog logic is shared with web; mobile pins it to its own option type.
export * from "@t3tools/shared/modelOnlyCatalog";
export type ModelCandidateQuota = SharedModelCandidateQuota<ModelOption>;
export type ModelFallbackResult = SharedModelFallbackResult<ModelOption>;
export type ModelOnlyEntry = SharedModelOnlyEntry<ModelOption>;
