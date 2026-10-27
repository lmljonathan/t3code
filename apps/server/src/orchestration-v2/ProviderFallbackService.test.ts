import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderFallbackService from "./ProviderFallbackService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("fallback-thread");
const primary = ProviderInstanceId.make("codex-primary");
const backup = ProviderInstanceId.make("codex-backup");
const third = ProviderInstanceId.make("codex-third");
const selection: ModelSelection = {
  instanceId: primary,
  model: "gpt-6.1-sol",
  options: [
    { id: "reasoningEffort", value: "max" },
    { id: "serviceTier", value: "priority" },
  ],
};

function instance(
  id: ProviderInstanceId,
  overrides: Partial<ServerProvider> = {},
): ProviderInstance {
  const snapshot = {
    instanceId: id,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [
      {
        slug: selection.model,
        capabilities: {
          optionDescriptors: [
            { id: "reasoningEffort", type: "select", options: [{ id: "max" }] },
            { id: "serviceTier", type: "select", options: [{ id: "priority" }] },
          ],
        },
      },
    ],
    ...overrides,
  } as ServerProvider;
  return {
    instanceId: id,
    driverKind: snapshot.driver,
    enabled: snapshot.enabled,
    snapshot: { getSnapshot: Effect.succeed(snapshot) },
  } as ProviderInstance;
}

const fixture = Effect.fn(function* () {
  const now = yield* DateTime.now;
  const run: OrchestrationV2Run = {
    id: RunId.make("failed-run"),
    threadId,
    ordinal: 1,
    providerInstanceId: primary,
    modelSelection: selection,
    providerThreadId: null,
    userMessageId: MessageId.make("user-message"),
    rootNodeId: NodeId.make("root"),
    activeAttemptId: null,
    status: "failed",
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
  const failure = {
    id: TurnItemId.make("error"),
    type: "error" as const,
    threadId,
    runId: run.id,
    nodeId: run.rootNodeId,
    status: "failed" as const,
    ordinal: 1,
    updatedAt: now,
    failure: {
      class: "usage_limit" as const,
      message: "Quota exceeded",
      code: null,
      retryable: null,
    },
  } as OrchestrationV2ThreadProjection["turnItems"][number];
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      worktreePath: "/repo/worktree",
      modelSelection: selection,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      snoozedUntil: null,
    },
    runs: [run],
    turnItems: [failure],
    runtimeRequests: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const event: OrchestrationV2DomainEvent = {
    id: EventId.make("failed"),
    type: "run.updated",
    threadId,
    occurredAt: now,
    payload: run,
  };
  return { projection, event, run, now };
});

const exercise = Effect.fn(function* (
  data: Effect.Success<ReturnType<typeof fixture>>,
  instances: ReadonlyArray<ProviderInstance> = [instance(primary), instance(backup)],
  disabled: ReadonlyArray<ProviderInstanceId> = [],
) {
  const commands: OrchestrationV2ServerCommand[] = [];
  const deps = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.empty,
      autoArmLimitRecovery: (input) =>
        Effect.sync(() => {
          commands.push({
            type: "thread.metadata.update",
            commandId: input.commandId,
            threadId: input.threadId,
            limitRecovery: input.limitRecovery,
          } as OrchestrationV2ServerCommand);
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (id) => Effect.succeed(instances.find((instance) => instance.instanceId === id)),
      listInstances: Effect.succeed(instances),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(data.projection),
      isProviderInstanceEnabledForProject: ({ instanceId }) =>
        Effect.succeed(!disabled.includes(instanceId)),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return {} as never;
        }),
    }),
  );
  yield* Effect.gen(function* () {
    const service = yield* ProviderFallbackService.ProviderFallbackService;
    yield* service.handle(data.event);
  }).pipe(Effect.provide(ProviderFallbackService.layer.pipe(Layer.provide(deps))));
  return commands;
});

