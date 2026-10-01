/**
 * The "Improve context files" prompt — LOCAL-ONLY.
 *
 * Built deterministically from a context analysis so the user can copy it into
 * their own coding agent (Claude Code, Copilot) opened in the repository. The
 * app sends nothing anywhere: the agent the prompt is pasted into reads the
 * files itself, and what it cannot know — and what this prompt supplies — is
 * what only this app measured: each file's token cost, which files went over
 * the guideline, and which references never loaded.
 *
 * Pure and free of node imports, so the desktop renderer can build the text
 * from facts the data host hands it.
 */

import { OVERSIZED_THRESHOLD_TOKENS } from './models';
import type { AgentContextAnalysis, ContextFileCategory } from './models';

/** One loaded context file, reduced to what the prompt states about it. */
export interface ContextPromptFile {
  name: string;
  /** Resolved path when known; the prompt falls back to the name. */
  path?: string;
  category: ContextFileCategory;
  estimatedTokens?: number;
  /** Over {@link OVERSIZED_THRESHOLD_TOKENS}. */
  oversized: boolean;
  /** Files this one references that never made it into context. */
  missingRefs: string[];
}

/** The facts one Context Analysis section contributes to the prompt. */
export interface ContextPromptFacts {
  /** The section's agent name ("Total", "Main Agent", a subagent). */
  agentName: string;
  /** Loaded (applied or read) files, largest first. Skipped files are left out. */
  files: ContextPromptFile[];
  contextFileTokens: number;
  totalContextTokens: number;
}

export type ContextPromptScope = 'flagged' | 'all';

/** Reduce one section's analysis to the facts the prompt is built from. */
export function contextPromptFacts(agent: AgentContextAnalysis): ContextPromptFacts {
  const oversized = new Set(agent.oversizedFiles.map((f) => f.name));
  const missingBySource = new Map<string, string[]>();
  for (const missing of agent.expectedMissing) {
    for (const ref of missing.referencedBy) {
      const list = missingBySource.get(ref.sourceFile) ?? [];
      if (!list.includes(missing.name)) {
        list.push(missing.name);
      }
      missingBySource.set(ref.sourceFile, list);
    }
  }

  const files = agent.loadedFiles
    .filter((f) => f.status !== 'skipped')
    .map((f): ContextPromptFile => ({
      name: f.name,
      ...(f.filePath !== undefined ? { path: f.filePath } : {}),
      category: f.category,
      ...(f.estimatedTokens !== undefined ? { estimatedTokens: f.estimatedTokens } : {}),
      oversized: oversized.has(f.name),
      missingRefs: missingBySource.get(f.name) ?? [],
    }))
    .sort((a, b) => (b.estimatedTokens ?? 0) - (a.estimatedTokens ?? 0));

  return {
    agentName: agent.agentName,
    files,
    contextFileTokens: agent.contextFileTokens,
    totalContextTokens: agent.totalContextTokens,
  };
}

/** Whether the analysis flagged this file (oversized or a dangling reference). */
export function isFlagged(file: ContextPromptFile): boolean {
  return file.oversized || file.missingRefs.length > 0;
}

/** The scope a dialog should open on: the flagged files when there are any. */
export function defaultPromptScope(facts: ContextPromptFacts): ContextPromptScope {
  return facts.files.some(isFlagged) ? 'flagged' : 'all';
}

/** The files a scope covers. */
export function filesInScope(facts: ContextPromptFacts, scope: ContextPromptScope): ContextPromptFile[] {
  return scope === 'flagged' ? facts.files.filter(isFlagged) : facts.files;
}

/**
 * The prompt text, as Markdown. Vendor-neutral, so it reads the same pasted
 * into Claude Code or Copilot. Numbers are formatted by hand rather than with
 * `Intl`, so the text is identical on every machine.
 */
export function buildImproveContextPrompt(facts: ContextPromptFacts, scope: ContextPromptScope): string {
  const files = filesInScope(facts, scope);
  const lines: string[] = ['# Improve my AI context files', ''];

  const budget =
    facts.contextFileTokens > 0 && facts.totalContextTokens > 0
      ? ` Together, the context files took about ${groupThousands(facts.contextFileTokens)} of the ${groupThousands(facts.totalContextTokens)} tokens in the agent's starting context.`
      : '';
  lines.push(
    `Agent Observability measured the context files loaded in a recent coding-agent session.${budget}`,
    '',
    scope === 'flagged'
      ? 'The files below were flagged. Fix what is listed under each one, so they cost fewer tokens to load and guide an agent better, without losing any rule or fact an agent relies on.'
      : 'Review the files below so they cost fewer tokens to load and guide an agent better, without losing any rule or fact an agent relies on. Fix anything listed under a file first.',
    '',
    '## Files',
    '',
  );

  if (files.length === 0) {
    lines.push('(No files in this selection.)', '');
  }
  files.forEach((file, i) => {
    const size = file.estimatedTokens !== undefined ? `, ~${groupThousands(file.estimatedTokens)} tokens` : '';
    const kind = file.category !== 'unknown' ? ` (${file.category})` : '';
    lines.push(`${i + 1}. \`${clean(file.path ?? file.name)}\`${kind}${size}`);
    if (file.oversized && file.estimatedTokens !== undefined) {
      const ratio = (file.estimatedTokens / OVERSIZED_THRESHOLD_TOKENS).toFixed(1);
      lines.push(
        `   - Oversized: about ${ratio}× the ${groupThousands(OVERSIZED_THRESHOLD_TOKENS)}-token guideline. It is loaded in full every time, so every line costs tokens on every request.`,
      );
    }
    for (const ref of file.missingRefs) {
      lines.push(
        `   - References \`${clean(ref)}\`, which was never loaded into context. Fix the reference if the name or path is wrong, inline the part that matters, or remove it if it is obsolete.`,
      );
    }
  });

  lines.push(
    '',
    '## How to work',
    '',
    '- Read each file in full before changing it.',
    '- Edit only the files listed above. If one is outside the current repository (for example in your home directory), ask me before changing it.',
    '- Keep every rule and fact. Cut repetition, filler, and anything an agent can work out from the code itself.',
    '- For an oversized file, move detail that only some tasks need into a file loaded on demand (a skill, or an instructions file scoped with `applyTo`), and leave a one-line pointer behind.',
    '- Never delete a file.',
    '- When you are done, list each file with its size before and after, and summarize what moved where.',
    '',
  );
  return lines.join('\n');
}

/** `12345` → `12,345`, the same everywhere (no `Intl`). */
function groupThousands(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Names and paths come from session data, so they are flattened to one line
 * and stripped of backticks: neither can break out of the list item it sits in
 * and smuggle instructions into a prompt the user will paste into an agent.
 */
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f`]/g, ' ').replace(/\s+/g, ' ').trim();
}
