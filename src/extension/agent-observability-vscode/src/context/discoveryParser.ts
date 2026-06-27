/**
 * Parses discovery and customization-resolution event strings from the
 * `copilot_chat.event_details` span attribute into structured context file entries.
 *
 * Format examples from telemetry:
 * - "Resolved 14 instructions in 126.3ms | loaded: [name1, name2, ...] | folders: [...]"
 * - "Resolved 15 skills in 31.6ms | loaded: [...] | skipped: [...] | folders: [...]"
 * - "Resolved 3 customizations (2 agent, 1 listed) in 108.1ms | [skipped] file.md — reason, [applying] file.md — reason"
 *
 * LOCAL-ONLY: all parsing is on-machine; results never leave the local view.
 */

import type { ContextFileCategory, ContextFileEntry, ContextFileStatus } from './models';

/** A raw discovery event row from the database layer. */
export interface DiscoveryEventRow {
  spanName: string;
  eventDetails: string;
  eventCategory: string;
  conversationId: string | null;
  chatSessionId: string | null;
  agentName: string | null;
  debugLabel: string | null;
}

/**
 * Parse all discovery/customization events into context file entries, grouped
 * by which agent conversation they belong to. Returns a flat list tagged with
 * conversation info for the caller to partition per-agent.
 */
export function parseDiscoveryEvents(
  events: readonly DiscoveryEventRow[],
): ContextFileEntry[] {
  const entries: ContextFileEntry[] = [];

  for (const event of events) {
    if (event.eventCategory === 'discovery') {
      entries.push(...parseDiscoveryEvent(event));
    } else if (event.eventCategory === 'customization') {
      entries.push(...parseCustomizationEvent(event));
    }
  }

  return entries;
}

/**
 * Map a span name (or event details text) to a context file category.
 * "Instructions Discovery" → instruction, "Skill Discovery" → skill, etc.
 * When spanName is empty (column missing), infers from event details text
 * (e.g. "Resolved 14 instructions..." → instruction).
 */
function categoryFromSpanName(spanName: string, eventDetails?: string): ContextFileCategory {
  const lower = spanName.toLowerCase();
  if (lower.includes('instruction')) return 'instruction';
  if (lower.includes('skill')) return 'skill';
  if (lower.includes('agent')) return 'agent';
  if (lower.includes('hook')) return 'hook';
  if (lower.includes('slash') || lower.includes('command')) return 'prompt';

  // Fallback: infer from event details when span name is unavailable
  if (eventDetails) {
    const detLower = eventDetails.toLowerCase();
    const resolvedMatch = detLower.match(/^resolved\s+\d+\s+(\w+)/);
    if (resolvedMatch) {
      const type = resolvedMatch[1];
      if (type.startsWith('instruction')) return 'instruction';
      if (type.startsWith('skill')) return 'skill';
      if (type.startsWith('agent')) return 'agent';
      if (type.startsWith('hook')) return 'hook';
      if (type.startsWith('slash') || type.startsWith('command')) return 'prompt';
    }
    if (detLower.includes('customization')) return 'instruction';
  }

  return 'unknown';
}

/**
 * Parse a discovery event:
 * "Resolved N <type> in X.Xms | loaded: [a, b, c] | skipped: [...] | folders: [...]"
 */
function parseDiscoveryEvent(event: DiscoveryEventRow): ContextFileEntry[] {
  const category = categoryFromSpanName(event.spanName, event.eventDetails);
  const entries: ContextFileEntry[] = [];
  const details = event.eventDetails;

  // Extract loaded names: "loaded: [name1, name2, ...]"
  const loadedMatch = details.match(/loaded:\s*\[([^\]]*)\]/);
  if (loadedMatch) {
    const names = splitBracketList(loadedMatch[1]);
    for (const name of names) {
      entries.push({
        name,
        category,
        status: 'applied',
      });
    }
  }

  // Extract skipped names: "skipped: [uri (reason), ...]"
  const skippedMatch = details.match(/skipped:\s*\[([^\]]*)\]/);
  if (skippedMatch) {
    const items = splitBracketList(skippedMatch[1]);
    for (const item of items) {
      const reasonMatch = item.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (reasonMatch) {
        const rawName = reasonMatch[1].trim();
        const reason = reasonMatch[2].trim();
        // Extract just the filename from a URI if present
        const name = extractNameFromUri(rawName);
        entries.push({
          name,
          category,
          status: 'skipped',
          skipReason: reason,
        });
      } else {
        entries.push({
          name: item.trim(),
          category,
          status: 'skipped',
        });
      }
    }
  }

  return entries;
}

/**
 * Parse a customization-resolution event:
 * "[applying] copilot-instructions.md — always added, [skipped] file.md — applyTo ... did not match"
 */
function parseCustomizationEvent(event: DiscoveryEventRow): ContextFileEntry[] {
  const entries: ContextFileEntry[] = [];
  const details = event.eventDetails;

  // Match individual entries: [applying] name — reason or [skipped] name — reason
  const entryPattern = /\[(applying|skipped)\]\s+([^\n,—]+?)(?:\s*—\s*([^\n,[]+))?(?=,\s*\[|$)/g;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(details)) !== null) {
    const statusRaw = match[1];
    const name = match[2].trim();
    const reason = match[3]?.trim();

    const status: ContextFileStatus = statusRaw === 'applying' ? 'applied' : 'skipped';

    // Determine category from file extension/name
    const category = categoryFromFileName(name);

    entries.push({
      name,
      category,
      status,
      skipReason: status === 'skipped' ? reason : undefined,
    });
  }

  return entries;
}

/**
 * Determine category from a file name.
 */
function categoryFromFileName(name: string): ContextFileCategory {
  const lower = name.toLowerCase();
  if (lower.endsWith('.instructions.md') || lower === 'copilot-instructions.md' || lower === 'claude.md') {
    return 'instruction';
  }
  if (lower.includes('skill') || lower === 'skill.md') return 'skill';
  if (lower.endsWith('.agent.md') || lower.endsWith('.prompt.md')) return 'agent';
  if (lower.includes('hook')) return 'hook';
  return 'instruction'; // Default for customization entries
}

/**
 * Split a comma-separated list from inside brackets, handling items that may
 * contain parenthesized sub-content (e.g. "file:///path (reason)").
 */
function splitBracketList(content: string): string[] {
  if (!content.trim()) return [];
  // Split on ", " that is NOT inside parentheses
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of content) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) items.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }
  const lastTrimmed = current.trim();
  if (lastTrimmed.length > 0) items.push(lastTrimmed);
  return items;
}

/**
 * Extract a short name from a file:// URI or path, or return as-is.
 * "file:///c%3A/Users/.../monorepo-structure.instructions.md" → "monorepo-structure.instructions.md"
 */
function extractNameFromUri(raw: string): string {
  if (raw.startsWith('file:///')) {
    try {
      const decoded = decodeURIComponent(raw.replace('file:///', ''));
      const segments = decoded.replace(/\\/g, '/').split('/');
      return segments[segments.length - 1] || raw;
    } catch {
      return raw;
    }
  }
  // If it looks like a path, take the last segment
  if (raw.includes('/') || raw.includes('\\')) {
    const segments = raw.replace(/\\/g, '/').split('/');
    return segments[segments.length - 1] || raw;
  }
  return raw;
}
