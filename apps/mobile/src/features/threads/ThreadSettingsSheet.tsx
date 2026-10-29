import { SliderRow } from "../../components/ui/SliderRow";
import { comparableModelName } from "@t3tools/shared/model";
import {
  buildModelOnlyCatalog,
  favoritesFirstBy,
  selectModelProvider,
  type ModelCandidateQuota,
  type ModelOnlyEntry,
} from "../../lib/modelOnlyCatalog";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import {
  getPromptControlledTraits,
  getTraitSelectChange,
} from "@t3tools/client-runtime/model-traits";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { Toolbar } from "../../components/ui/Toolbar";
import * as Dialog from "../../components/ui/Dialog";
import { createV5StackNavigator as createNativeStackNavigator } from "../../native/createV5StackNavigator";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import {
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
} from "@t3tools/shared/serverSettings";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { setStickyComposerModelSelection } from "../../state/use-composer-drafts";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
  ServerSettings,
} from "@t3tools/contracts";
import type { LegendListRenderItemProps } from "@legendapp/list/react-native";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { type NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { AsyncResult } from "effect/reactivity";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Platform, Pressable, RefreshControl, ScrollView, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { IconButton } from "../../components/ui/IconButton";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import {
  buildModelOptions,
  groupByProvider,
  type ModelOption,
  type ProviderGroup,
} from "../../lib/modelOptions";
import { applyProviderOptionSelection } from "../../lib/providerOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { ChatGptSharingStatus } from "./ChatGptSharingStatus";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { useModelUsageRanking } from "./use-model-usage-ranking";
import { ScreenContent } from "../../components/ui/ScreenContent";
import {
  createProviderCatalogRefreshRunner,
  providerCatalogRefreshError,
} from "./provider-catalog-refresh";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
} from "../layout/native-mail-search-toolbar";
import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { ModelRow, ChoiceRow } from "./ThreadSettingsRows";
import {
  compatibleRuntimeModeForChoices,
  runtimeModeChoicesForSupportedModes,
  selectableChoices,
} from "./thread-settings-options";
import {
  canCommitPendingModel,
  favoritesFirst,
  modelFavoriteKey,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
  providerSectionIsCollapsed,
} from "./thread-settings-sheet-state";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";

const PRIMARY_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "antigravity",
]);
/**
 * Keep measured row changes stable, but let catalog mutations use the list's
 * native bounds so a filtered catalog that underflows returns to the top.
 */
const THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;
const THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_CATALOG_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_CATALOG_EXIT_TRANSITION = FadeOut.duration(120);
const THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_OPTION_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_OPTION_EXIT_TRANSITION = FadeOut.duration(100);
const THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(
  Platform.OS,
  Platform.Version,
);
const EMPTY_MODEL_FAVORITES: ReadonlyArray<{
  readonly provider: ProviderInstanceId;
  readonly model: string;
}> = [];
const FAVORITES_PROVIDER_FILTER = "@favorites";
// Servers that predate `migrateModelPreferences` drop it and keep reporting null favorites.
const attemptedMigrationGenerations = new Map<EnvironmentId, number>();
function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const content = (
    <>
      <ProviderIcon iconUrl={props.iconUrl} provider={props.driver} size={15} />
      <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
      {props.collapsible ? (
        <>
          <View className="flex-1" />
          {props.collapsed ? (
            <Text className="text-2xs font-t3-medium text-foreground-muted">
              {props.modelCount}
            </Text>
          ) : null}
          <SymbolView
            name={props.collapsed ? "chevron.down" : "chevron.up"}
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </>
      ) : null}
    </>
  );

  if (props.collapsible) {
    return (
      <Pressable
        accessibilityLabel={`${props.label}, ${props.modelCount} models`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        className="mx-4 mt-1 min-h-11 flex-row items-center gap-2 rounded-xl px-1 pt-2 active:opacity-60 android:min-h-12"
        onPress={props.onToggle}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View accessibilityRole="header" className="mx-4 min-h-9 flex-row items-center gap-2 px-1 pt-1">
      {content}
    </View>
  );
}

function DisclosureRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onPress: () => void;
  readonly isLast?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className={cn(
        "min-h-11 flex-row items-center gap-2 bg-grouped-card px-4 py-2 active:bg-subtle android:min-h-14",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-1" />
      {props.value ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      <SymbolView
        name="chevron.right"
        size={12}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
    </Pressable>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly isLast?: boolean;
}) {
  return (
    <View
      className={cn(
        "min-h-11 flex-row items-center justify-between bg-grouped-card px-4 py-1",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <ThemedSwitch
        accessibilityLabel={props.label}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

type ThreadSettingsSubmenuPage =
  | { readonly kind: "descriptor"; readonly id: string }
  | { readonly kind: "runtime" };

type ThreadSettingsSessionProps = {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly lockedProviderInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly onSelectModel: (option: ModelOption) => void;
  readonly restoreSelection?: (selection: ModelSelection) => ModelSelection;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly onUpdateOptionSelections: (selections: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly runtimeMode: RuntimeMode;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
};

export type ExistingThreadSettingsRouteSession = ThreadSettingsSessionProps & {
  readonly ownerId: string;
};

type ExistingThreadSettingsRouteContextValue = {
  readonly session: ExistingThreadSettingsRouteSession | null;
  readonly present: (session: ExistingThreadSettingsRouteSession) => void;
  readonly clear: (ownerId: string) => void;
};

const ExistingThreadSettingsRouteContext =
  createContext<ExistingThreadSettingsRouteContextValue | null>(null);

export function ExistingThreadSettingsRouteProvider(props: { readonly children: ReactNode }) {
  const [session, setSession] = useState<ExistingThreadSettingsRouteSession | null>(null);
  const present = (nextSession: ExistingThreadSettingsRouteSession) => {
    setSession(nextSession);
  };
  const clear = (ownerId: string) => {
    setSession((current) => (current?.ownerId === ownerId ? null : current));
  };
  const value = { session, present, clear };

  return (
    <ExistingThreadSettingsRouteContext.Provider value={value}>
      {props.children}
    </ExistingThreadSettingsRouteContext.Provider>
  );
}

export function useExistingThreadSettingsRoutePresentation() {
  const value = use(ExistingThreadSettingsRouteContext);
  if (!value) {
    throw new Error(
      "useExistingThreadSettingsRoutePresentation must be used inside ExistingThreadSettingsRouteProvider.",
    );
  }
  return value;
}

type ThreadSettingsSessionValue = {
  readonly catalogView: "providers" | "models";
  readonly setCatalogView: (view: "providers" | "models") => void;
  readonly modelCatalog: ReadonlyArray<ModelOnlyEntry>;
  readonly usageRankingStatus: string;
  readonly refreshUsageRanking: () => void;
  readonly environmentId: EnvironmentId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoritesLoaded: boolean;
  readonly toggleFavorite: (options: ReadonlyArray<ModelOption>) => void;
  readonly toggleHidden: (option: ModelOption) => void;
  readonly pendingHiddenKeys: ReadonlySet<string>;
  readonly manageHidden: boolean;
  readonly setManageHidden: (value: boolean) => void;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModeChoices: ReturnType<typeof runtimeModeChoicesForSupportedModes>;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  readonly displayedDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly promptTraits: ReturnType<typeof getPromptControlledTraits>;
  readonly displayedModelSelection: ModelSelection | null;
  readonly reportedModelSelection: ModelSelection | null;
  readonly providerExpansionOverrides: ReadonlySet<string>;
  readonly hasLegacyModels: boolean;
  readonly pendingModel: ModelOption | null;
  readonly providerFilter: string | null;
  readonly searchQuery: string;
  readonly showLegacy: boolean;
  readonly applyOptionChange: (id: string, value: string | boolean) => void;
  readonly commitPendingModel: () => boolean;
  readonly isApplied: (option: ModelOption) => boolean;
  readonly isDisplayed: (option: ModelOption) => boolean;
  readonly pressModel: (option: ModelOption) => void;
  readonly selectDefaultModel: (option: ModelOption) => void;
  readonly setProviderFilter: (providerKey: string | null) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setShowLegacy: (showLegacy: boolean) => void;
  readonly toggleProvider: (providerKey: string) => void;
};

const ThreadSettingsSessionContext = createContext<ThreadSettingsSessionValue | null>(null);

function ThreadSettingsSessionProvider(
  props: ThreadSettingsSessionProps & { readonly children: ReactNode },
) {
  const registry = use(RegistryContext);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const config = props.environmentId ? configs.get(props.environmentId) : undefined;
  const settings = config?.settings;
  const connection = useEnvironmentQuery(
    props.environmentId ? environmentCatalog.stateAtom(props.environmentId) : null,
  ).data;
  const connectionGeneration = connection?.phase === "connected" ? connection.generation : null;
  const [catalogView, setCatalogViewState] = useState<"providers" | "models">("models");
  const [quotaNow, setQuotaNow] = useState(Date.now);
  const setCatalogView = (view: "providers" | "models") => {
    setQuotaNow(Date.now());
    setCatalogViewState(view);
  };
  useEffect(() => {
    if (catalogView !== "models") return;
    const timer = setInterval(() => setQuotaNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [catalogView]);
  const usageRanking = useModelUsageRanking(props.environmentId ?? null, catalogView === "models");
  const [manageHidden, setManageHidden] = useState(false);
  const pendingHidden = useRef(new Set<string>());
  const pendingFavorites = useRef(
    new Map<string, { favorite: boolean; settings: ServerSettings; pending: boolean }>(),
  );
  const [pendingHiddenKeys, setPendingHiddenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const providerGroups =
    manageHidden && config
      ? groupByProvider(
          buildModelOptions(
            config,
            props.selectedModel,
            props.lockedProviderInstanceId,
            props.projectId,
            true,
          ),
        )
      : props.providerGroups;
  const legacyFavorites = AsyncResult.isSuccess(preferences)
    ? (preferences.value.modelFavorites ?? EMPTY_MODEL_FAVORITES)
    : EMPTY_MODEL_FAVORITES;
  const favoritesLoaded =
    settings !== undefined && (settings.favorites !== null || AsyncResult.isSuccess(preferences));
  const modelFavorites = resolveModelPreferences(settings ?? DEFAULT_SERVER_SETTINGS, {
    favorites: legacyFavorites,
  }).favorites;
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, "model favorites update");
  useEffect(() => {
    if (
      !props.environmentId ||
      !settings ||
      !AsyncResult.isSuccess(preferences) ||
      connectionGeneration === null ||
      attemptedMigrationGenerations.get(props.environmentId) === connectionGeneration
    )
      return;
    const patch = modelPreferencesMigrationPatch(settings, { favorites: legacyFavorites });
    if (!patch) return;
    attemptedMigrationGenerations.set(props.environmentId, connectionGeneration);
    void saveSettings({ environmentId: props.environmentId, input: { patch } });
  }, [
    connectionGeneration,
    legacyFavorites,
    preferences,
    props.environmentId,
    saveSettings,
    settings,
  ]);
  const favoriteKeys = new Set(
    modelFavorites.map((favorite) => modelFavoriteKey(favorite.provider, favorite.model)),
  );
  // The options are one model's accounts: it is a favorite when any is, and the star sets all.
  const toggleFavorite = async (options: ReadonlyArray<ModelOption>) => {
    const environmentId = props.environmentId;
    if (!favoritesLoaded || !environmentId || options.length === 0) return;
    const currentSettings = registry.get(environmentServerConfigsAtom).get(environmentId)?.settings;
    if (!currentSettings) return;
    const favorites = resolveModelPreferences(currentSettings, {
      favorites: legacyFavorites,
    }).favorites;
    const entries = options.map((option) => {
      const key = JSON.stringify([
        environmentId,
        option.selection.instanceId,
        option.selection.model,
      ]);
      const previous = pendingFavorites.current.get(key);
      const previousFavorite =
        previous && (previous.pending || previous.settings.favorites === currentSettings.favorites)
          ? previous.favorite
          : favorites.some(
              (favorite) =>
                favorite.provider === option.selection.instanceId &&
                favorite.model === option.selection.model,
            );
      return { option, key, previous, previousFavorite };
    });
    const favorite = !entries.some((entry) => entry.previousFavorite);
    const pendings = entries.map((entry) => {
      const pending = { favorite, settings: currentSettings, pending: true };
      pendingFavorites.current.set(entry.key, pending);
      return pending;
    });
    void Haptics.selectionAsync();
    const result = await saveSettings({
      environmentId: environmentId,
      input: {
        patch: {
          setModelFavorites: options.map((option) => ({
            provider: option.selection.instanceId,
            model: option.selection.model,
            favorite,
          })),
          ...(currentSettings.favorites === null ? { migrateModelPreferences: { favorites } } : {}),
        },
      },
    });
    const settled =
      AsyncResult.isSuccess(result) &&
      registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
        currentSettings.favorites;
    entries.forEach(({ key, previous }, index) => {
      const pending = pendings[index]!;
      if (settled) pending.pending = false;
      if (pending.pending && pendingFavorites.current.get(key) === pending) {
        if (
          previous &&
          !previous.pending &&
          registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
            previous.settings.favorites
        ) {
          pendingFavorites.current.set(key, previous);
        } else {
          pendingFavorites.current.delete(key);
        }
      }
    });
  };
  const toggleHidden = (option: ModelOption) => {
    if (
      !settings ||
      !props.environmentId ||
      !option.canHide ||
      pendingHidden.current.has(option.key)
    )
      return;
    pendingHidden.current.add(option.key);
    setPendingHiddenKeys(new Set(pendingHidden.current));
    void Haptics.selectionAsync();
    void saveSettings({
      environmentId: props.environmentId,
      input: {
        patch: {
          setModelsHidden: [
            {
              provider: option.selection.instanceId,
              model: option.selection.model,
              hidden: !option.isHidden,
            },
          ],
        },
      },
    }).then(() => {
      pendingHidden.current.delete(option.key);
      setPendingHiddenKeys(new Set(pendingHidden.current));
    });
  };
  const [showLegacyToggle, setShowLegacyToggle] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [providerExpansionOverrides, setProviderExpansionOverrides] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const displayedPrompt = pendingModel ? (pendingPrompt ?? props.prompt) : props.prompt;

  const isApplied = (option: ModelOption) =>
    option.selection.instanceId === props.selectedModel?.instanceId &&
    option.selection.model === props.selectedModel.model;
  const isDisplayed = (option: ModelOption) =>
    pendingModel ? option.key === pendingModel.key : isApplied(option);

  const displayedDescriptors = pendingModel
    ? pendingModel.capabilities
      ? getProviderOptionDescriptors({
          caps: pendingModel.capabilities,
          selections: pendingModel.selection.options,
        })
      : []
    : props.optionDescriptors;
  const promptTraits = getPromptControlledTraits(displayedDescriptors, displayedPrompt);
  const displayedModel =
    pendingModel ??
    props.providerGroups.flatMap((group) => group.models).find((option) => isApplied(option)) ??
    null;
  const runtimeModeChoices = runtimeModeChoicesForSupportedModes(
    displayedModel?.supportedRuntimeModes,
  );
  const compatibleRuntimeMode = compatibleRuntimeModeForChoices(
    props.runtimeMode,
    runtimeModeChoices,
  );

  const hasLegacyModels = props.providerGroups.some((group) =>
    group.models.some((model) => model.isLegacy),
  );
  const automaticModel = (model: ModelOption, preserveOptions: boolean) => {
    const currentConfig = props.environmentId
      ? registry.get(environmentServerConfigsAtom).get(props.environmentId)
      : undefined;
    if (!currentConfig) return null;
    const options = buildModelOptions(
      currentConfig,
      props.selectedModel,
      props.lockedProviderInstanceId,
      props.projectId,
    ).filter(
      (candidate) =>
        comparableModelName(candidate.selection.model) ===
          comparableModelName(model.selection.model) &&
        (providerFilter === null ||
          providerFilter === FAVORITES_PROVIDER_FILTER ||
          candidate.providerKey === providerFilter) &&
        (providerFilter !== FAVORITES_PROVIDER_FILTER || favoriteKeys.has(candidate.key)),
    );
    return selectModelProvider(
      options,
      currentConfig.providers,
      Date.now(),
      preserveOptions ? model.selection.options : undefined,
    );
  };
  const commitPendingModel = () => {
    if (pendingModel) {
      const target = catalogView === "models" ? automaticModel(pendingModel, true) : pendingModel;
      if (!target) {
        Dialog.alert(
          "No quota available",
          "No provider reports fresh, positive session and weekly quota for this model and its selected options. Use Providers to choose an account manually.",
        );
        return false;
      }
      if (!canCommitPendingModel(target, props.providerGroups)) {
        Dialog.alert(
          "Model unavailable",
          "Set up this provider on web or desktop, or select another model.",
        );
        return false;
      }
      void Haptics.selectionAsync();
      props.onSelectModel(target);
      if (pendingPrompt !== null && pendingPrompt !== props.prompt) {
        props.onPromptChange(pendingPrompt);
      }
    }
    return true;
  };

  const applyOptionChange = (id: string, value: string | boolean) => {
    const descriptor = displayedDescriptors.find((entry) => entry.id === id);
    const change =
      descriptor?.type === "select" && typeof value === "string"
        ? getTraitSelectChange(
            { ...promptTraits, descriptors: displayedDescriptors },
            descriptor,
            displayedPrompt,
            value,
          )
        : null;
    if (descriptor?.type === "select") {
      if (!change) return;
      if (change.prompt !== displayedPrompt) {
        if (pendingModel) {
          setPendingPrompt(change.prompt);
        } else {
          props.onPromptChange(change.prompt);
        }
      }
      if (!("modelOptions" in change)) return;
    }
    const next =
      change && "modelOptions" in change
        ? (change.modelOptions ?? [])
        : applyProviderOptionSelection(displayedDescriptors, { id, value });
    if (!next) {
      return;
    }
    if (pendingModel) {
      rememberModelOptions(pendingModel.selection.instanceId, pendingModel.selection.model, next);
      setPendingModel({
        ...pendingModel,
        selection: { ...pendingModel.selection, options: next },
      });
    } else {
      props.onUpdateOptionSelections(next);
    }
  };

  const toggleProvider = (providerKey: string) => {
    setProviderExpansionOverrides((current) => {
      const next = new Set(current);
      if (!next.delete(providerKey)) {
        next.add(providerKey);
      }
      return next;
    });
  };

  const pressModel = (pressed: ModelOption) => {
    const option = catalogView === "models" ? automaticModel(pressed, false) : pressed;
    if (!option) {
      Dialog.alert(
        "No quota available",
        "No provider reports fresh, positive session and weekly quota for this model. Use Providers to choose an account manually.",
      );
      return;
    }
    void Haptics.selectionAsync();
    if (isApplied(option) || option.key !== pendingModel?.key) {
      setPendingPrompt(null);
    }
    setPendingModel((current) =>
      pendingModelAfterPress({
        current,
        pressed: option,
        pressedIsApplied: isApplied(option),
        restoreSelection: props.restoreSelection,
      }),
    );
  };

  const selectDefaultModel = async (pressed: ModelOption) => {
    const option = catalogView === "models" ? automaticModel(pressed, false) : pressed;
    if (!option) {
      Dialog.alert(
        "No quota available",
        "No provider reports fresh, positive session and weekly quota for this model. Use Providers to choose an account manually.",
      );
      return;
    }
    if (!canCommitPendingModel(option, props.providerGroups)) {
      Dialog.alert(
        "Model unavailable",
        "Set up this provider on web or desktop, or select another model.",
      );
      return;
    }

    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (isApplied(option) || option.key !== pendingModel?.key) {
      setPendingPrompt(null);
    }
    setPendingModel(option);
    props.onSelectModel(option);
    setStickyComposerModelSelection(option.selection);

    if (props.environmentId) {
      const currentDefault = config?.settings
        ? resolveProjectSettings(config.settings, props.projectId).settings.defaultModelSelection
        : null;
      const isAlreadyDefault =
        currentDefault !== null &&
        currentDefault.instanceId === option.selection.instanceId &&
        currentDefault.model === option.selection.model;
      const nextDefault = isAlreadyDefault ? null : option.selection;

      await saveSettings({
        environmentId: props.environmentId,
        input: {
          patch: {
            defaultModelSelection: nextDefault,
            ...(props.projectId
              ? {
                  projectSettingsOverrides: {
                    [props.projectId]: {
                      defaultModelSelection: nextDefault,
                    },
                  },
                }
              : {}),
          },
        },
      });
    }
  };

  const modelCatalog =
    catalogView === "models"
      ? favoritesFirstBy(
          buildModelOnlyCatalog(
            providerGroups
              .flatMap((group) => group.models)
              .filter(
                (option) =>
                  (providerFilter === null ||
                    providerFilter === FAVORITES_PROVIDER_FILTER ||
                    option.providerKey === providerFilter) &&
                  (providerFilter !== FAVORITES_PROVIDER_FILTER || favoriteKeys.has(option.key)) &&
                  (manageHidden ||
                    showLegacyToggle ||
                    !option.isLegacy ||
                    isDisplayed(option) ||
                    favoriteKeys.has(option.key)) &&
                  modelMatchesCatalogQuery({
                    model: option,
                    providerLabel: option.providerLabel,
                    query: searchQuery,
                  }),
              ),
            config?.providers ?? [],
            usageRanking.totals,
            quotaNow,
          ),
          (entry) => entry.candidates.some((candidate) => favoriteKeys.has(candidate.key)),
        )
      : [];
  const value = {
    catalogView,
    setCatalogView,
    modelCatalog,
    usageRankingStatus:
      usageRanking.status === "ranked"
        ? "Most used first · reported tokens over 30 days"
        : usageRanking.status === "loading"
          ? "Loading usage…"
          : "Usage unavailable · alphabetical order",
    refreshUsageRanking: usageRanking.refresh,
    environmentId: props.environmentId,
    providerInstanceId: props.providerInstanceId,
    providerGroups,
    manageHidden,
    setManageHidden,
    toggleHidden,
    pendingHiddenKeys,
    runtimeMode: compatibleRuntimeMode,
    runtimeModeChoices,
    onUpdateRuntimeMode: props.onUpdateRuntimeMode,
    displayedDescriptors,
    promptTraits,
    displayedModelSelection: pendingModel?.selection ?? props.selectedModel,
    reportedModelSelection: pendingModel ? null : (props.reportedModelSelection ?? null),
    favoriteKeys,
    favoritesLoaded,
    providerExpansionOverrides,
    hasLegacyModels,
    pendingModel,
    providerFilter,
    searchQuery,
    showLegacy: showLegacyToggle,
    applyOptionChange,
    commitPendingModel,
    isApplied,
    isDisplayed,
    pressModel,
    selectDefaultModel,
    setProviderFilter,
    setSearchQuery,
    setShowLegacy: setShowLegacyToggle,
    toggleProvider,
    toggleFavorite,
  } satisfies ThreadSettingsSessionValue;

  return (
    <ThreadSettingsSessionContext.Provider value={value}>
      {props.children}
    </ThreadSettingsSessionContext.Provider>
  );
}

function useThreadSettingsSession() {
  const value = use(ThreadSettingsSessionContext);
  if (!value) {
    throw new Error("useThreadSettingsSession must be used inside ThreadSettingsSessionProvider.");
  }
  return value;
}

type ThreadSettingsProviderCatalog = {
  readonly key: string;
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly models: ReadonlyArray<ModelOption>;
};

type ThreadSettingsCatalogItem =
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly provider: ThreadSettingsProviderCatalog;
    }
  | {
      readonly kind: "model";
      readonly automatic?: boolean;
      readonly tokens?: number;
      readonly resetAndWeeklyLabel?: string | null;
      readonly key: string;
      readonly option: ModelOption;
      readonly candidateQuotas?: ReadonlyArray<ModelCandidateQuota>;
      readonly candidates?: ReadonlyArray<ModelOption>;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly text: string;
    }
  | {
      readonly kind: "empty";
      readonly key: "empty";
    }
  | {
      readonly kind: "options";
      readonly key: "options";
    };

function ThreadSettingsModelListRow(props: {
  readonly automatic?: boolean;
  readonly tokens?: number;
  readonly resetAndWeeklyLabel?: string | null;
  readonly option: ModelOption;
  readonly candidateQuotas?: ReadonlyArray<ModelCandidateQuota>;
  readonly candidates?: ReadonlyArray<ModelOption>;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const session = useThreadSettingsSession();
  const onPress = () => session.pressModel(props.option);
  const onLongPress = () => session.selectDefaultModel(props.option);
  if (props.automatic) {
    const selected = session.displayedModelSelection?.model === props.option.selection.model;
    const candidates = props.candidateQuotas ?? [];
    const favoriteOptions = props.candidates ?? [props.option];
    const isFavorite = favoriteOptions.some((option) => session.favoriteKeys.has(option.key));
    const isDefault =
      props.option.isDefault || (props.candidates?.some((cand) => cand.isDefault) ?? false);
    const detail = props.option.isUnavailable
      ? "No provider with usable session and weekly quota"
      : `${props.option.providerLabel} · ${props.option.quotaSummary?.label ?? "Quota unavailable"}`;
    const accessibilityLabel = [
      props.option.label,
      isDefault ? "Default" : null,
      detail,
      props.resetAndWeeklyLabel,
    ]
      .filter(Boolean)
      .join(", ");
    return (
      <Pressable
        accessibilityRole="radio"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint="Double-tap to choose this model. Double-tap and hold to set as default for new chats."
        accessibilityState={{ checked: selected, disabled: props.option.isUnavailable }}
        disabled={props.option.isUnavailable}
        onPress={onPress}
        onLongPress={onLongPress}
        className={cn(
          "mx-4 min-h-16 flex-row items-center gap-3 bg-grouped-card px-4 py-3 active:opacity-70",
          props.isFirst && "rounded-t-2xl",
          props.isLast ? "rounded-b-2xl" : "border-b border-border-subtle",
        )}
      >
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text className="text-base font-t3-medium text-foreground" numberOfLines={2}>
              {props.option.label}
            </Text>
            {isDefault ? (
              <View className="rounded-md bg-primary/15 px-1.5 py-0.5">
                <Text className="text-2xs font-t3-medium text-primary">Default</Text>
              </View>
            ) : null}
          </View>
          {candidates.length > 0 ? (
            <View className="mt-0.5 h-1.5 w-full flex-row gap-1">
              {candidates.map((cand) => {
                const fillPercent =
                  cand.remainingPercent !== null
                    ? Math.max(0, Math.min(100, cand.remainingPercent))
                    : 0;
                const isExhausted =
                  cand.isExhausted ||
                  (cand.remainingPercent !== null && cand.remainingPercent <= 0);
                return (
                  <View
                    key={cand.option.key}
                    className="h-full flex-1 overflow-hidden rounded-full bg-subtle-strong"
                  >
                    <View
                      style={{ width: `${fillPercent}%` }}
                      className={cn(
                        "h-full rounded-full",
                        cand.isWinner
                          ? "bg-primary"
                          : isExhausted
                            ? "bg-red-500"
                            : "bg-foreground-muted/60",
                      )}
                    />
                  </View>
                );
              })}
            </View>
          ) : null}
          {candidates.length > 1 ? (
            <View className="mt-1 flex-row flex-wrap items-center gap-1.5">
              {candidates.map((cand) => {
                const fillPercent = cand.remainingPercent;
                const isExhausted = cand.isExhausted || (fillPercent !== null && fillPercent <= 0);
                return (
                  <View
                    key={cand.option.key}
                    className={cn(
                      "flex-row items-center gap-1 rounded-md px-1.5 py-0.5",
                      cand.isWinner ? "bg-primary/15" : "bg-subtle-strong",
                    )}
                  >
                    <View
                      className={cn(
                        "size-1.5 rounded-full",
                        cand.isWinner
                          ? "bg-primary"
                          : isExhausted
                            ? "bg-red-500"
                            : "bg-foreground-muted",
                      )}
                    />
                    <Text
                      className={cn(
                        "text-2xs",
                        cand.isWinner ? "font-t3-medium text-primary" : "text-foreground-muted",
                      )}
                    >
                      {cand.shortLabel}
                      {fillPercent !== null ? ` · ${fillPercent}%` : ""}
                      {cand.isWinner ? " (Auto)" : ""}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : (
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {detail}
            </Text>
          )}
          {props.resetAndWeeklyLabel ? (
            <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
              {props.resetAndWeeklyLabel}
            </Text>
          ) : null}
        </View>
        {selected ? (
          <SymbolView name="checkmark" size={18} tintColorClassName="accent-icon" />
        ) : null}
        <Pressable
          accessibilityLabel={`${isFavorite ? "Remove from" : "Add to"} favorites: ${props.option.label}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: !session.favoritesLoaded, selected: isFavorite }}
          className="-mr-2 min-h-11 min-w-11 items-center justify-center"
          disabled={!session.favoritesLoaded}
          onPress={() => session.toggleFavorite(favoriteOptions)}
        >
          <SymbolView
            name={isFavorite ? "star.fill" : "star"}
            size={18}
            tintColorClassName={isFavorite ? "accent-icon" : "accent-icon-subtle"}
            type="monochrome"
          />
        </Pressable>
      </Pressable>
    );
  }

  return (
    <ModelRow
      isFirst={props.isFirst}
      isLast={props.isLast}
      onPress={onPress}
      onLongPress={onLongPress}
      isFavorite={session.favoriteKeys.has(props.option.key)}
      favoritesLoaded={session.favoritesLoaded}
      onToggleFavorite={() => session.toggleFavorite([props.option])}
      onToggleHidden={
        session.manageHidden && props.option.canHide
          ? () => session.toggleHidden(props.option)
          : undefined
      }
      hiddenUpdatePending={session.pendingHiddenKeys.has(props.option.key)}
      option={props.option}
      selected={session.isDisplayed(props.option)}
    />
  );
}

function ThreadSettingsProviderListHeader(props: {
  readonly provider: ThreadSettingsProviderCatalog;
}) {
  const session = useThreadSettingsSession();
  const onToggle = () => session.toggleProvider(props.provider.key);

  return (
    <ProviderHeader
      collapsible={props.provider.collapsible}
      collapsed={props.provider.collapsed}
      driver={props.provider.driver}
      iconUrl={props.provider.iconUrl}
      label={props.provider.label}
      modelCount={props.provider.modelCount}
      onToggle={onToggle}
    />
  );
}

function buildThreadSettingsCatalogItems(
  session: ThreadSettingsSessionValue,
): ReadonlyArray<ThreadSettingsCatalogItem> {
  if (session.catalogView === "models") {
    return session.modelCatalog.flatMap((entry, index) => {
      const option = entry.option ?? entry.candidates[0];
      if (!option) return [];
      return [
        {
          kind: "model" as const,
          key: `model-only:${entry.modelId}`,
          automatic: true,
          tokens: entry.tokens,
          resetAndWeeklyLabel: entry.resetAndWeeklyLabel,
          option: entry.option ?? { ...option, isUnavailable: true },
          candidateQuotas: entry.candidateQuotas,
          candidates: entry.candidates,
          isFirst: index === 0,
          isLast: index === session.modelCatalog.length - 1,
        },
      ];
    });
  }
  return session.providerGroups.flatMap((group) => {
    if (
      session.providerFilter !== null &&
      session.providerFilter !== FAVORITES_PROVIDER_FILTER &&
      group.providerKey !== session.providerFilter
    ) {
      return [];
    }
    const driver = group.models[0]?.providerDriver ?? group.providerKey;
    const catalogModels =
      session.manageHidden ||
      session.showLegacy ||
      session.providerFilter === FAVORITES_PROVIDER_FILTER
        ? group.models
        : group.models.filter(
            (model) =>
              !model.isLegacy || session.isDisplayed(model) || session.favoriteKeys.has(model.key),
          );
    const visibleModels = favoritesFirst(
      catalogModels.filter(
        (model) =>
          (session.providerFilter !== FAVORITES_PROVIDER_FILTER ||
            session.favoriteKeys.has(model.key)) &&
          modelMatchesCatalogQuery({
            model,
            providerLabel: group.providerLabel,
            query: session.searchQuery,
          }),
      ),
      session.favoriteKeys,
    );
    const updateRequiredNotice =
      group.updateRequired && session.providerFilter !== FAVORITES_PROVIDER_FILTER
        ? formatProviderUpdateRequiredNotice(group.updateRequired, session.searchQuery)
        : null;
    if (visibleModels.length === 0 && !updateRequiredNotice) {
      return [];
    }
    const isPrimary = driver !== undefined && PRIMARY_PROVIDER_DRIVERS.has(driver);
    const containsAppliedSelection = group.models.some(session.isApplied);
    const isNarrowed = session.providerFilter !== null || session.searchQuery.trim().length > 0;
    const collapsible = !isNarrowed;
    const collapsed = providerSectionIsCollapsed({
      defaultExpanded: isPrimary || containsAppliedSelection,
      hasExpansionOverride: session.providerExpansionOverrides.has(group.providerKey),
      isNarrowed,
    });
    const provider: ThreadSettingsProviderCatalog = {
      key: group.providerKey,
      driver,
      iconUrl: group.models[0]?.providerIconUrl,
      label: group.providerLabel,
      collapsible,
      collapsed,
      modelCount: visibleModels.length,
      models: collapsed ? [] : visibleModels,
    };
    return [
      {
        kind: "provider" as const,
        key: `provider:${group.providerKey}`,
        provider,
      },
      ...provider.models.map((option, index) => ({
        kind: "model" as const,
        key: `model:${option.key}`,
        option,
        isFirst: index === 0,
        isLast: index === provider.models.length - 1,
      })),
      ...(!collapsed && updateRequiredNotice
        ? [
            {
              kind: "notice" as const,
              key: `notice:${group.providerKey}`,
              text: updateRequiredNotice,
            },
          ]
        : []),
    ];
  });
}

function ThreadSettingsReasoningSlider() {
  const session = useThreadSettingsSession();
  const descriptor = session.displayedDescriptors.find(
    (entry) =>
      entry.type === "select" && /reason|effort|thinking/i.test(`${entry.id} ${entry.label}`),
  );
  if (descriptor?.type !== "select" || descriptor.options.length < 2) return null;
  const current = getProviderOptionCurrentValue(
    descriptor,
    session.displayedModelSelection,
    session.reportedModelSelection,
  );
  let index = 0;
  for (let i = 0; i < descriptor.options.length; i++) {
    if (descriptor.options[i]!.id === current) {
      index = i;
      break;
    }
  }
  return (
    <View className="mx-4 mt-3 rounded-2xl bg-grouped-card">
      <SliderRow
        icon="brain"
        label={descriptor.label}
        valueLabel={descriptor.options[index]!.label}
        min={0}
        max={descriptor.options.length - 1}
        step={1}
        value={index}
        onChange={(value) => {
          const option = descriptor.options[Math.round(value)];
          if (option) session.applyOptionChange(descriptor.id, option.id);
        }}
      />
    </View>
  );
}

function ThreadSettingsOptionsItem(props: {
  readonly animationsReady: boolean;
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const selectedProvider = session.environmentId
    ? (configs
        .get(session.environmentId)
        ?.providers.find((provider) => provider.instanceId === session.providerInstanceId) ?? null)
    : null;
  // Both iOS search layouts float a bottom toolbar over the list's last rows.
  const bottomToolbarInset = Platform.OS === "ios" ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET : 0;

  return (
    <View style={{ paddingBottom: insets.bottom + bottomToolbarInset + 12 }}>
      <ChatGptSharingStatus provider={selectedProvider} />
      <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">Options</Text>
      <Animated.View
        className="mx-4 overflow-hidden rounded-2xl bg-grouped-card"
        layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
      >
        {session.displayedDescriptors.map((descriptor) => {
          if (
            descriptor.type === "select" &&
            descriptor.options.length > 1 &&
            /reason|effort|thinking/i.test(`${descriptor.id} ${descriptor.label}`)
          )
            return null;
          if (descriptor.type === "select") {
            return (
              <Animated.View
                key={descriptor.id}
                entering={
                  props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined
                }
                exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
                layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
              >
                <DisclosureRow
                  label={descriptor.label}
                  value={
                    session.promptTraits.ultrathinkPromptControlled &&
                    descriptor.id === session.promptTraits.primarySelectDescriptor?.id
                      ? "Ultrathink"
                      : getProviderOptionCurrentLabel(
                          descriptor,
                          session.displayedModelSelection,
                          session.reportedModelSelection,
                        )
                  }
                  onPress={() => props.onOpenSubmenu({ kind: "descriptor", id: descriptor.id })}
                />
              </Animated.View>
            );
          }
          return (
            <Animated.View
              key={descriptor.id}
              entering={props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined}
              exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
              layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
            >
              <SwitchRow
                label={descriptor.label}
                value={descriptor.currentValue ?? false}
                onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}
              />
            </Animated.View>
          );
        })}
        <Animated.View layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}>
          <DisclosureRow
            isLast
            label="Runtime"
            value={
              session.runtimeModeChoices.find((choice) => choice.mode === session.runtimeMode)
                ?.label
            }
            onPress={() => props.onOpenSubmenu({ kind: "runtime" })}
          />
        </Animated.View>
      </Animated.View>

      <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">Catalog</Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
        <SwitchRow
          label="Manage hidden models"
          value={session.manageHidden}
          onValueChange={(manageHidden) => {
            session.setManageHidden(manageHidden);
            if (manageHidden) session.setCatalogView("providers");
          }}
          isLast={Platform.OS === "ios" || !session.hasLegacyModels}
        />
        {Platform.OS !== "ios" && session.hasLegacyModels ? (
          <SwitchRow
            isLast
            label="Legacy models"
            onValueChange={session.setShowLegacy}
            value={session.showLegacy}
          />
        ) : null}
      </View>
    </View>
  );
}

function ThreadSettingsMainContent(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const session = useThreadSettingsSession();
  const refreshProvidersCommand = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  useEffect(() => {
    const environmentId = session.environmentId;
    if (!environmentId) return;
    void refreshUsageLimits(
      environmentId,
      () => refreshProvidersCommand({ environmentId, input: {} }),
      true,
    ).catch(() => undefined);
  }, [session.environmentId, refreshProvidersCommand]);
  const refreshProviderCatalog = createProviderCatalogRefreshRunner(refreshProvidersCommand);
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshProviders = () => {
    if (!session.environmentId || isRefreshingProviders) return;
    setIsRefreshingProviders(true);
    if (session.catalogView === "models") session.refreshUsageRanking();
    void refreshProviderCatalog(session.environmentId).then((result) => {
      setIsRefreshingProviders(false);
      const error = providerCatalogRefreshError(result);
      if (error) Dialog.alert("Could not refresh models", error);
    });
  };
  const [animationsReady, setAnimationsReady] = useState(false);
  const catalogItems = buildThreadSettingsCatalogItems(session);
  const hasActiveCatalogFilter =
    session.providerFilter !== null || session.searchQuery.trim().length > 0;
  const listItems = [
    ...(catalogItems.length === 0 ? ([{ kind: "empty", key: "empty" }] as const) : catalogItems),
    { kind: "options", key: "options" },
  ] satisfies ReadonlyArray<ThreadSettingsCatalogItem>;
  const renderCatalogItem = (itemProps: LegendListRenderItemProps<ThreadSettingsCatalogItem>) => {
    const item = itemProps.item;
    let content: ReactNode;

    if (item.kind === "provider") {
      content = <ThreadSettingsProviderListHeader provider={item.provider} />;
    } else if (item.kind === "model") {
      content = (
        <ThreadSettingsModelListRow
          automatic={item.automatic}
          tokens={item.tokens}
          resetAndWeeklyLabel={item.resetAndWeeklyLabel}
          candidateQuotas={item.candidateQuotas}
          candidates={item.candidates}
          isFirst={item.isFirst}
          isLast={item.isLast}
          option={item.option}
        />
      );
    } else if (item.kind === "notice") {
      content = <Text className="mx-8 mt-2 text-xs text-foreground-muted">{item.text}</Text>;
    } else if (item.kind === "empty") {
      content = (
        <View className="items-center px-8 py-14">
          <Text className="text-center text-sm text-foreground-muted">
            {session.providerFilter === FAVORITES_PROVIDER_FILTER &&
            session.searchQuery.trim().length === 0
              ? "No favorite models"
              : hasActiveCatalogFilter
                ? "No matching models"
                : "No available models"}
          </Text>
        </View>
      );
    } else {
      content = (
        <ThreadSettingsOptionsItem
          animationsReady={animationsReady}
          onOpenSubmenu={props.onOpenSubmenu}
        />
      );
    }

    return (
      <Animated.View
        key={item.key}
        entering={animationsReady ? THREAD_SETTINGS_CATALOG_ENTER_TRANSITION : undefined}
        exiting={animationsReady ? THREAD_SETTINGS_CATALOG_EXIT_TRANSITION : undefined}
      >
        {content}
      </Animated.View>
    );
  };

  return (
    <AnimatedLegendList
      alwaysBounceVertical
      automaticallyAdjustsScrollIndicatorInsets
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{ paddingTop: 4 }}
      contentInsetAdjustmentBehavior="automatic"
      data={listItems}
      estimatedItemSize={64}
      extraData={animationsReady}
      getItemType={(item) => item.kind}
      itemLayoutAnimation={THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION}
      keyExtractor={(item) => item.key}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      maintainVisibleContentPosition={THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION}
      ListHeaderComponent={
        <>
          <ThreadSettingsReasoningSlider />
          <View className="px-4 pb-3 pt-3 gap-2">
            <SegmentedControl
              options={[
                { value: "providers", label: "Providers" },
                { value: "models", label: "Models" },
              ]}
              selected={session.catalogView}
              onSelect={session.setCatalogView}
            />
            {session.catalogView === "models" ? (
              <Text className="px-2 text-xs text-foreground-muted">
                {session.usageRankingStatus}
                {"\n"}Auto-selects available quota; OpenCode is used last.
              </Text>
            ) : null}
          </View>
          {Platform.OS === "android" ? (
            <View className="px-4 pb-2 pt-3">
              <View
                className="flex-row items-center rounded-full bg-input px-2"
                style={{ minHeight: 56 }}
              >
                <View pointerEvents="none" className="px-2">
                  <SymbolView
                    name="magnifyingglass"
                    size={24}
                    tintColorClassName="accent-icon-subtle"
                  />
                </View>
                <TextInput
                  accessibilityLabel="Find a model"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="min-w-0 flex-1 px-2 py-0 text-base text-foreground"
                  style={{ minHeight: 56, includeFontPadding: false, textAlignVertical: "center" }}
                  onChangeText={session.setSearchQuery}
                  placeholder="Find a model"
                  placeholderTextColorClassName="accent-placeholder"
                  selectionColorClassName="accent-focus/32"
                  cursorColorClassName="accent-focus"
                  selectionHandleColorClassName="accent-focus"
                  value={session.searchQuery}
                />
                {session.searchQuery.length > 0 ? (
                  <IconButton
                    accessibilityLabel="Clear model search"
                    icon="xmark"
                    onPress={() => session.setSearchQuery("")}
                  />
                ) : null}
              </View>
            </View>
          ) : null}
        </>
      }
      recycleItems
      refreshControl={
        session.environmentId ? (
          <RefreshControl refreshing={isRefreshingProviders} onRefresh={refreshProviders} />
        ) : undefined
      }
      onLoad={() => setAnimationsReady(true)}
      renderItem={renderCatalogItem}
      showsVerticalScrollIndicator={false}
    />
  );
}

function ThreadSettingsChoiceContent(props: {
  readonly submenu: ThreadSettingsSubmenuPage;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const descriptorId = props.submenu.kind === "descriptor" ? props.submenu.id : null;

  const activeDescriptor =
    descriptorId !== null
      ? session.displayedDescriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === descriptorId,
        )
      : undefined;

  const submenuContent =
    props.submenu.kind === "runtime"
      ? {
          rows: session.runtimeModeChoices.map((choice) => ({
            id: choice.mode,
            label: choice.label,
            description: choice.description,
            selected: choice.mode === session.runtimeMode,
            onPress: () => {
              void Haptics.selectionAsync();
              session.onUpdateRuntimeMode(choice.mode);
              props.onSelected();
            },
          })),
        }
      : activeDescriptor?.type === "select"
        ? {
            rows: selectableChoices(activeDescriptor).map((choice) => ({
              id: choice.id,
              label: choice.label,
              description: choice.description,
              selected:
                choice.id ===
                (session.promptTraits.ultrathinkPromptControlled &&
                activeDescriptor.id === session.promptTraits.primarySelectDescriptor?.id
                  ? "ultrathink"
                  : getProviderOptionCurrentValue(
                      activeDescriptor,
                      session.displayedModelSelection,
                      session.reportedModelSelection,
                    )),
              onPress: () => {
                void Haptics.selectionAsync();
                if (
                  session.promptTraits.ultrathinkInBodyText &&
                  activeDescriptor.id === session.promptTraits.primarySelectDescriptor?.id
                ) {
                  Dialog.alert(
                    "Reasoning controlled by prompt",
                    'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
                  );
                  return;
                }
                session.applyOptionChange(activeDescriptor.id, choice.id);
                props.onSelected();
              },
            })),
          }
        : null;

  if (!submenuContent) {
    return <View className="flex-1 bg-sheet" />;
  }

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{
        paddingBottom: insets.bottom + 12,
        paddingHorizontal: 16,
        paddingTop: 16,
      }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {submenuContent.rows.map((row, index) => (
          <ChoiceRow
            key={row.id}
            description={row.description}
            isLast={index === submenuContent.rows.length - 1}
            label={row.label}
            selected={row.selected}
            onPress={row.onPress}
          />
        ))}
      </View>
    </ScrollView>
  );
}

type ThreadSettingsPickerStackParams = {
  ThreadSettingsModels: undefined;
  ThreadSettingsChoice: ThreadSettingsSubmenuPage & { readonly title: string };
};

type ThreadSettingsPickerPresentation = {
  readonly onClose: () => void;
};

const ThreadSettingsPickerStack = createNativeStackNavigator<ThreadSettingsPickerStackParams>();
const ThreadSettingsPickerPresentationContext =
  createContext<ThreadSettingsPickerPresentation | null>(null);

function useThreadSettingsPickerPresentation() {
  const value = use(ThreadSettingsPickerPresentationContext);
  if (!value) {
    throw new Error(
      "useThreadSettingsPickerPresentation must be used inside ThreadSettingsPickerNavigator.",
    );
  }
  return value;
}

// With a Duo vertical bar, filter and search join cancel and confirm in the rail.
function useThreadSettingsMailSearchToolbar() {
  const metrics = useNativeLayoutMetrics();
  return useNativeMailSearchToolbar() && (metrics?.verticalBarEdge ?? "none") === "none";
}

function ThreadSettingsModelsScreen() {
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const usesNativeMailSearchToolbar = useThreadSettingsMailSearchToolbar();
  const hasCustomCatalogFilter = session.providerFilter !== null || session.showLegacy;
  const commitAndClose = useEffectEvent(() => {
    if (!session.commitPendingModel()) return;
    presentation.onClose();
  });
  const providerFilters = [
    { id: "all-providers", title: "All providers", value: null },
    { id: "favorites", title: "Favorites", value: FAVORITES_PROVIDER_FILTER },
    ...session.providerGroups.map((group) => ({
      id: `provider:${group.providerKey}`,
      title: group.providerLabel,
      value: group.providerKey,
    })),
  ];
  const filterMenu = {
    title: "Model filters",
    items: [
      {
        type: "submenu" as const,
        title: "Provider",
        items: providerFilters.map((filter) => ({
          type: "action" as const,
          title: filter.title,
          state: session.providerFilter === filter.value ? ("on" as const) : ("off" as const),
          onPress: () => session.setProviderFilter(filter.value),
        })),
      },
      ...(session.hasLegacyModels
        ? [
            {
              type: "action" as const,
              title: "Show legacy models",
              state: session.showLegacy ? ("on" as const) : ("off" as const),
              onPress: () => session.setShowLegacy(!session.showLegacy),
            },
          ]
        : []),
    ],
  };

  return (
    <>
      {Platform.OS === "android" ? (
        <SheetHeader
          trailing={
            <View className="flex-row items-center">
              <AndroidAnchoredMenu
                title="Model filters"
                actions={[
                  {
                    title: "Provider",
                    subactions: providerFilters.map((filter) => ({
                      id: filter.id,
                      title: filter.title,
                      state: session.providerFilter === filter.value ? "on" : "off",
                    })),
                  },
                  ...(session.hasLegacyModels
                    ? [
                        {
                          id: "show-legacy",
                          title: "Show legacy models",
                          state: session.showLegacy ? ("on" as const) : ("off" as const),
                        },
                      ]
                    : []),
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "show-legacy") {
                    session.setShowLegacy(!session.showLegacy);
                  } else {
                    const filter = providerFilters.find((item) => item.id === nativeEvent.event);
                    if (filter) session.setProviderFilter(filter.value);
                  }
                }}
              >
                {(open) => (
                  <IconButton
                    accessibilityLabel="Filter models"
                    icon="line.3.horizontal.decrease"
                    selected={hasCustomCatalogFilter}
                    variant={hasCustomCatalogFilter ? "tonal" : "standard"}
                    onPress={open}
                  />
                )}
              </AndroidAnchoredMenu>
            </View>
          }
          onCancel={presentation.onClose}
          title="Thread settings"
          confirm={session.pendingModel ? { label: "Save", onPress: commitAndClose } : undefined}
        />
      ) : null}
      <NativeStackScreenOptions
        optionsVersion={[
          session.providerFilter,
          session.providerGroups.map((group) => group.providerKey),
          session.showLegacy,
        ]}
        options={{
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  filterButtonId: "thread-settings-model-filter",
                  filterMenu,
                  filterSystemImageName: hasCustomCatalogFilter
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onSearchTextChange: session.setSearchQuery,
                  placeholder: "Find a model",
                  searchTextChangeId: "thread-settings-model-search-text",
                  showsSearchDismissButton: true,
                }),
              ]
            : undefined,
          headerShown: Platform.OS !== "android",
          headerSearchBarOptions:
            Platform.OS === "ios" && !usesNativeMailSearchToolbar
              ? {
                  allowToolbarIntegration: true,
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  obscureBackground: false,
                  onCancelButtonPress: () => session.setSearchQuery(""),
                  onChangeText: (event) => session.setSearchQuery(event.nativeEvent.text),
                  placeholder: "Find a model",
                }
              : undefined,
        }}
      />
      <ScreenContent>
        <ThreadSettingsMainContent
          onOpenSubmenu={(submenu) => {
            const title =
              submenu.kind === "runtime"
                ? "Runtime"
                : (session.displayedDescriptors.find(
                    (descriptor) => descriptor.type === "select" && descriptor.id === submenu.id,
                  )?.label ?? "Option");
            navigation.navigate("ThreadSettingsChoice", { ...submenu, title });
          }}
        />
      </ScreenContent>
      {Platform.OS === "ios" ? (
        <SheetHeader
          title="Thread settings"
          onCancel={presentation.onClose}
          accessibilityLabel="Cancel thread settings"
          confirm={{
            label: session.pendingModel ? "Save thread settings" : "Done",
            onPress: commitAndClose,
          }}
        />
      ) : null}
      {Platform.OS === "ios" && !usesNativeMailSearchToolbar ? (
        <Toolbar placement="bottom">
          <Toolbar.Menu
            accessibilityLabel="Filter models"
            icon={
              hasCustomCatalogFilter
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Model filters"
          >
            <Toolbar.Menu title="Provider">
              <Toolbar.Label>Provider</Toolbar.Label>
              <Toolbar.MenuAction
                isOn={session.providerFilter === null}
                onPress={() => session.setProviderFilter(null)}
              >
                All providers
              </Toolbar.MenuAction>
              <Toolbar.MenuAction
                isOn={session.providerFilter === FAVORITES_PROVIDER_FILTER}
                onPress={() => session.setProviderFilter(FAVORITES_PROVIDER_FILTER)}
              >
                Favorites
              </Toolbar.MenuAction>
              {session.providerGroups.map((group) => (
                <Toolbar.MenuAction
                  key={group.providerKey}
                  isOn={session.providerFilter === group.providerKey}
                  onPress={() => session.setProviderFilter(group.providerKey)}
                >
                  {group.providerLabel}
                </Toolbar.MenuAction>
              ))}
            </Toolbar.Menu>
            {session.hasLegacyModels ? (
              <Toolbar.MenuAction
                isOn={session.showLegacy}
                onPress={() => session.setShowLegacy(!session.showLegacy)}
              >
                Show legacy models
              </Toolbar.MenuAction>
            ) : null}
          </Toolbar.Menu>
          <Toolbar.SearchBarSlot />
        </Toolbar>
      ) : null}
    </>
  );
}

function ThreadSettingsChoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const route = useRoute<RouteProp<ThreadSettingsPickerStackParams, "ThreadSettingsChoice">>();

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android" }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={route.params.title}
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <ScreenContent>
        <ThreadSettingsChoiceContent
          submenu={route.params}
          onSelected={() => navigation.goBack()}
        />
      </ScreenContent>
    </>
  );
}

function ThreadSettingsPickerNavigator(props: ThreadSettingsPickerPresentation) {
  const theme = useUniwindTheme();
  const solidSheetBackground = theme["--color-sheet-solid"];
  const foreground = theme["--color-foreground"];
  const presentation = {
    onClose: props.onClose,
  };

  return (
    <ThreadSettingsPickerPresentationContext.Provider value={presentation}>
      <ThreadSettingsPickerStack.Navigator
        initialRouteName="ThreadSettingsModels"
        screenOptions={{
          animation: Platform.OS === "android" ? "default" : "slide_from_right",
          contentStyle: { backgroundColor: solidSheetBackground },
          gestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          headerShown: Platform.OS !== "android",
          headerShadowVisible: false,
          headerStyle: {
            backgroundColor: NATIVE_LIQUID_GLASS_SUPPORTED ? "transparent" : solidSheetBackground,
          },
          headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
          headerTintColor: foreground,
          headerTitleStyle: { fontSize: 17, fontWeight: "700" },
          scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED
            ? THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS
            : undefined,
        }}
      >
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsModels"
          component={ThreadSettingsModelsScreen}
          options={{ headerBackVisible: false, title: "Thread settings" }}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsChoice"
          component={ThreadSettingsChoiceScreen}
          options={({ route }) => ({ title: route.params.title })}
        />
      </ThreadSettingsPickerStack.Navigator>
    </ThreadSettingsPickerPresentationContext.Provider>
  );
}

export function ThreadSettingsPickerScreen(
  props: ThreadSettingsSessionProps & { readonly onClose: () => void },
) {
  return (
    <ThreadSettingsSessionProvider {...props}>
      <ThreadSettingsPickerNavigator onClose={props.onClose} />
    </ThreadSettingsSessionProvider>
  );
}

export function ExistingThreadSettingsRouteScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const presentation = useExistingThreadSettingsRoutePresentation();
  const session = presentation.session;

  useEffect(() => {
    if (session) {
      return;
    }

    navigation.goBack();
  }, [navigation, session]);

  if (!session) {
    return <View className="flex-1 bg-sheet" />;
  }

  const { ownerId: _ownerId, ...settings } = session;

  return <ThreadSettingsPickerScreen {...settings} onClose={() => navigation.goBack()} />;
}

/**
 * Keeping the sheet presentation in RNS gives UIKit ownership of nested dismissal, while
 * Reasoning and Runtime remain regular pushes inside this navigator.
 */
export function NewTaskThreadSettingsRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const optionDescriptors = resolveProviderOptionDescriptors({
    capabilities: flow.selectedModelOption?.capabilities,
    selections: flow.selectedModel?.options,
  });

  return (
    <ThreadSettingsPickerScreen
      environmentId={flow.selectedEnvironmentId}
      projectId={flow.selectedProject?.id ?? null}
      {...(flow.selectedModel ? { providerInstanceId: flow.selectedModel.instanceId } : {})}
      providerGroups={flow.providerGroups}
      selectedModel={flow.selectedModel}
      prompt={flow.prompt}
      onPromptChange={flow.setPrompt}
      onSelectModel={(option) => flow.setSelectedModelKey(option.key, option.selection.options)}
      restoreSelection={withRememberedModelOptions}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={flow.setSelectedModelOptions}
      runtimeMode={flow.runtimeMode}
      onUpdateRuntimeMode={flow.setRuntimeMode}
      onClose={() => navigation.goBack()}
    />
  );
}
