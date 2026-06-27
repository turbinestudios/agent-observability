import { extractFencedBlock } from './fenced';

/**
 * Pure prompt construction + output filtering for the "Set up new project" task.
 *
 * The model emits a minimal `.vscode/settings.json` object; before applying it we
 * filter to the keys this extension actually contributes so a hallucinated key is
 * never written. The whitelist MIRRORS package.json `contributes.configuration`
 * (kept here as a pure constant so this module never imports the `vscode`-coupled
 * `configuration.ts`; the smoke test guards the package.json side).
 */

/** The fence tag the assistant is asked to use for generated settings. */
export const CONFIG_FENCE_LANG = 'ao-config';

/** Full `agentObservability.*` keys the extension contributes (mirrors package.json). */
export const KNOWN_CONFIG_KEYS: readonly string[] = [
  'agentObservability.localTelemetry.enabled',
  'agentObservability.sqlitePath',
  'agentObservability.sync.enabled',
  'agentObservability.sync.intervalMinutes',
  'agentObservability.deviation.maxSessionMinutes',
  'agentObservability.workflows',
  'agentObservability.context.acceptedMissingFiles',
  'agentObservability.context.acceptedMissingSources',
  'agentObservability.analysis.codeFileExtensions',
  'agentObservability.analysis.docFileExtensions',
];

const KNOWN_CONFIG_KEY_SET = new Set(KNOWN_CONFIG_KEYS);

/** Assemble the grounding preamble for the minimal-config request. */
export function buildMinimalConfigPreamble(contextText: string): string {
  return [
    contextText,
    '',
    '## Task',
    'Produce the bare-minimum `.vscode/settings.json` to get this extension working. The extension',
    'works out of the box, so prefer the smallest possible object. Emit EXACTLY ONE fenced code block',
    'tagged `' + CONFIG_FENCE_LANG + '` containing a JSON OBJECT of `agentObservability.*` settings.',
    'Only use keys from the settings reference; never include an API key (it is set via a command, not',
    'settings). Briefly explain the API-key step in prose if relevant.',
  ].join('\n');
}

/** Outcome of extracting + filtering the generated config object. */
export type ConfigExtraction =
  | { ok: true; settings: Record<string, unknown>; dropped: string[] }
  | { ok: false; reason: string };

/**
 * Pull the fenced config block, parse it, and keep only known
 * `agentObservability.*` keys. Unknown keys are reported in `dropped`. Fails when
 * there is no block, the JSON is invalid, or it isn't a plain object.
 */
export function extractConfigResponse(response: string): ConfigExtraction {
  const block = extractFencedBlock(response, [CONFIG_FENCE_LANG]);
  if (block === undefined) {
    return { ok: false, reason: 'The response contained no JSON code block.' };
  }
  return parseConfigObject(block);
}

/**
 * Parse a raw settings-object JSON string and keep only known
 * `agentObservability.*` keys. Used both on the response path and when applying
 * the block the webview sends back.
 */
export function parseConfigObject(jsonText: string): ConfigExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: 'The generated configuration was not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'Expected a JSON object of settings.' };
  }
  const { kept, dropped } = filterKnownConfigKeys(parsed as Record<string, unknown>);
  return { ok: true, settings: kept, dropped };
}

/** Split an object into known `agentObservability.*` keys vs dropped unknowns. */
export function filterKnownConfigKeys(obj: Record<string, unknown>): {
  kept: Record<string, unknown>;
  dropped: string[];
} {
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (KNOWN_CONFIG_KEY_SET.has(key)) {
      kept[key] = value;
    } else {
      dropped.push(key);
    }
  }
  return { kept, dropped };
}
