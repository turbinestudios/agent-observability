import type { ShardProblem, TeamShard } from './teamShardModels';

/**
 * Fold the shard files found in a team folder into one member → shard map.
 *
 * The folder is the source of truth: nothing is cached on the importer's
 * side, so a removed file removes its member on the next read. A file whose
 * name does not match the id inside it is never merged — otherwise one member
 * could overwrite another's slot by renaming a file — and is reported so the
 * view can say so. Two files for one id (several folders, or a caller's test
 * fixtures) resolve to the newest `generatedAt`; the loser is simply older
 * news and is dropped without a notice.
 */
export interface ParsedShardFile {
  fileName: string;
  shard: TeamShard;
  fileBytes?: number;
}

export interface MergedTeam {
  members: Map<string, TeamShard>;
  problems: ShardProblem[];
}

export function mergeShards(files: readonly ParsedShardFile[]): MergedTeam {
  const members = new Map<string, TeamShard>();
  const problems: ShardProblem[] = [];
  for (const file of files) {
    const id = file.shard.pseudonymousDeveloperId;
    if (file.fileName !== `${id}.json`) {
      problems.push({
        fileName: file.fileName,
        reason: 'id-mismatch',
        detail: 'The file name does not match the anonymous id inside it.',
      });
      continue;
    }
    const current = members.get(id);
    if (current === undefined || generatedAtMs(file.shard) >= generatedAtMs(current)) {
      members.set(id, file.shard);
    }
  }
  return { members, problems };
}

/** `generatedAt` as epoch ms; an unparsable value sorts as the oldest possible. */
export function generatedAtMs(shard: TeamShard): number {
  const parsed = Date.parse(shard.generatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}
