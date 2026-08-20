/**
 * Plugin metadata.
 *
 * `@deepseek-ai/dsh` Cordis loader picks up `name` and `apply` from this file
 * (or any file re-exporting them). Keep them at the root so future bundlers
 * find them without a custom resolution rule.
 */
export const name = 'dsh-pseudo-vision';

/**
 * Re-export `apply` from the implementation file so the bundle entry stays
 * discoverable even if someone rewires the internal layout.
 */
export { apply } from './agent.js';