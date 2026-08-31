import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ContextPlanEdit } from '@agent-observability/core/src/chat/tasks/contextImprovement';

/**
 * Stored Context Improvement Plans — what the user's own AI CLI proposed for a
 * repository's context files, plus everything needed to apply and undo it.
 *
 * A JSON store beside `deep-retros.json` rather than columns in `index.db`,
 * twice over: each plan cost a model call the user explicitly confirmed, and
 * an applied plan holds the ONLY pre-apply backup of the files it changed —
 * losing either to a schema bump would be real damage, and `index.db` is a
 * disposable cache by design.
 *
 * LOCAL-ONLY: plans carry model output about raw repo content, the repo's
 * local path, and file backups. Nothing here may ever touch the aggregate/sync
 * path.
 */

/** Stored plans kept; pruning prefers plans holding no undo state. */
export const MAX_STORED_PLANS = 20;

/** One proposed edit, plus its apply lifecycle. */
export interface StoredPlanEdit extends ContextPlanEdit {
  /** sha256 of the gathered base content — the staleness check for `replace`. */
  baseHash?: string;
  appliedAtMs?: number;
  revertedAtMs?: number;
  /** The file as it was the moment before apply — the undo data. */
  backup?: { content: string; capturedAtMs: number };
}

/** One stored plan. */
export interface StoredContextPlan {
  id: string;
  repository: string;
  /** The checkout the plan was generated from. LOCAL-ONLY absolute path. */
  repoRoot: string;
  createdAtMs: number;
  backendId: string;
  backendLabel: string;
  vendor: string;
  model: string;
  /** What the user selected — the plan's provenance. */
  selection: {
    hotspotFiles: string[];
    sessions: { source: string; sessionId: string; title?: string }[];
  };
  narrative: string;
  summary?: string;
  invalidEditCount: number;
  edits: StoredPlanEdit[];
  /** Every file gathered at generation time, hashed for staleness checks. */
  gathered: { path: string; baseHash: string; truncated: boolean }[];
}

export class ContextPlanStore {
  private plans: StoredContextPlan[];

  constructor(private readonly file: string = resolveContextPlansPath()) {
    this.plans = read(this.file);
  }

  get(id: string): StoredContextPlan | undefined {
    return this.plans.find((plan) => plan.id === id);
  }

  /** Newest first, optionally narrowed to one repository. */
  list(repository?: string): StoredContextPlan[] {
    const scoped =
      repository === undefined || repository.length === 0
        ? this.plans
        : this.plans.filter((plan) => plan.repository === repository);
    return [...scoped].sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  /** Add a plan, pruning beyond the cap — see {@link prunable} for the order. */
  add(plan: StoredContextPlan): void {
    const next = [...this.plans, plan];
    while (next.length > MAX_STORED_PLANS) {
      const victim = prunable(next);
      if (victim === undefined) {
        break; // every plan holds undo state; keep them all rather than orphan a backup
      }
      next.splice(next.indexOf(victim), 1);
    }
    this.plans = next;
    write(this.file, next);
  }

  /** Persist a mutation made through {@link get} — apply/undo lifecycle updates. */
  flush(): void {
    write(this.file, this.plans);
  }
}

/**
 * The oldest plan holding no live undo state. A plan with an applied,
 * un-reverted edit is never pruned ahead of one without: its backup is the
 * only way back.
 */
function prunable(plans: readonly StoredContextPlan[]): StoredContextPlan | undefined {
  const holdsUndo = (plan: StoredContextPlan): boolean =>
    plan.edits.some((edit) => edit.appliedAtMs !== undefined && edit.revertedAtMs === undefined);
  const candidates = plans.filter((plan) => !holdsUndo(plan));
  if (candidates.length === 0) {
    return undefined;
  }
  return candidates.reduce((oldest, plan) => (plan.createdAtMs < oldest.createdAtMs ? plan : oldest));
}

export function resolveContextPlansPath(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'context-plans.json');
}

function read(file: string): StoredContextPlan[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) {
      return [];
    }
    // Keep only entries with the minimal valid shape, so a truncated or
    // hand-edited file degrades to "fewer plans" rather than a broken view.
    return parsed.filter(
      (value): value is StoredContextPlan =>
        value !== null &&
        typeof value === 'object' &&
        typeof (value as StoredContextPlan).id === 'string' &&
        typeof (value as StoredContextPlan).repository === 'string' &&
        typeof (value as StoredContextPlan).repoRoot === 'string' &&
        typeof (value as StoredContextPlan).createdAtMs === 'number' &&
        typeof (value as StoredContextPlan).narrative === 'string' &&
        Array.isArray((value as StoredContextPlan).edits) &&
        Array.isArray((value as StoredContextPlan).gathered),
    );
  } catch {
    return []; // absent on first run, or unreadable
  }
}

function write(file: string, plans: readonly StoredContextPlan[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(plans, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
