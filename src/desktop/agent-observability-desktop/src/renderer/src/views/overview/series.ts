import type { SeriesStyle } from './charts';

/**
 * One color per agent source, shared by every chart that splits by source
 * (the Dashboard and Evidence > Summary), so an agent reads the same color on
 * both.
 *
 * Fixed hue order, assigned by identity rather than by rank: a source keeps
 * its color when another one out-counts it. Slots come from the validated
 * categorical palette; see overview.css for the values.
 */
export const SOURCE_SERIES: SeriesStyle[] = [
  { key: 'claude', label: 'Claude Code', colorVar: '--series-1' },
  { key: 'copilot', label: 'Copilot', colorVar: '--series-2' },
  { key: 'copilot-cli', label: 'Copilot CLI', colorVar: '--series-cli' },
  { key: 'copilot-app', label: 'Copilot app', colorVar: '--series-app' },
  { key: 'copilot-jetbrains', label: 'Copilot (JetBrains)', colorVar: '--series-jetbrains' },
  { key: 'opencode', label: 'OpenCode', colorVar: '--series-opencode' },
];

/** A source's color, or a neutral slot for one the palette does not know yet. */
export function sourceColorVar(source: string): string {
  return SOURCE_SERIES.find((s) => s.key === source)?.colorVar ?? '--series-3';
}
