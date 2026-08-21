/**
 * Client-side companion for dsh-pseudo-vision.
 *
 * Registers a compact settings plugin card ("Pseudo Vision") that shows the
 * bridge status. The bridge itself is entirely server-side; configuration
 * details remain in the README rather than crowding the Settings page.
 */

import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type { ReactNode } from "react";

import { PseudoVisionSettingsCard } from "./PseudoVisionSettingsCard.js";
import {
  registerSettingsPluginCard,
  type CompatibleSettingsSlots,
} from "./settingsSlot.js";

export const inject = ["slots", "settingsScope"];

export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<Record<string, unknown>>({
    namespace: "llm-deepseek",
    decode: (value: unknown): Record<string, unknown> | undefined =>
      value as Record<string, unknown> | undefined,
  });

  ctx.slots.inject("settings.plugin.item", () =>
    registerSettingsPluginCard(
      ctx.slots as unknown as CompatibleSettingsSlots,
      PseudoVisionSettingsCard as unknown as ReactNode,
      {
        namespace: "llm-deepseek",
        legacyId: "dsh-pseudo-vision",
        legacyOrder: 10,
        locale: "settings.dshPseudoVision",
        inject: () => scope,
      },
    ),
  );
}