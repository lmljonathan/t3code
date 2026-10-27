import { View } from "react-native";
import type { ModelSelection, ProviderDriverKind } from "@t3tools/contracts";
import {
  buildTraitsTriggerDisplay,
  getPromptControlledTraits,
} from "@t3tools/client-runtime/model-traits";
import type { ModelOption } from "../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../lib/providerOptions";
import { AppText as Text } from "./ui/AppText";
import { ComposerInlineControl } from "./ComposerToolbar";
import { ProviderIcon, ProviderInstanceIcon } from "./ProviderIcon";

export function ComposerModelControl(props: {
  readonly modelOption: ModelOption | null;
  readonly selection: ModelSelection | null;
  readonly provider: ProviderDriverKind | undefined;
  readonly reportedSelection?: ModelSelection | null | undefined;
  readonly prompt: string;
  readonly surfaceColor: string;
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly iconOnly?: boolean;
  readonly quotaResetLabel?: string | null;
  readonly fallbackLabel?: string | null;
  readonly onPress: () => void;
}) {
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: props.modelOption?.capabilities,
    selections: props.selection?.options,
  });
  const promptTraits = getPromptControlledTraits(descriptors, props.prompt);
  const summary = props.provider
    ? buildTraitsTriggerDisplay({
        provider: props.provider,
        descriptors,
        primarySelectDescriptorId: promptTraits.primarySelectDescriptor?.id ?? null,
        ultrathinkPromptControlled: promptTraits.ultrathinkPromptControlled,
        modelSelection: props.selection,
        reportedModelSelection: props.reportedSelection,
      }).label
    : "";
  const badge = props.modelOption?.providerBadge;
  const label = props.modelOption?.label ?? props.selection?.model ?? "Choose model";
  const quota = props.modelOption?.quotaSummary;
  const resetLabel =
    props.quotaResetLabel === undefined ? quota?.resetLabel : props.quotaResetLabel;
  const fallbackLabel = props.fallbackLabel;
  return (
    <ComposerInlineControl
      accessibilityLabel={[
        "Model and reasoning settings",
        label,
        badge?.showBadge ? badge.displayName : null,
        quota?.detail,
        summary,
        fallbackLabel,
      ]
        .filter(Boolean)
        .join(", ")}
      size={props.size}
      disabled={props.disabled}
      emphasized
      renderIcon={(size) =>
        badge?.showBadge ? (
          <ProviderInstanceIcon
            iconUrl={props.modelOption?.providerIconUrl}
            provider={props.modelOption?.providerDriver}
            displayName={badge.displayName}
            accentColor={badge.accentColor}
            showBadge
            surfaceColor={props.surfaceColor}
            size={size}
          />
        ) : (
          <ProviderIcon
            iconUrl={props.modelOption?.providerIconUrl}
            provider={props.modelOption?.providerDriver}
            size={size}
          />
        )
      }
      label={summary ? `${label} · ${summary}` : label}
      iconOnly={props.iconOnly}
      showSuffixWhenIconOnly={Boolean(quota || fallbackLabel)}
      detail={
        quota || resetLabel || fallbackLabel ? (
          <View className="items-start">
            {quota ? (
              <Text
                className="text-2xs font-t3-medium text-foreground text-left"
                style={{ fontVariant: ["tabular-nums"] }}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
                accessibilityLabel={quota.detail}
              >
                {quota.label}
              </Text>
            ) : null}
            {resetLabel || fallbackLabel ? (
              <Text
                className="text-2xs text-foreground-muted text-left"
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
              >
                {resetLabel ? resetLabel : null}
                {resetLabel && fallbackLabel ? " · " : null}
                {fallbackLabel ? (
                  <Text className="text-yellow-400 font-t3-medium" style={{ color: "#facc15" }}>
                    {fallbackLabel}
                  </Text>
                ) : null}
              </Text>
            ) : null}
          </View>
        ) : undefined
      }
      suffix={
        props.iconOnly && (quota || fallbackLabel) ? (
          <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
            {quota?.label ?? fallbackLabel}
          </Text>
        ) : undefined
      }
      maxWidth="100%"
      onPress={props.onPress}
    />
  );
}
