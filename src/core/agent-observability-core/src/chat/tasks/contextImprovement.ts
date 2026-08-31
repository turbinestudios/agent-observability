import { isSafeContextFilePath } from '../../aggregate/customizationFilter';
import { extractFencedBlock, parseFencedBlocks } from './fenced';
import { buildContextFilesDigest, type ProjectContextFile } from './projectContext';

/**
 * The Context Improvement Plan task: ask the user's own AI CLI how one
 * repository's context files (CLAUDE.md, AGENTS.md, copilot-instructions.md,
 * instruction/skill/prompt/agent files) should change, grounded in the
 * hotspot statistics and retrospective evidence the user selected plus the
 * files' current contents.
 *
 * PRIVACY BOUNDARY — THE THIRD SANCTIONED EXCEPTION. The prompt built here
 * contains raw content: session titles and goals, retrospective findings, and
 * the full (capped) contents of the repository's context files. Sending it
 * transmits that content to the vendor of the selected backend — Anthropic via
 * the user's own Claude Code login, or GitHub via their own Copilot CLI login.
 * That is permitted ONLY behind the double consent gate documented in
 * AGENTS.md and docs/proposals/11-context-improvement-plans.md — a default-off
 * setting plus a per-generation confirmation naming the vendor and the
 * payload. Callers own that gate; this module only builds and parses text.
 * Nothing here may ever run in the background or feed the aggregate/sync path.
 *
 * Prompt-building and parsing are pure and fully unit-testable; the spawn and
 * every filesystem write live with the host (the desktop datahost).
 */

/** Fence tag the model must put its machine-readable plan in. */
export const CONTEXT_PLAN_FENCE = 'ao-context-plan';

/** Bounds on what one plan generation may carry and propose. */
export const IMPROVE_LIMITS = {
  /** Selected context files (hotspot rows) per plan. */
  maxHotspots: 8,
  /** Selected sessions per plan. */
  maxSessions: 5,
  /** Findings quoted per session. */
  maxFindingsPerSession: 8,
  /** Tips quoted per session. */
  maxTipsPerSession: 5,
  /** Proposed edits kept from one reply. */
  maxEdits: 6,
  /** Proposed content size per file — anything larger is dropped as invalid. */
  maxEditContentChars: 64_000,
} as const;

/** One selected hotspot, numbers plus a repo-relative path — no absolute paths. */
export interface ImproveHotspotStat {
  /** Repo-relative POSIX path when resolvable, else the file's short name. */
  path: string;
  category: string;
  sessionCount: number;
  appliedCount: number;
  skippedCount: number;
  readCount: number;
  estTokensMax: number;
  errorSessions: number;
  deviationSessions: number;
}

/** One selected session's retrospective evidence. Carries raw content (title, goal). */
export interface ImproveSessionEvidence {
  title?: string;
  goal?: string;
  verdict: string;
  outcome: string;
  findings: { id: string; severity: string; description: string }[];
  tips: string[];
  /** The stored deep-retrospective narrative, when one exists. */
  deepNarrative?: string;
}

/** One proposed file change. Full replacement content, never a hunk. */
export interface ContextPlanEdit {
  /** Repo-relative POSIX path, validated against the customization allowlist. */
  path: string;
  action: 'replace' | 'create';
  /** The COMPLETE new file content. */
  content: string;
  rationale?: string;
}

/** The parsed reply: the human plan plus whatever edits survived validation. */
export interface ParsedContextPlan {
  /** The reply with the machine-readable fence removed — the plan a human reads. */
  narrative: string;
  summary?: string;
  edits: ContextPlanEdit[];
  /** Proposals dropped by validation — reported honestly, never silently. */
  invalidEditCount: number;
}

