import type { ReactNode } from "react";

export interface CompatibleSettingsSlots {
  register: (
    options: Record<string, unknown>,
    component: unknown,
  ) => () => void;
}

export interface SettingsPluginCardOptions {
  namespace: string;
  legacyId: string;
  legacyOrder: number;
  locale: string;
  inject: () => object;
}

export function registerSettingsPluginCard(
  slots: CompatibleSettingsSlots,
  component: ReactNode,
  options: SettingsPluginCardOptions,
): () => void {
  return slots.register(
    {
      name: "settings.plugin.item",
      key: options.namespace,
      id: options.legacyId,
      order: options.legacyOrder,
      locale: options.locale,
      inject: options.inject,
    },
    component,
  );
}