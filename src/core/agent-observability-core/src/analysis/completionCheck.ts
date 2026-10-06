import {
  commandOutcome,
  isVerificationClass,
  type ActivityCommand,
  type SessionActivity,
  type VerificationClass,
} from './sessionActivity';

/**
 * "Did it really finish?" — what a session's own record shows about whether
 * the work was checked before the agent reported back.
 *
 * Three steps, each pure:
 *  1. {@link evidenceFromActivity} reduces a {@link SessionActivity} (raw
 *     commands, paths and closing text) to {@link CompletionEvidence}: counts,
 *     enums, booleans and turn indices ONLY.
 *  2. {@link decideCompletion} turns the evidence into a status and a list of
 *     checks, by a fixed decision table.
 *  3. {@link completionCounts} flattens that for the local index.
 *
 * Privacy: step 1 is the last place raw content is visible. Nothing after it —
 * not the status, not a check's `detail`, not the persisted counts — carries a
 * command, a path or a word of a message. `detail` strings come from
 * {@link DETAIL_TEXT} and are never interpolated.
 *
 * Wording rule: the app reports what was and was not OBSERVED in this
 * session's record. It never says an agent lied, and it cannot see checks run
 * in another terminal, in CI or by a hook.
 */

export type CompletionStatus = 'verified' | 'unverified' | 'contradicted' | 'incomplete' | 'not-applicable';
export type CompletionClaim = 'done' | 'partial' | 'none';
export type CompletionNaReason = 'no-edits' | 'docs-only' | 'source-lacks-evidence';

/** Stable ids; rendered by hosts and referenced by tests. Never rename one. */
export type CompletionCheckId =
  | 'verification-after-last-edit'
  | 'last-verification-passed'
  | 'clean-ending'
  | 'completion-claimed'
  | 'incompletion-admitted'
  | 'edits-inside-repository'
  | 'edits-read-back';

export interface CompletionCheckItem {
  id: CompletionCheckId;
  passed: boolean;
  /** Index into `SessionDetail.turns` of the evidence, when it is one turn. */
  evidenceTurnIndex?: number;
  /** Fixed sentence from {@link DETAIL_TEXT}; MUST NOT embed command, path or message text. */
  detail: string;
}

export interface CompletionCheck {
  status: CompletionStatus;
  naReason?: CompletionNaReason;
  claim: CompletionClaim;
  checks: CompletionCheckItem[];
}

/** Chokepoint output: counts, enums, booleans and turn indices only. */
export interface CompletionEvidence {
  /** False when the source cannot see tool inputs; nothing below is meaningful then. */
  sourceComplete: boolean;
  codeEditCalls: number;
  docEditCalls: number;
  /** Distinct code files edited. */
  filesEdited: number;
  lastEditTurnIndex?: number;
  verifyRuns: number;
  /** Runs whose observed result was a failure. */
  verifyFailures: number;
  /** Runs whose result could not be read: no result record, a background start, or a masked exit status with no recognisable summary in the output. */
  verifyUnknownResult: number;
  lastVerifyClass?: VerificationClass;
  lastVerifyTurnIndex?: number;
  /** A verification command ran after the last code edit. */
  verifiedAfterLastEdit: boolean;
  /** The last verification's observed result was a failure. */
  lastVerifyFailed: boolean;
  /** The last verification's result was observable at all. */
  lastVerifyResultKnown: boolean;
  endedOnFailedTool: boolean;
  trailingFailedTools: number;
  claim: CompletionClaim;
  /** The closing text says checks were skipped or could not be run. */
  admitsSkippedChecks: boolean;
  filesOutsideRepo: number;
  /** Code files edited and not read afterwards. Informational only. */
  filesNeverReadBack: number;
}

// ── Closing-text classification ─────────────────────────────────────────────