describe("exact-model provider fallback", () => {
  it.effect("continues with the exact model and options on another Codex instance", () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const commands = yield* exercise(data);
      assert.lengthOf(commands, 1);
      const command = commands[0];
      assert.equal(command?.type, "message.dispatch");
      if (command?.type !== "message.dispatch") return;
      assert.deepEqual(command.modelSelection, { ...selection, instanceId: backup });
      assert.equal(command.providerFallbackOfRunId, data.run.id);
      assert.equal(command.messageId, `message:provider-fallback:${data.run.id}`);
    }),
  );

  it.effect.each([
    ["a different harness", { driver: ProviderDriverKind.make("claude") }],
    [
      "a model alias without an exact match",
      {
        models: [
          {
            slug: "other-model",
            aliases: [selection.model],
            isCustom: false,
            name: "Other",
            capabilities: null,
          },
        ],
      },
    ],
    [
      "unsupported options",
      { models: [{ slug: selection.model, isCustom: false, name: "Same", capabilities: null }] },
    ],
    ["disabled instances", { enabled: false }],
    ["missing installation", { installed: false }],
    ["signed-out accounts", { auth: { status: "unauthenticated" } }],
    ["unavailable instances", { status: "error" }],
  ] as const)("skips %s", ([_label, overrides]) =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const commands = yield* exercise(data, [
        instance(primary),
        instance(backup, overrides),
        instance(third),
      ]);
      assert.lengthOf(commands, 1);
      assert.equal(
        commands[0]?.type === "message.dispatch" && commands[0].modelSelection?.instanceId,
        third,
      );
    }),
  );

  it.effect("tries OpenCode last and preserves its namespaced model ID", () =>
    Effect.gen(function* () {
      const open = instance(third, {
        driver: ProviderDriverKind.make("opencode"),
        models: [
          {
            slug: "openai/gpt-6.1-sol",
            name: "GPT 6.1 Sol",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Effort",
                  type: "select",
                  options: [{ id: "max", label: "Max" }],
                },
                {
                  id: "serviceTier",
                  label: "Tier",
                  type: "select",
                  options: [{ id: "priority", label: "Priority" }],
                },
              ],
            },
          },
        ],
      });
      const data = yield* fixture();
      const first = yield* exercise(data, [instance(primary), open, instance(backup)]);
      assert.equal(
        first[0]?.type === "message.dispatch" && first[0].modelSelection?.instanceId,
        backup,
      );
      const last = yield* exercise(data, [instance(primary), open], [backup]);
      assert.equal(
        last[0]?.type === "message.dispatch" && last[0].modelSelection?.model,
        "openai/gpt-6.1-sol",
      );
    }),
  );

  it.effect("respects project-disabled instances", () =>
    Effect.gen(function* () {
      const commands = yield* exercise(yield* fixture(), undefined, [backup]);
      assert.isEmpty(commands);
    }),
  );

  it.effect("stops after exhausting the persisted fallback chain", () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const next = {
        ...data.run,
        id: RunId.make("next-run"),
        ordinal: 2,
        providerInstanceId: backup,
        modelSelection: { ...selection, instanceId: backup },
        userMessageId: MessageId.make(`message:provider-fallback:${data.run.id}`),
      };
      const projection = {
        ...data.projection,
        thread: { ...data.projection.thread, modelSelection: next.modelSelection },
        runs: [data.run, next],
        turnItems: data.projection.turnItems.map((item) => ({ ...item, runId: next.id })),
      };
      const commands = yield* exercise({
        ...data,
        projection,
        event: { ...data.event, type: "run.updated", payload: next },
      });
      assert.isEmpty(commands);
    }),
  );

  it.effect.each([
    "stopped",
    "stop-request",
    "snoozed",
    "changed-model",
    "active-run",
    "permission-error",
  ] as const)("does not restart a %s thread", (state) =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const projection = { ...data.projection, thread: { ...data.projection.thread } };
      if (state === "stopped")
        projection.thread = { ...projection.thread, settledOverride: "settled" };
      if (state === "stop-request")
        projection.turnItems = [
          ...projection.turnItems,
          {
            ...projection.turnItems[0],
            type: "run_interrupt_request",
            runId: data.run.id,
          } as OrchestrationV2ThreadProjection["turnItems"][number],
        ];
      if (state === "snoozed") projection.thread = { ...projection.thread, snoozedUntil: data.now };
      if (state === "changed-model")
        projection.thread = {
          ...projection.thread,
          modelSelection: { ...selection, model: "other" },
        };
      if (state === "active-run")
        projection.runs = [
          ...projection.runs,
          {
            ...data.run,
            id: RunId.make("active"),
            ordinal: 2,
            status: "starting",
            completedAt: null,
          },
        ];
      if (state === "permission-error")
        projection.turnItems = projection.turnItems.map((item) =>
          item.type === "error"
            ? { ...item, failure: { ...item.failure, class: "permission_error" } }
            : item,
        );
      assert.isEmpty(yield* exercise({ ...data, projection }));
    }),
  );

  it.effect("selects the provider with the highest quota when multiple are available", () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const nowIso = DateTime.formatIso(data.now);
      const backupWith20 = instance(backup, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 80 }],
        },
      });
      const thirdWith80 = instance(third, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 20 }],
        },
      });
      const commands = yield* exercise(data, [instance(primary), backupWith20, thirdWith80]);
      assert.lengthOf(commands, 1);
      assert.equal(
        commands[0]?.type === "message.dispatch" && commands[0].modelSelection?.instanceId,
        third,
      );
    }),
  );

  it.effect("skips candidate whose quota is 0% and selects available candidate", () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const nowIso = DateTime.formatIso(data.now);
      const backupExhausted = instance(backup, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: DateTime.formatIso(DateTime.add(data.now, { hours: 1 })),
            },
          ],
        },
      });
      const thirdAvailable = instance(third, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 40 }],
        },
      });
      const commands = yield* exercise(data, [instance(primary), backupExhausted, thirdAvailable]);
      assert.lengthOf(commands, 1);
      assert.equal(
        commands[0]?.type === "message.dispatch" && commands[0].modelSelection?.instanceId,
        third,
      );
    }),
  );

  it.effect("skips candidate whose weekly quota is exhausted and selects available candidate", () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const nowIso = DateTime.formatIso(data.now);
      const backupWeeklyBlocked = instance(backup, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 100,
              resetsAt: DateTime.formatIso(DateTime.add(data.now, { days: 2 })),
            },
            {
              id: "session",
              kind: "session",
              label: "Session",
              usedPercent: 10,
            },
          ],
        },
      });
      const thirdAvailable = instance(third, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 30 }],
        },
      });
      const commands = yield* exercise(data, [
        instance(primary),
        backupWeeklyBlocked,
        thirdAvailable,
      ]);
      assert.lengthOf(commands, 1);
      assert.equal(
        commands[0]?.type === "message.dispatch" && commands[0].modelSelection?.instanceId,
        third,
      );
    }),
  );

  it.effect("arms thread with earliest reset when all candidates are exhausted", () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const nowIso = DateTime.formatIso(data.now);
      const backupReset = DateTime.add(data.now, { minutes: 30 });
      const thirdReset = DateTime.add(data.now, { hours: 2 });
      const backupExhausted = instance(backup, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: DateTime.formatIso(backupReset),
            },
          ],
        },
      });
      const thirdExhausted = instance(third, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: DateTime.formatIso(thirdReset),
            },
          ],
        },
      });
      const commands = yield* exercise(data, [instance(primary), backupExhausted, thirdExhausted]);
      assert.lengthOf(commands, 1);
      const command = commands[0];
      assert.equal(command?.type, "thread.metadata.update");
      if (command?.type !== "thread.metadata.update") return;
      assert.equal(command.limitRecovery?.resetAt, DateTime.formatIso(backupReset));
      assert.isTrue(command.limitRecovery?.autoResume);
    }),
  );

  it.effect("resumes with alternative provider once its reset time has arrived", () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const nowIso = DateTime.formatIso(data.now);
      const backupPassed = instance(backup, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: DateTime.formatIso(DateTime.subtract(data.now, { minutes: 5 })),
            },
          ],
        },
      });
      const thirdStillExhausted = instance(third, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: DateTime.formatIso(DateTime.add(data.now, { hours: 2 })),
            },
          ],
        },
      });
      const commands = yield* exercise(data, [
        instance(primary),
        backupPassed,
        thirdStillExhausted,
      ]);
      assert.lengthOf(commands, 1);
      assert.equal(commands[0]?.type, "message.dispatch");
      if (commands[0]?.type !== "message.dispatch") return;
      assert.equal(commands[0].modelSelection?.instanceId, backup);
      assert.equal(commands[0].providerFallbackOfRunId, data.run.id);
    }),
  );

  it.effect("resumes with primary provider via continuation when primary resets first", () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const nowIso = DateTime.formatIso(data.now);
      const primaryReset = instance(primary, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 20,
              resetsAt: DateTime.formatIso(DateTime.subtract(data.now, { minutes: 5 })),
            },
          ],
        },
      });
      const backupExhausted = instance(backup, {
        usageLimits: {
          checkedAt: nowIso,
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: DateTime.formatIso(DateTime.add(data.now, { hours: 1 })),
            },
          ],
        },
      });
      const commands = yield* exercise(data, [primaryReset, backupExhausted]);
      assert.lengthOf(commands, 1);
      const command = commands[0];
      assert.equal(command?.type, "message.dispatch");
      if (command?.type !== "message.dispatch") return;
      assert.equal(command.usageLimitContinuationOfRunId, data.run.id);
      assert.isUndefined(command.modelSelection);
      assert.equal(command.text, "Continue where you left off.");
    }),
  );
});
