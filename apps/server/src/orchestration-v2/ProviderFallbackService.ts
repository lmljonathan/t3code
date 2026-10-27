import { type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { recoverThread } from "./UsageLimitRecoveryWorker.ts";

export class ProviderFallbackService extends Context.Service<
  ProviderFallbackService,
  {
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/ProviderFallbackService") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projectsOpt = yield* Effect.serviceOption(ProjectService.ProjectService);
  const registryOpt = yield* Effect.serviceOption(
    ProviderInstanceRegistry.ProviderInstanceRegistry,
  );
  const settingsOpt = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);

  // The domain stream includes every text delta; avoid tracing the fast rejection path.
  const handle: ProviderFallbackService["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      // A failed startup can persist the run and its error in either order.
      if (
        !(event.type === "run.updated" && event.payload.status === "failed") &&
        !(
          event.type === "turn-item.updated" &&
          event.payload.type === "error" &&
          event.payload.failure.class === "usage_limit"
        )
      )
        return;

      let effect = recoverThread(event.threadId).pipe(
        Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
      );
      if (Option.isSome(projectsOpt)) {
        effect = effect.pipe(
          Effect.provideService(ProjectService.ProjectService, projectsOpt.value),
        );
      }
      if (Option.isSome(registryOpt)) {
        effect = effect.pipe(
          Effect.provideService(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            registryOpt.value,
          ),
        );
      }
      if (Option.isSome(settingsOpt)) {
        effect = effect.pipe(
          Effect.provideService(ServerSettings.ServerSettingsService, settingsOpt.value),
        );
      }
      yield* effect;
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Automatic provider fallback failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  return {
    handle,
    start: () => forkParked(Stream.runForEach(orchestrator.streamDomainEvents, handle)),
  } satisfies ProviderFallbackService["Service"];
});

export const layer = Layer.effect(ProviderFallbackService, make);
