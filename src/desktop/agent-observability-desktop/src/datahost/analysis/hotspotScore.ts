/**
 * The Dashboard's composite hotspot score. The formula lives in core
 * (`analysis/hotspotScore.ts`) so the Dashboard, the repository hub and the
 * Team view rank with the same numbers; this module only keeps the desktop's
 * import path stable.
 */
export { HOTSPOT_TOKEN_BUDGET, scoreHotspots } from '@agent-observability/core/src/analysis/hotspotScore';
