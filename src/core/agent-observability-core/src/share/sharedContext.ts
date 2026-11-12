import * as path from 'node:path';
import { toRepoRelative } from '../aggregate/customizationFilter';
import { contextFileLabel } from '../context/fileLabel';
import type {
  AgentContextAnalysis,
  ContextFileEntry,
  ContextFileReference,
  ExpectedMissingFile,
  SessionContextAnalysis,
} from '../context/models';

/**
 * The Context Analysis as it travels in a shared-session file.
 *
 * The analysis names files on the sender's disk, so on export every absolute
 * path goes:
 *  - a file inside its repository keeps the path relative to the repository
 *    root (`.github/skills/plan/SKILL.md`);
 *  - a file outside any repository keeps only the label the view shows
 *    (`plan/SKILL.md`);
 *  - a reference to a file by path is cut to the same, and an absolute path
 *    that cannot be placed is cut to its file name.
 * The `skipReason` text (copied from the agent's own discovery log, which can
 * name paths and globs) and the source's `note` (written about this machine)
 * are dropped. The importer refuses any of these fields that looks absolute,
 * so a hand-edited file cannot put a path back in.
 */

/** The fixed caption an imported analysis shows: it describes the sender's machine, not this one. */
export const IMPORTED_CONTEXT_NOTE =
  "Recorded on the sender's machine. Files show where they sit in the sender's repository; they cannot be opened here.";

export interface ShareableContextOptions {
  /** The repository root a file sits in, or `undefined` when it is in none. */
  repoRootOf?: (filePath: string) => string | undefined;
  /** Run over every name kept, for secret redaction. */
  redact: (text: string) => string;
}

/** An absolute path on either platform, or a home-relative one. */
export const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/;

/** The analysis with every absolute path removed, ready for the file. */
export function shareableContext(analysis: SessionContextAnalysis, options: ShareableContextOptions): SessionContextAnalysis {
  const placed = new Map<string, string | undefined>();
  const repoPathOf = (filePath: string | undefined): string | undefined => {
    if (filePath === undefined || filePath.length === 0 || options.repoRootOf === undefined) {
      return undefined;
    }
    if (!placed.has(filePath)) {
      const root = options.repoRootOf(filePath);
      placed.set(filePath, root !== undefined ? toRepoRelative(root, filePath) : undefined);
    }
    return placed.get(filePath);
  };
  /** A name or reference: repository-relative when it is a path we can place, else no more than a file name. */
  const safeName = (text: string): string => {
    if (!ABSOLUTE_PATH.test(text)) {
      return options.redact(text);
    }
    return options.redact(repoPathOf(text) ?? path.basename(text.replace(/\\/g, '/')));
  };
  const file = (f: ContextFileEntry): ContextFileEntry => {
    const repoPath = repoPathOf(f.filePath);
    return {
      // Outside a repository the label is all that is left, so it becomes the name.
      name: safeName(repoPath !== undefined ? f.name : contextFileLabel(f)),
      ...(repoPath !== undefined ? { repoPath: options.redact(repoPath) } : {}),
      category: f.category,
      status: f.status,
      ...(f.estimatedTokens !== undefined ? { estimatedTokens: f.estimatedTokens } : {}),
      ...(f.charCount !== undefined ? { charCount: f.charCount } : {}),
    };
  };
  const reference = (r: ContextFileReference): ContextFileReference => ({
    sourceFile: safeName(r.sourceFile),
    referencedFile: safeName(r.referencedFile),
    referenceType: r.referenceType,
  });
  const missing = (m: ExpectedMissingFile): ExpectedMissingFile => ({
    name: safeName(m.name),
    referencedBy: m.referencedBy.map(reference),
  });
  const agent = (a: AgentContextAnalysis): AgentContextAnalysis => ({
    agentName: options.redact(a.agentName),
    kind: a.kind,
    loadedFiles: a.loadedFiles.map(file),
    expectedMissing: a.expectedMissing.map(missing),
    totalContextTokens: a.totalContextTokens,
    contextFileTokens: a.contextFileTokens,
    otherContextTokens: a.otherContextTokens,
    oversizedFiles: a.oversizedFiles.map(file),
  });
  return { total: agent(analysis.total), agents: analysis.agents.map(agent) };
}

/** The analysis as the receiving app shows it: the file's own, captioned as the sender's. */
export function importedContext(analysis: SessionContextAnalysis): SessionContextAnalysis {
  return { ...analysis, note: IMPORTED_CONTEXT_NOTE, readOnly: true };
}