/** Build the improvement-plan prompt. See the header: the result carries raw content. */
export function buildContextImprovementPrompt(
  repository: string,
  hotspots: readonly ImproveHotspotStat[],
  sessions: readonly ImproveSessionEvidence[],
  files: readonly ProjectContextFile[],
): string {
  const lines: string[] = [];
  lines.push(
    'You are improving how coding agents perform in one repository by revising its',
    'context files — the CLAUDE.md / AGENTS.md / copilot-instructions.md and the',
    'instruction, skill, prompt, and agent files its agents load. Ground every',
    'proposal in the evidence below; be concrete about what to add, tighten, split,',
    'or delete, and address the files, never the developer.',
    '',
    `Repository: ${repository}`,
    '',
    '# Evidence',
  );

  const pickedHotspots = hotspots.slice(0, IMPROVE_LIMITS.maxHotspots);
  if (pickedHotspots.length > 0) {
    lines.push(
      '',
      '## Context files the developer selected for review',
      'Usage across recent sessions. "Applied" = loaded into context; "skipped" =',
      'discovered but left out; "read" = opened with a tool call instead. Error and',
      'flagged counts are co-occurrence, not causation. Files over 2000 estimated',
      'tokens are oversized by this product’s guideline.',
      '',
      '| File | Category | Sessions | Applied | Skipped | Read | Max est. tokens | Error sessions | Flagged sessions |',
      '|---|---|---|---|---|---|---|---|---|',
    );
    for (const h of pickedHotspots) {
      lines.push(
        `| ${h.path} | ${h.category} | ${h.sessionCount} | ${h.appliedCount} | ${h.skippedCount} | ${h.readCount} | ${h.estTokensMax} | ${h.errorSessions} | ${h.deviationSessions} |`,
      );
    }
  }

  const pickedSessions = sessions.slice(0, IMPROVE_LIMITS.maxSessions);
  if (pickedSessions.length > 0) {
    lines.push('', '## Sessions the developer selected as evidence of friction');
    pickedSessions.forEach((session, index) => {
      lines.push('', `### Session ${index + 1}: ${session.title ?? '(untitled)'}`);
      lines.push(`Verdict: ${session.verdict} (${session.outcome})`);
      if (session.goal !== undefined) {
        lines.push(`Goal: ${session.goal}`);
      }
      const findings = session.findings.slice(0, IMPROVE_LIMITS.maxFindingsPerSession);
      if (findings.length > 0) {
        lines.push('Findings:');
        for (const finding of findings) {
          lines.push(`- ${finding.id} (${finding.severity}): ${finding.description}`);
        }
      }
      const tips = session.tips.slice(0, IMPROVE_LIMITS.maxTipsPerSession);
      if (tips.length > 0) {
        lines.push('Heuristic tips already shown to the developer:');
        for (const tip of tips) {
          lines.push(`- ${tip}`);
        }
      }
      if (session.deepNarrative !== undefined) {
        lines.push(`Deep retrospective: ${session.deepNarrative}`);
      }
    });
  }

  lines.push('', '# Current context files', '', buildContextFilesDigest(repository, files));

  lines.push(
    '',
    '# Answer format',
    'First write the improvement plan itself in markdown — what should change, in',
    'which file, and why the evidence supports it. Recommendations that need no',
    'file edit (workflow or prompting advice) belong here too.',
    '',
    `Then emit exactly one fenced code block tagged \`${CONTEXT_PLAN_FENCE}\` containing JSON:`,
    '```' + CONTEXT_PLAN_FENCE,
    '{',
    '  "summary": "the plan in one sentence",',
    '  "edits": [',
    '    {',
    '      "path": "repo-relative POSIX path",',
    '      "action": "replace" | "create",',
    '      "content": "the COMPLETE new file content",',
    '      "rationale": "one sentence on why"',
    '    }',
    '  ]',
    '}',
    '```',
    'Rules for the edits:',
    '- "replace" only for files shown IN FULL above — never one marked (truncated).',
    '- "create" only for files that do not exist yet, with an allowlisted name:',
    '  AGENTS.md, CLAUDE.md, copilot-instructions.md, SKILL.md, or *.instructions.md /',
    '  *.prompt.md / *.agent.md / *.skill.md, under the repository root.',
    '- "content" is the complete file, not a diff. Keep each file under ~2000 tokens.',
    `- At most ${IMPROVE_LIMITS.maxEdits} edits; prefer fewer, better-argued changes.`,
    '- An empty "edits" array is a valid answer when no file change is warranted.',
  );
  return lines.join('\n');
}

