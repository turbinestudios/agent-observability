/**
 * Resolves cross-references between context files to detect "expected but missing"
 * files. For each loaded context file, reads the file from disk (if available) and
 * scans for references to other context files (file paths, names, YAML refs,
 * `<file>` tags in SKILL.md files).
 *
 * Falls back to scanning the system_instructions text when the file isn't on disk.
 *
 * LOCAL-ONLY: disk reads and reference detection are on-machine only.
 */

import * as fs from 'node:fs';
import type { ContextFileEntry, ContextFileReference, ReferenceType } from './models';

/**
 * Detect references between context files by reading their content.
 *
 * @param loadedFiles - Files that were loaded into context
 * @param systemInstructionsText - Optional fallback: the system_instructions content
 * @returns Cross-references found between files
 */
export function resolveReferences(
  loadedFiles: readonly ContextFileEntry[],
  systemInstructionsText?: string,
): ContextFileReference[] {
  const references: ContextFileReference[] = [];
  const allKnownNames = new Set(loadedFiles.map((f) => f.name));

  for (const file of loadedFiles) {
    if (file.status === 'skipped') continue; // Skipped files aren't in context

    let content: string | undefined;

    // Try reading from disk first
    if (file.filePath) {
      content = readFileSafe(file.filePath);
    }

    // If no content from disk, try to find it in system_instructions
    if (!content && systemInstructionsText) {
      content = extractFileContentFromSystemInstructions(file.name, systemInstructionsText);
    }

    if (!content) continue;

    // Scan for references
    const found = scanForReferences(file.name, content, allKnownNames);
    references.push(...found);
  }

  return references;
}

/**
 * Scan file content for references to other context files.
 */
function scanForReferences(
  sourceFile: string,
  content: string,
  allKnownNames: ReadonlySet<string>,
): ContextFileReference[] {
  const refs: ContextFileReference[] = [];
  const foundTargets = new Set<string>();

  // 1. File path references: look for paths to known context file patterns
  const pathPatterns = [
    // Markdown links: [text](path/to/file.instructions.md)
    /\[([^\]]*)\]\(([^)]+\.(?:instructions|prompt|agent)\.md)\)/gi,
    // Bare paths with context-file extensions
    /(?:^|[\s"'`(])((?:[\w./-]+\/)?[\w.-]+\.(?:instructions|prompt|agent)\.md)(?=$|[\s"'`)])/gm,
    // SKILL.md file tags: <file>path/to/SKILL.md</file>
    /<file>([^<]+)<\/file>/gi,
    // References to .github/instructions/, .copilot/instructions/ etc.
    /(?:\.github|\.copilot|\.claude|\.agents)\/(?:instructions|skills|agents|hooks|prompts)\/([^\s"'`),]+)/gi,
  ];

  for (const pattern of pathPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      // Get the path portion (last capture group)
      const refPath = match[match.length - 1];
      const refName = extractReferenceName(refPath);
      if (refName && refName !== sourceFile && !foundTargets.has(refName)) {
        foundTargets.add(refName);
        refs.push({
          sourceFile,
          referencedFile: refName,
          referenceType: 'file-path' as ReferenceType,
        });
      }
    }
  }

  // 2. Name references: look for known context file names mentioned in content
  for (const knownName of allKnownNames) {
    if (knownName === sourceFile) continue;
    if (foundTargets.has(knownName)) continue;

    // Look for the name (without extension) mentioned in the content
    const baseName = knownName.replace(/\.(instructions|prompt|agent|skill)\.md$/i, '');
    if (baseName.length >= 4 && content.includes(baseName)) {
      foundTargets.add(knownName);
      refs.push({
        sourceFile,
        referencedFile: knownName,
        referenceType: 'name-ref',
      });
    }
  }

  // 3. YAML frontmatter references field
  const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (yamlMatch) {
    const yaml = yamlMatch[1];
    // Look for references/imports fields
    const refFieldMatch = yaml.match(/(?:references|imports|requires):\s*\n((?:\s+-\s+.+\n?)*)/);
    if (refFieldMatch) {
      const items = refFieldMatch[1].match(/^\s+-\s+(.+)/gm);
      if (items) {
        for (const item of items) {
          const refName = item.replace(/^\s+-\s+/, '').trim();
          if (refName && refName !== sourceFile && !foundTargets.has(refName)) {
            foundTargets.add(refName);
            refs.push({
              sourceFile,
              referencedFile: refName,
              referenceType: 'yaml-ref',
            });
          }
        }
      }
    }
  }

  return refs;
}

/**
 * Extract a context file name from a path reference.
 */
function extractReferenceName(refPath: string): string | undefined {
  const normalized = refPath.replace(/\\/g, '/').trim();
  const segments = normalized.split('/');
  const fileName = segments[segments.length - 1];
  if (!fileName) return undefined;
  // Only consider actual context file names
  if (
    fileName.endsWith('.instructions.md') ||
    fileName.endsWith('.prompt.md') ||
    fileName.endsWith('.agent.md') ||
    fileName.toLowerCase() === 'skill.md' ||
    fileName.toLowerCase() === 'copilot-instructions.md' ||
    fileName.toLowerCase() === 'claude.md'
  ) {
    return fileName;
  }
  return fileName;
}

/**
 * Try to extract a specific file's content from the concatenated system_instructions text.
 * This is a best-effort heuristic — it looks for the file name as a section marker.
 */
function extractFileContentFromSystemInstructions(
  fileName: string,
  systemInstructions: string,
): string | undefined {
  // Look for common patterns that might delimit files in system_instructions
  const baseName = fileName.replace(/\.md$/i, '');
  const patterns = [
    // XML-like tags: <instruction name="...">content</instruction>
    new RegExp(`<[^>]*${escapeRegex(baseName)}[^>]*>([\\s\\S]*?)<\\/`, 'i'),
    // Markdown header with file name
    new RegExp(`#+\\s*${escapeRegex(baseName)}[^\\n]*\\n([\\s\\S]*?)(?=\\n#+\\s|$)`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = systemInstructions.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}

/** Safely read a file from disk, returning undefined on any error. */
function readFileSafe(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