/** Phrases that read as "the work is finished". Matched on lower-cased text. */
export const DONE_MARKERS: readonly RegExp[] = [
  /\ball (?:the )?(?:tests|checks|specs) (?:are )?pass/,
  /\b(?:is|are) now (?:complete|working|fixed|implemented|in place)\b/,
  /\b(?:has|have) been (?:fixed|implemented|added|updated|completed|resolved|applied)\b/,
  /\bchanges are in place\b/,
  /\b(?:i|we)(?:'ve| have) (?:now )?(?:implemented|fixed|added|completed|finished|updated|resolved)\b/,
  /\bimplementation is complete\b/,
  /\bsuccessfully (?:implemented|completed|fixed|added|updated)\b/,
  /\b(?:all )?done\b/,
  /\b(?:finished|completed)\b/,
];

/** Phrases that read as "not everything is finished". Partial wins over done. */
export const PARTIAL_MARKERS: readonly RegExp[] = [
  /\bcould(?: not|n't)\b/,
  /\bunable to\b/,
  /\b(?:was|were)(?: not|n't) able to\b/,
  /\bdid(?: not|n't) (?:run|finish|complete|get to)\b/,
  /\bnot yet\b/,
  /(?<!no )\bremaining\b/,
  /\btodo\b/,
  /\bstill (?:failing|fails|fail|needs|need|broken|outstanding)\b/,
  /\bskipped\b/,
  /\bleft as\b/,
  /\bout of time\b/,
  /\bnot (?:been )?(?:implemented|finished|completed|verified|tested)\b/,
  /\bpartial(?:ly)?\b/,
];

/** Phrases that say verification itself did not happen. */
export const SKIPPED_CHECK_MARKERS: readonly RegExp[] = [
  /\b(?:did(?: not|n't)|have(?: not|n't)|haven't|could(?: not|n't)|unable to) (?:run|execute) (?:the |any )?(?:tests?|checks?|build|linter|lint|type ?check)/,
  /\b(?:tests?|checks?) (?:were|was|are) (?:not run|skipped)\b/,
  /\bskipped (?:the |running )?(?:tests?|checks?|verification)\b/,
  /\bnot (?:been )?(?:verified|tested)\b/,
  /\bwithout running\b/,
];

/** Classify the closing assistant text. Reads content; returns enums only. */
export function classifyClosingText(text: string | undefined): { claim: CompletionClaim; admitsSkippedChecks: boolean } {
  if (text === undefined || text.trim().length === 0) {
    return { claim: 'none', admitsSkippedChecks: false };
  }
  const lowered = text.toLowerCase();
  const admitsSkippedChecks = SKIPPED_CHECK_MARKERS.some((m) => m.test(lowered));
  if (admitsSkippedChecks || PARTIAL_MARKERS.some((m) => m.test(lowered))) {
    return { claim: 'partial', admitsSkippedChecks };
  }
  return { claim: DONE_MARKERS.some((m) => m.test(lowered)) ? 'done' : 'none', admitsSkippedChecks };
}

// ── Evidence ────────────────────────────────────────────────────────────────

export interface EvidenceOptions {
  /** Extensions (with the dot, any case) counted as code. Unknown extensions also count as code. */
  codeExtensions: readonly string[];
  /** Extensions counted as documentation; an edit to one is not a code edit. */
  docExtensions: readonly string[];
  /** Whether a recorded path lies inside the session's repository. Omit to skip the check. */
  isInsideRepo?: (path: string) => boolean;
}

/** Lower-cased extension of a path's last segment, with the dot; '' when none. */
export function extensionOf(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function resultObserved(command: ActivityCommand): boolean {
  return commandOutcome(command) !== 'unknown';
}

function resultFailed(command: ActivityCommand): boolean {
  return commandOutcome(command) === 'failed';
}

/** Reduce an activity to completion evidence. The last step that sees raw content. */
export function evidenceFromActivity(activity: SessionActivity, opts: EvidenceOptions): CompletionEvidence {
  const docs = new Set(opts.docExtensions.map((e) => e.toLowerCase()));
  const isDoc = (path: string): boolean => docs.has(extensionOf(path));

  const codeEdits = activity.edits.filter((e) => !isDoc(e.path));
  const docEditCalls = activity.edits.length - codeEdits.length;
  const lastEdit = codeEdits.reduce<(typeof codeEdits)[number] | undefined>(
    (latest, e) => (latest === undefined || e.order >= latest.order ? e : latest),
    undefined,
  );

  const runs = activity.commands.filter((c) => isVerificationClass(c.class));
  const lastRun = runs.reduce<ActivityCommand | undefined>(
    (latest, c) => (latest === undefined || c.order >= latest.order ? c : latest),
    undefined,
  );
  const lastRunAfterEdit = lastRun !== undefined && (lastEdit === undefined || lastRun.order > lastEdit.order);

  const codeFiles = new Set(codeEdits.map((e) => e.path));
  let filesNeverReadBack = 0;
  for (const file of codeFiles) {
    const lastEditOrder = Math.max(...codeEdits.filter((e) => e.path === file).map((e) => e.order));
    if (!activity.reads.some((r) => r.path === file && r.order > lastEditOrder)) {
      filesNeverReadBack += 1;
    }
  }
  const isInsideRepo = opts.isInsideRepo;
  const filesOutsideRepo =
    isInsideRepo === undefined ? 0 : new Set(activity.edits.filter((e) => !isInsideRepo(e.path)).map((e) => e.path)).size;

  const closing = classifyClosingText(activity.closingText);
  return {
    sourceComplete: activity.complete,
    codeEditCalls: codeEdits.length,
    docEditCalls,
    filesEdited: codeFiles.size,
    ...(lastEdit !== undefined ? { lastEditTurnIndex: lastEdit.turnIndex } : {}),
    verifyRuns: runs.length,
    verifyFailures: runs.filter((c) => resultFailed(c)).length,
    verifyUnknownResult: runs.filter((c) => !resultObserved(c)).length,
    ...(lastRun !== undefined && isVerificationClass(lastRun.class) ? { lastVerifyClass: lastRun.class } : {}),
    ...(lastRun !== undefined ? { lastVerifyTurnIndex: lastRun.turnIndex } : {}),
    verifiedAfterLastEdit: lastRunAfterEdit,
    lastVerifyFailed: lastRun !== undefined && resultFailed(lastRun),
    lastVerifyResultKnown: lastRun !== undefined && resultObserved(lastRun),
    endedOnFailedTool: activity.endedOnFailedTool,
    trailingFailedTools: activity.trailingFailedTools,
    claim: closing.claim,
    admitsSkippedChecks: closing.admitsSkippedChecks,
    filesOutsideRepo,
    filesNeverReadBack,
  };
}

// ── Decision ────────────────────────────────────────────────────────────────

/**
 * The only sentences a check may carry. Each describes what the session's
 * record does or does not show, and none has a slot for content.
 */
export const DETAIL_TEXT: Readonly<Record<CompletionCheckId, { passed: string; failed: string; unknown?: string }>> = {
  'verification-after-last-edit': {
    passed: 'A test, build, lint or type-check command was observed after the last code edit.',
    failed: 'No test, build, lint or type-check command was observed after the last code edit.',
  },
  'last-verification-passed': {
    passed: 'The last check that ran reported success.',
    failed: 'The last check that ran reported a failure, and no later check was observed.',
    unknown: 'A check ran after the last edit; its result could not be read from what the session recorded.',
  },
  'clean-ending': {
    passed: 'The session did not end on a failed tool call.',
    failed: 'The session ended on a failed tool call.',
  },
  'completion-claimed': {
    passed: 'The final message reads as reporting the work finished.',
    failed: 'The final message does not read as reporting the work finished.',
  },
  'incompletion-admitted': {
    passed: 'The final message does not mention unfinished work.',
    failed: 'The final message mentions unfinished work or checks that were not run.',
  },
  'edits-inside-repository': {
    passed: 'Every edited file is inside the repository.',
    failed: 'At least one edited file is outside the repository.',
  },
  'edits-read-back': {
    passed: 'Every edited code file was read again after its last edit.',
    failed: 'At least one edited code file was not read again after its last edit.',
  },
};

function item(
  id: CompletionCheckId,
  outcome: 'passed' | 'failed' | 'unknown',
  evidenceTurnIndex?: number,
): CompletionCheckItem {
  const text = DETAIL_TEXT[id];
  return {
    id,
    passed: outcome === 'passed',
    ...(evidenceTurnIndex !== undefined && evidenceTurnIndex >= 0 ? { evidenceTurnIndex } : {}),
    detail: outcome === 'unknown' ? (text.unknown ?? text.failed) : text[outcome],
  };
}

/**
 * Decide the completion status. Precedence, top to bottom:
 *
 * | Condition | Status |
 * | --- | --- |
 * | The source cannot see commands | not-applicable (`source-lacks-evidence`) |
 * | No code-edit calls | not-applicable (`no-edits` / `docs-only`) |
 * | Claim is done, and the last check after the last edit observably failed | contradicted |
 * | Claim is partial, or ended on a failed tool, or the last check after the last edit failed with no done-claim | incomplete |
 * | No check after the last edit, or its result was not observable | unverified |
 * | A check after the last edit observably passed | verified |
 */
export function decideCompletion(e: CompletionEvidence): CompletionCheck {
  if (!e.sourceComplete) {
    return { status: 'not-applicable', naReason: 'source-lacks-evidence', claim: e.claim, checks: [] };
  }
  if (e.codeEditCalls === 0) {
    return {
      status: 'not-applicable',
      naReason: e.docEditCalls > 0 ? 'docs-only' : 'no-edits',
      claim: e.claim,
      checks: [],
    };
  }

  const checks: CompletionCheckItem[] = [];
  checks.push(
    item(
      'verification-after-last-edit',
      e.verifiedAfterLastEdit ? 'passed' : 'failed',
      e.verifiedAfterLastEdit ? e.lastVerifyTurnIndex : e.lastEditTurnIndex,
    ),
  );
  if (e.verifiedAfterLastEdit) {
    checks.push(
      item(
        'last-verification-passed',
        !e.lastVerifyResultKnown ? 'unknown' : e.lastVerifyFailed ? 'failed' : 'passed',
        e.lastVerifyTurnIndex,
      ),
    );
  }
  checks.push(item('clean-ending', e.endedOnFailedTool ? 'failed' : 'passed'));
  checks.push(item('completion-claimed', e.claim === 'done' ? 'passed' : 'failed'));
  if (e.claim === 'partial' || e.admitsSkippedChecks) {
    checks.push(item('incompletion-admitted', 'failed'));
  }
  if (e.filesOutsideRepo > 0) {
    checks.push(item('edits-inside-repository', 'failed'));
  }
  // Informational only: never moves the status.
  checks.push(item('edits-read-back', e.filesNeverReadBack === 0 ? 'passed' : 'failed'));

  const failedAfterEdit = e.verifiedAfterLastEdit && e.lastVerifyResultKnown && e.lastVerifyFailed;
  let status: CompletionStatus;
  if (e.claim === 'done' && failedAfterEdit) {
    status = 'contradicted';
  } else if (e.claim === 'partial' || e.endedOnFailedTool || failedAfterEdit) {
    status = 'incomplete';
  } else if (!e.verifiedAfterLastEdit || !e.lastVerifyResultKnown) {
    status = 'unverified';
  } else {
    status = 'verified';
  }
  return { status, claim: e.claim, checks };
}

/** Whether a check reads as "reported done, not verified" — the Dashboard's headline count. */
export function isReportedDoneUnverified(check: CompletionCheck): boolean {
  return check.claim === 'done' && (check.status === 'unverified' || check.status === 'contradicted');
}

// ── Persistence projection ──────────────────────────────────────────────────

/** The flat, content-free projection the local index stores. */
export interface CompletionCounts {
  completionStatus: CompletionStatus;
  completionNaReason?: CompletionNaReason;
  completionClaim: CompletionClaim;
  verifyRuns: number;
  verifyFailures: number;
  lastVerifyClass?: VerificationClass;
  verifiedAfterLastEdit: boolean;
  lastVerifyFailed: boolean;
  endedOnFailedTool: boolean;
  filesEdited: number;
  filesOutsideRepo: number;
}

export function completionCounts(check: CompletionCheck, evidence: CompletionEvidence): CompletionCounts {
  return {
    completionStatus: check.status,
    ...(check.naReason !== undefined ? { completionNaReason: check.naReason } : {}),
    completionClaim: check.claim,
    verifyRuns: evidence.verifyRuns,
    verifyFailures: evidence.verifyFailures,
    ...(evidence.lastVerifyClass !== undefined ? { lastVerifyClass: evidence.lastVerifyClass } : {}),
    verifiedAfterLastEdit: evidence.verifiedAfterLastEdit,
    lastVerifyFailed: evidence.lastVerifyFailed,
    endedOnFailedTool: evidence.endedOnFailedTool,
    filesEdited: evidence.filesEdited,
    filesOutsideRepo: evidence.filesOutsideRepo,
  };
}
