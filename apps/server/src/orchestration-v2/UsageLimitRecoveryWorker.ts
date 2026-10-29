import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { comparableModelName, modelSelectionsEqual } from "@t3tools/shared/model";
import {
  modelUsageWindows,
  remainingPercent as getRemainingPercent,
} from "@t3tools/shared/usageLimits";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const MESSAGE_PREFIX = "message:provider-fallback:";

type FailureScanTurnItem = Parameters<typeof latestRootProviderFailure>[1][number];

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

export interface PlanLimitRecoveryInput {
  readonly projection: {
    readonly thread: Pick<
      OrchestrationV2ThreadProjection["thread"],
      | "id"
      | "projectId"
      | "worktreePath"
      | "modelSelection"
      | "archivedAt"
      | "deletedAt"
      | "settledOverride"
      | "snoozedUntil"
    > & {
      readonly limitRecovery?: OrchestrationV2ThreadProjection["thread"]["limitRecovery"];
      readonly usageLimitResetAt?: string | null;
    };
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly turnItems: ReadonlyArray<FailureScanTurnItem>;
    readonly runtimeRequests: ReadonlyArray<{ readonly status: string }>;
  };
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly currentInstance: ProviderInstance;
  readonly cwd: string | undefined;
  readonly nowMs: number;
  readonly autoResume?: boolean;
  readonly snooze?: boolean;
  readonly isProviderInstanceEnabledForProject: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<boolean>;
}

