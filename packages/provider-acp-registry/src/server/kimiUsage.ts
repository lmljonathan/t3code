import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const DEFAULT_BASE_URL = "https://api.kimi.ai/coding/v1";
const MANAGED_PROVIDER = "managed:kimi-code";
// Access tokens last about 15 minutes and only the CLI renews them.
const REFRESH_WITHIN_SECONDS = 120;
const REFRESH_TIMEOUT = Duration.seconds(20);
const REQUEST_TIMEOUT = Duration.seconds(15);

const KimiCredentials = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Number),
});
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(KimiCredentials));

const KimiUsageEntry = Schema.Struct({
  used_ratio: Schema.optional(Schema.Number),
  reset_time: Schema.optional(Schema.String),
});
const KimiUsageResponse = Schema.Struct({
  usages: Schema.optional(Schema.Record(Schema.String, KimiUsageEntry)),
});

const USAGE_WINDOWS: ReadonlyArray<{
  readonly key: string;
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly windowDurationMins?: number;
}> = [
  { key: "limit_5h", id: "five_hour", kind: "session", label: "5-hour", windowDurationMins: 300 },
  { key: "limit_month_total", id: "month_total", kind: "monthly", label: "Monthly" },
  { key: "limit_month_code", id: "month_code", kind: "monthly", label: "Monthly (code)" },
];

/** True for the Kimi Code CLI executable, whichever directory it was installed in. */
export function isKimiCodeCommand(command: string): boolean {
  return /(?:^|[\\/])kimi(?:\.exe)?$/iu.test(command.trim());
}

/** Reads the managed provider's endpoint and credential file name from `config.toml`. */
export function parseKimiCodeConfig(toml: string): {
  readonly baseUrl: string;
  readonly credentialName: string | undefined;
} {
  const section = (header: string) => {
    const start = toml.indexOf(`[${header}]`);
    if (start < 0) return "";
    const rest = toml.slice(start + header.length + 2);
    const next = rest.search(/^\[/mu);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const value = (text: string, key: string) =>
    new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "mu").exec(text)?.[1];
  const baseUrl = value(section(`providers."${MANAGED_PROVIDER}"`), "base_url")?.trim();
  const key = value(section(`providers."${MANAGED_PROVIDER}".oauth`), "key")?.trim();
  return {
    baseUrl: (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/u, ""),
    // The key reads `oauth/<name>` and the file is `credentials/<name>.json`.
    credentialName: key?.replace(/^oauth\//u, "") || undefined,
  };
}

export function kimiUsageResponseToLimits(
  response: typeof KimiUsageResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const windows: ServerProviderUsageWindow[] = [];
  for (const spec of USAGE_WINDOWS) {
    const entry = response.usages?.[spec.key];
    if (entry?.used_ratio === undefined || !Number.isFinite(entry.used_ratio)) continue;
    const reset = entry.reset_time ? DateTime.make(entry.reset_time) : Option.none();
    windows.push({
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      usedPercent: clampPercent(entry.used_ratio * 100),
      ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
      ...(spec.windowDurationMins === undefined
        ? {}
        : { windowDurationMins: spec.windowDurationMins }),
    });
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
}

/**
 * Quota for a Kimi Code login. Returns `undefined` when there is no Kimi Code login to read,
 * so other ACP agents (and Kimi CLI 1.x, which keeps its login elsewhere) are left alone.
 */
export const readKimiUsageLimits = Effect.fn("readKimiUsageLimits")(function* (input: {
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  if (!isKimiCodeCommand(input.command)) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home =
    input.environment.KIMI_CODE_HOME?.trim() ||
    path.join(yield* HostProcess.HomeDirectory, ".kimi-code");
  const config = yield* fs
    .readFileString(path.join(home, "config.toml"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (config === undefined) return undefined;
  const { baseUrl, credentialName } = parseKimiCodeConfig(config);
  if (!credentialName) return undefined;
  const credentialsPath = path.join(home, "credentials", `${credentialName}.json`);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const failed = (message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message });

  const readCredentials = fs
    .readFileString(credentialsPath)
    .pipe(Effect.flatMap(decodeCredentials));
  let credentials = yield* readCredentials.pipe(Effect.option);
  if (
    Option.isSome(credentials) &&
    (credentials.value.expires_at ?? 0) - Math.floor((yield* Clock.currentTimeMillis) / 1000) <
      REFRESH_WITHIN_SECONDS
  ) {
    // `acp --login` renews a saved login without prompting. Without one it would start a
    // device-code flow, so the timeout keeps a signed-out account from hanging the probe.
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.command, ["acp", "--login"], { env: input.environment }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      yield* child.exitCode;
    }).pipe(Effect.scoped, Effect.timeoutOption(REFRESH_TIMEOUT), Effect.ignore);
    credentials = yield* readCredentials.pipe(Effect.option);
  }
  const token = Option.isSome(credentials) ? credentials.value.access_token?.trim() : undefined;
  if (!token) return failed("Sign in to Kimi Code to see usage.");

  const client = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (Option.isNone(client)) return failed("Kimi usage needs an HTTP client.");
  return yield* client.value
    .execute(
      HttpClientRequest.get(`${baseUrl}/usages`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader("User-Agent", "t3-code"),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? HttpClientResponse.schemaBodyJson(KimiUsageResponse)(response).pipe(
              Effect.map((body) => kimiUsageResponseToLimits(body, checkedAt)),
            )
          : Effect.succeed(failed(`Kimi usage returned HTTP ${response.status}.`)),
      ),
      Effect.timeoutOption(REQUEST_TIMEOUT),
      Effect.map(Option.getOrElse(() => failed("Kimi usage timed out."))),
      Effect.catch(() => Effect.succeed(failed("Could not read Kimi usage."))),
    );
});
