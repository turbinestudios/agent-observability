/**
 * Pure helpers to pull a fenced code block out of model output.
 *
 * The assistant is instructed to emit configuration inside a single fenced block
 * tagged `ao-workflows` / `ao-config`; these helpers locate that block (falling
 * back to a plain ```json``` block, then to the first block) so a slightly
 * off-spec response still yields usable JSON. No `vscode` import.
 */

/** One fenced code block: its info string (lowercased) and raw body. */
export interface FencedBlock {
  lang: string;
  body: string;
}

/** Parse every fenced (``` ```) code block in `text`, in order. */
export function parseFencedBlocks(text: string): FencedBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: FencedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^\s*```+\s*(.*)$/.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    const lang = open[1].trim().toLowerCase();
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    if (i < lines.length) {
      i++; // consume the closing fence
    }
    blocks.push({ lang, body: body.join('\n').trim() });
  }
  return blocks;
}

/**
 * Extract the body of the most appropriate fenced block. Tries each preferred
 * language tag in order, then any `json` block, then the first block of any kind.
 * Returns `undefined` when there are no fenced blocks at all.
 */
export function extractFencedBlock(text: string, preferredLangs: readonly string[]): string | undefined {
  const blocks = parseFencedBlocks(text);
  if (blocks.length === 0) {
    return undefined;
  }
  for (const lang of [...preferredLangs, 'json']) {
    const match = blocks.find((b) => b.lang === lang.toLowerCase());
    if (match) {
      return match.body;
    }
  }
  return blocks[0].body;
}