const planLimitRecovery = Effect.fn("UsageLimitRecoveryWorker.planLimitRecovery")(function* (
  input: PlanLimitRecoveryInput,
) {
  const {
    projection,
    instances,
    currentInstance,
    cwd,
    nowMs,
    autoResume = true,
    snooze = false,
    isProviderInstanceEnabledForProject,
  } = input;

  const run = latestExecutedRun(projection.runs);
  if (!run || run.status !== "failed") return null;

  const failure = latestRootProviderFailure(run, projection.turnItems);
  if (failure?.class !== "usage_limit") return null;

  const runCompletedMs = run.completedAt ? DateTime.toEpochMillis(run.completedAt) : null;
  // The reset is the provider's own report for this failure. Recovery records
  // carry it verbatim; the orchestrator and the recovery queries pair the two.
  const parsedResetMs = failure.resetAt == null ? Number.NaN : Date.parse(failure.resetAt);
  const failureResetAt =
    failure.resetAt != null &&
    Number.isFinite(parsedResetMs) &&
    (runCompletedMs === null || parsedResetMs > runCompletedMs)
      ? failure.resetAt
      : null;
  const failureResetMs = failureResetAt === null ? null : parsedResetMs;

  const recovery = projection.thread.limitRecovery;
  const snoozed =
    projection.thread.snoozedUntil != null &&
    DateTime.toEpochMillis(projection.thread.snoozedUntil) > nowMs;
  // An explicit per-thread cancel parks this failure until the user resumes it.
  const cancelled = recovery != null && recovery.runId === run.id && !recovery.autoResume;

  if (
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null ||
    projection.thread.settledOverride === "settled" ||
    snoozed ||
    cancelled ||
    !modelSelectionsEqual(projection.thread.modelSelection, run.modelSelection) ||
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    projection.turnItems.some(
      (item) => item.type === "run_interrupt_request" && "runId" in item && item.runId === run.id,
    ) ||
    projection.runs.some((r) =>
      ["queued", "preparing", "starting", "running", "waiting"].includes(r.status),
    )
  ) {
    return null;
  }

  if (!cwd) return null;

  // Arm only at the failed run's own reset. Waking earlier for another account
  // is not expressible in limitRecovery, which the orchestrator and the recovery
  // queries validate against this failure.
  const armCommand = (): OrchestrationV2ServerCommand | null => {
    if (failureResetAt === null || failureResetMs === null) return null;
    if (recovery?.runId === run.id && recovery.resetAt === failureResetAt) return null;
    if (!autoResume && (!snooze || failureResetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${projection.thread.id}:${run.id}:${failureResetMs}`),
      threadId: projection.thread.id,
      limitRecovery: {
        runId: run.id,
        resetAt: failureResetAt,
        autoResume,
        snooze: snooze && failureResetMs > nowMs,
      },
    };
  };

  // Switching accounts is automatic recovery too, so the setting gates it.
  if (!autoResume) return armCommand();

  const tried = new Set<ProviderInstanceId>([run.providerInstanceId]);
  const visited = new Set([run.id]);
  let source = run;
  while (source.userMessageId.startsWith(MESSAGE_PREFIX)) {
    const parentId = source.userMessageId.slice(MESSAGE_PREFIX.length);
    const parent = projection.runs.find((candidate) => candidate.id === parentId);
    if (!parent || visited.has(parent.id)) return null;
    visited.add(parent.id);
    tried.add(parent.providerInstanceId);
    source = parent;
  }

  const currentDriver = currentInstance.driverKind;

  interface CandidateEvaluation {
    readonly candidate: ProviderInstance;
    readonly model: ServerProviderModel;
    readonly remainingPercent: number | null;
  }

  const readyCandidates: CandidateEvaluation[] = [];

  for (const candidate of instances) {
    if (
      !candidate.enabled ||
      (candidate.driverKind !== currentDriver &&
        candidate.driverKind !== "opencode" &&
        currentDriver !== "opencode")
    ) {
      continue;
    }

    const enabledForProject = yield* isProviderInstanceEnabledForProject({
      projectId: projection.thread.projectId,
      instanceId: candidate.instanceId,
    });
    if (!enabledForProject) continue;

    const snapshot = yield* candidate.snapshotForCwd
      ? candidate.snapshotForCwd(cwd).pipe(Effect.orElseSucceed(() => null))
      : candidate.snapshot.getSnapshot;

    if (
      !snapshot ||
      !snapshot.enabled ||
      !snapshot.installed ||
      snapshot.status === "error" ||
      snapshot.status === "disabled" ||
      snapshot.auth.status === "unauthenticated"
    ) {
      continue;
    }

    const model = snapshot.models.find(
      (m) => comparableModelName(m.slug) === comparableModelName(run.modelSelection.model),
    );
    if (!model) continue;

    const descriptors = model.capabilities?.optionDescriptors ?? [];
    if (
      run.modelSelection.options?.some((option) => {
        const descriptor = descriptors.find((d) => d.id === option.id);
        return (
          !descriptor ||
          (descriptor.type === "boolean"
            ? typeof option.value !== "boolean"
            : !descriptor.options.some((choice) => choice.id === option.value))
        );
      })
    ) {
      continue;
    }

    const limits = snapshot.usageLimits;
    const checkedAt = limits?.checkedAt ? Date.parse(limits.checkedAt) : NaN;
    const isFreshLimits =
      limits &&
      !limits.unavailable &&
      Number.isFinite(checkedAt) &&
      nowMs - checkedAt <= 5 * 60_000 &&
      checkedAt <= nowMs + 60_000;

    let remainingPct: number | null = null;
    let candidateResetMs: number | null = null;

    if (isFreshLimits) {
      const windows = modelUsageWindows(limits, {
        driver: snapshot.driver,
        model: model.slug,
      });
      const weeklyWindows = windows.filter((w) => w.kind === "weekly");
      const isWeeklyBlocked = weeklyWindows.some((w) => getRemainingPercent(w) <= 0);

      if (isWeeklyBlocked) {
        remainingPct = 0;
        let hasFutureReset = false;
        let hasPastReset = false;
        for (const w of weeklyWindows) {
          if (w.resetsAt) {
            const at = Date.parse(w.resetsAt);
            if (Number.isFinite(at)) {
              if (at > nowMs) {
                hasFutureReset = true;
                if (candidateResetMs === null || at < candidateResetMs) {
                  candidateResetMs = at;
                }
              } else {
                hasPastReset = true;
              }
            }
          }
        }
        if (hasPastReset && !hasFutureReset) {
          remainingPct = 100;
        }
      } else {
        const sessionWindows = windows.filter(
          (w) =>
            w.kind === "session" ||
            (snapshot.driver === "antigravity" && w.kind === "other" && w.id.endsWith("-quota")),
        );
        const effectiveWindows = sessionWindows.length > 0 ? sessionWindows : windows;
        if (effectiveWindows.length > 0) {
          remainingPct = Math.min(...effectiveWindows.map((w) => getRemainingPercent(w)));
        }
        if (remainingPct !== null && remainingPct <= 0) {
          let hasFutureReset = false;
          let hasPastReset = false;
          for (const w of windows) {
            if (w.resetsAt) {
              const at = Date.parse(w.resetsAt);
              if (Number.isFinite(at)) {
                if (at > nowMs) {
                  hasFutureReset = true;
                  if (candidateResetMs === null || at < candidateResetMs) {
                    candidateResetMs = at;
                  }
                } else {
                  hasPastReset = true;
                }
              }
            }
          }
          if (hasPastReset && !hasFutureReset) {
            remainingPct = 100;
          }
        }
      }
    }

    const wasTried = tried.has(candidate.instanceId);
    const hasReplenishedQuota = remainingPct !== null && remainingPct > 0;
    if (wasTried) {
      if (
        candidate.instanceId === run.providerInstanceId &&
        candidateResetMs === null &&
        failureResetMs !== null
      ) {
        candidateResetMs = failureResetMs;
      }
      const resetArrived = candidateResetMs !== null && candidateResetMs <= nowMs;

      if (hasReplenishedQuota || (resetArrived && (remainingPct === null || remainingPct > 0))) {
        readyCandidates.push({
          candidate,
          model,
          remainingPercent: remainingPct,
        });
      }
    } else if (remainingPct === null || remainingPct > 0) {
      readyCandidates.push({
        candidate,
        model,
        remainingPercent: remainingPct,
      });
    }
  }

  if (readyCandidates.length > 0) {
    readyCandidates.sort((left, right) => {
      const opencodeDiff =
        Number(left.candidate.driverKind === "opencode") -
        Number(right.candidate.driverKind === "opencode");
      if (opencodeDiff !== 0) return opencodeDiff;

      const leftPct = left.remainingPercent ?? 100;
      const rightPct = right.remainingPercent ?? 100;
      const quotaDiff = rightPct - leftPct;
      if (quotaDiff !== 0) return quotaDiff;

      return left.candidate.instanceId.localeCompare(right.candidate.instanceId);
    });

    const winner = readyCandidates[0]!;

    if (winner.candidate.instanceId !== run.providerInstanceId) {
      const fallbackCommand: OrchestrationV2ServerCommand = {
        type: "message.dispatch",
        commandId: CommandId.make(`provider-fallback:${run.id}`),
        messageId: MessageId.make(`${MESSAGE_PREFIX}${run.id}`),
        threadId: projection.thread.id,
        providerFallbackOfRunId: run.id,
        modelSelection: {
          ...run.modelSelection,
          model: winner.model.slug,
          instanceId: winner.candidate.instanceId,
        },
        text: "The previous provider account reached its usage limit. Continue where you left off using this account and the same model and options. Check the recorded progress before repeating any actions.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
      };
      return fallbackCommand;
    }

    // The orchestrator only honours a continuation that an armed recovery
    // vouches for. A delivery it discards still stores its receipt, so arm and
    // let the next sweep resume instead of burning the command ID.
    const armedRecovery =
      failureResetAt !== null &&
      failureResetMs !== null &&
      failureResetMs <= nowMs &&
      recovery != null &&
      recovery.runId === run.id &&
      recovery.resetAt === failureResetAt &&
      recovery.autoResume
        ? recovery
        : null;
    if (armedRecovery === null || failureResetMs === null) return armCommand();

    const identity = `${projection.thread.id}:${run.id}:${failureResetMs}`;
    const deliveryIdentity = `${identity}:${armedRecovery.requestId ?? "legacy"}`;
    const continuationCommand: OrchestrationV2ServerCommand = {
      type: "message.dispatch",
      commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
      messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
      threadId: projection.thread.id,
      usageLimitContinuationOfRunId: run.id,
      ...(armedRecovery.requestId === undefined
        ? {}
        : { usageLimitRecoveryRequestId: armedRecovery.requestId }),
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    };
    return continuationCommand;
  }

  return armCommand();
});

export const recoverThread = Effect.fn("UsageLimitRecoveryWorker.recoverThread")(function* (
  threadId: ThreadId,
  options?: { autoResume?: boolean; snooze?: boolean; nowMs?: number },
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectsOpt = yield* Effect.serviceOption(ProjectService.ProjectService);
  const registryOpt = yield* Effect.serviceOption(
    ProviderInstanceRegistry.ProviderInstanceRegistry,
  );
  const settingsOpt = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);

  const now = yield* DateTime.now;
  const nowMs = options?.nowMs ?? DateTime.toEpochMillis(now);

  const settings = Option.isSome(settingsOpt) ? yield* settingsOpt.value.getSettings : null;
  const autoResume = options?.autoResume ?? settings?.autoResumeLimitedThreads ?? true;
  const snooze = options?.snooze ?? settings?.snoozeLimitedThreads ?? false;

  const projection = yield* threads.getThreadRecords(threadId, [
    "runs",
    "turnItems",
    "runtimeRequests",
  ]);

  if (!Option.isSome(registryOpt)) return;
  const registry = registryOpt.value;

  const run = latestExecutedRun(projection.runs);
  if (!run || run.status !== "failed") return;

  const current = yield* registry.getInstance(run.providerInstanceId);
  if (!current) return;

  const project = Option.isSome(projectsOpt)
    ? yield* projectsOpt.value.getById(projection.thread.projectId)
    : Option.none();
  const cwd =
    projection.thread.worktreePath ??
    (Option.isSome(project) ? project.value.workspaceRoot : undefined);
  if (!cwd) return;

  const instances = yield* registry.listInstances;

  const command = yield* planLimitRecovery({
    projection,
    instances,
    currentInstance: current,
    cwd,
    nowMs,
    autoResume,
    snooze,
    isProviderInstanceEnabledForProject: (input) =>
      threads.isProviderInstanceEnabledForProject(input),
  });

  if (!command) return;

  if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
    yield* orchestrator.autoArmLimitRecovery({
      commandId: command.commandId,
      threadId: command.threadId,
      limitRecovery: command.limitRecovery,
    });
  } else {
    yield* threads.dispatch(command);
  }
});

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registryOpt = yield* Effect.serviceOption(
    ProviderInstanceRegistry.ProviderInstanceRegistry,
  );

  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of candidates) {
      yield* Effect.gen(function* () {
        if (Option.isSome(registryOpt)) {
          yield* recoverThread(thread.id, {
            autoResume: preferences.autoResumeLimitedThreads,
            snooze: preferences.snoozeLimitedThreads,
            nowMs,
          });
        } else {
          const command = limitRecoveryCommand(
            thread,
            preferences.autoResumeLimitedThreads,
            nowMs,
            preferences.snoozeLimitedThreads,
          );
          if (command === null) return;
          if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
            yield* orchestrator.autoArmLimitRecovery({
              commandId: command.commandId,
              threadId: command.threadId,
              limitRecovery: command.limitRecovery,
            });
          } else {
            yield* threads.dispatch(command);
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