/**
 * Parse the model's reply. Tolerant by design: a missing fence or broken JSON
 * still yields the narrative (the plan text is worth reading either way) with
 * zero edits, so the host renders the plan and disables Apply rather than
 * failing the run. Individual invalid edits are dropped and counted.
 */
export function parseContextPlan(
  text: string,
  gathered: readonly ProjectContextFile[],
): ParsedContextPlan {
  const narrative = stripPlanFence(text);
  const body = extractFencedBlock(text, [CONTEXT_PLAN_FENCE]);
  if (body === undefined) {
    return { narrative, edits: [], invalidEditCount: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { narrative, edits: [], invalidEditCount: 0 };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { narrative, edits: [], invalidEditCount: 0 };
  }
  const record = parsed as Record<string, unknown>;
  const summary =
    typeof record.summary === 'string' && record.summary.trim().length > 0
      ? record.summary.trim()
      : undefined;

  const gatheredByPath = new Map(gathered.map((file) => [file.path, file]));
  const edits: ContextPlanEdit[] = [];
  let invalid = 0;
  const rawEdits = Array.isArray(record.edits) ? record.edits : [];
  for (const raw of rawEdits) {
    const edit = validateEdit(raw, gatheredByPath, edits);
    if (edit === undefined) {
      invalid += 1;
    } else if (edits.length >= IMPROVE_LIMITS.maxEdits) {
      invalid += 1;
    } else {
      edits.push(edit);
    }
  }
  return { narrative, ...(summary !== undefined ? { summary } : {}), edits, invalidEditCount: invalid };
}

/**
 * Validate one raw edit. Every rule here is re-checked by the datahost at
 * apply time (the stored plan is user-editable JSON) — this pass exists so the
 * UI never offers an edit that could not be applied.
 */
function validateEdit(
  raw: unknown,
  gathered: ReadonlyMap<string, ProjectContextFile>,
  accepted: readonly ContextPlanEdit[],
): ContextPlanEdit | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path.trim() : '';
  const action = record.action;
  const content = record.content;
  if (path.length === 0 || (action !== 'replace' && action !== 'create') || typeof content !== 'string') {
    return undefined;
  }
  // The allowlist is the write path's whole safety story: relative-only, no
  // `..`, safe charset, customization filenames only.
  if (!isSafeContextFilePath(path)) {
    return undefined;
  }
  if (content.length === 0 || content.length > IMPROVE_LIMITS.maxEditContentChars) {
    return undefined;
  }
  // One edit per path — a second proposal for the same file is a model slip.
  if (accepted.some((edit) => edit.path === path)) {
    return undefined;
  }
  const existing = gathered.get(path);
  if (action === 'replace') {
    // Replacing a file whose tail the model never saw would delete that tail.
    if (existing === undefined || existing.truncated) {
      return undefined;
    }
  } else if (existing !== undefined) {
    // "create" over an existing file is a replace wearing a disguise.
    return undefined;
  }
  const rationale =
    typeof record.rationale === 'string' && record.rationale.trim().length > 0
      ? record.rationale.trim()
      : undefined;
  return { path, action, content, ...(rationale !== undefined ? { rationale } : {}) };
}

/** The reply without its `ao-context-plan` fenced block(s) — the human-readable plan. */
function stripPlanFence(text: string): string {
  const blocks = parseFencedBlocks(text);
  if (!blocks.some((block) => block.lang === CONTEXT_PLAN_FENCE)) {
    return text.trim();
  }
  // Re-walk the lines, dropping fenced regions whose tag matches.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^\s*```+\s*(.*)$/.exec(lines[i]);
    if (open && open[1].trim().toLowerCase() === CONTEXT_PLAN_FENCE) {
      i += 1;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        i += 1;
      }
      if (i < lines.length) {
        i += 1; // closing fence
      }
      continue;
    }
    kept.push(lines[i]);
    i += 1;
  }
  return kept.join('\n').trim();
}
