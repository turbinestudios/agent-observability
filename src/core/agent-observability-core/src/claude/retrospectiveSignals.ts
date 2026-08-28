import { TranscriptRecord, contentBlocks, messageText } from './transcript';
import { isCommandText, isInterruptionText, type RetrospectiveSignals } from '../analysis/retrospective';

/**
 * Extracts the transcript-only retrospective signals — the ones no
 * `SessionDetail` field carries — from a Claude session's MAIN-THREAD records.
 *
 * This file is the raw-content CHOKEPOINT for the retrospective, mirroring
 * `../telemetry/locAnalysis.ts`: transcript text goes in, only counts and enum
 * labels come out. Nothing here returns a string of user content.
 *
 * Defensive by house rule (see `./transcript.ts`): a transcript is third-party
 * data whose shape shifts between Claude Code versions, so every check treats
 * an unrecognized record as absent rather than throwing, and the interruption
 * marker is matched by TEXT PREFIX rather than by meta flags — versions differ
 * on whether the marker record is stamped `isMeta`.
 *
 * Sub-agent side-chains are deliberately not fed here: interruption and
 * compaction are main-thread concepts (the user steers the main conversation).
 */

/** Record types that are bookkeeping, not conversation. */
const METADATA_TYPES = new Set([
  'ai-title',
  'summary',
  'file-history-snapshot',
  'last-prompt',
  'mode',
  'permission-mode',
  'agent-name',
  'system',
  'attachment',
]);

export function extractRetrospectiveSignals(records: readonly TranscriptRecord[]): RetrospectiveSignals {
  let interruptionCount = 0;
  let compactionCount = 0;
  let planModeUsed = false;
  let apiErrorCount = 0;

  for (const record of records) {
    if (record.isSidechain === true) {
      continue;
    }
    if (record.permissionMode === 'plan') {
      // Covers both the dedicated `permission-mode` record and the per-record
      // stamp newer versions put on ordinary records — checked before any
      // type-specific branch so no record kind can shadow it.
      planModeUsed = true;
    }
    if (record.type === 'user' && record.message !== undefined) {
      if (isInterruptionText(messageText(record.message))) {
        interruptionCount++;
      }
      continue;
    }
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      compactionCount++;
      continue;
    }
    if (record.type === 'assistant' && record.isApiErrorMessage === true) {
      apiErrorCount++;
    }
  }

  const lastEvent = classifyLastEvent(records);
  return {
    interruptionCount,
    endedWithInterruption: lastEvent === 'interruption',
    compactionCount,
    planModeUsed,
    apiErrorCount,
    lastEvent,
  };
}

/**
 * Walk backwards past bookkeeping records and classify the final substantive
 * one — the input the abandonment heuristic reads. An assistant record without
 * text (e.g. a trailing `tool_use` whose result never landed) classifies as
 * `unknown`: it usually means the transcript was cut mid-write, which the
 * recent-activity grace in the analyzer handles better than an abandonment
 * claim would.
 */
function classifyLastEvent(records: readonly TranscriptRecord[]): RetrospectiveSignals['lastEvent'] {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.isSidechain === true || METADATA_TYPES.has(record.type)) {
      continue;
    }
    if (record.type === 'assistant' && record.message !== undefined) {
      return messageText(record.message).trim().length > 0 ? 'assistant-response' : 'unknown';
    }
    if (record.type === 'user' && record.message !== undefined) {
      const text = messageText(record.message);
      // Interruption is checked before the meta flag on purpose — see header.
      if (isInterruptionText(text)) {
        return 'interruption';
      }
      if (isCommandText(text)) {
        // Slash-command bookkeeping (`/clear`, …) is how sessions close, not
        // an unanswered prompt — keep walking for the real last event.
        continue;
      }
      if (record.isMeta !== true && text.trim().length > 0) {
        return 'user-request';
      }
      const blocks = contentBlocks(record.message);
      if (blocks.length > 0 && blocks.every((b) => b.type === 'tool_result')) {
        return 'tool-result';
      }
      return 'unknown';
    }
    if (record.type === 'user' || record.type === 'assistant') {
      return 'unknown';
    }
  }
  return 'unknown';
}
