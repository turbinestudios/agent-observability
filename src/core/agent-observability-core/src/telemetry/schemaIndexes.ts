/**
 * Indexes the READ layer needs that Copilot's own schema does not define.
 *
 * Kept here — driver-free, one string — because two unrelated places have to
 * apply the same DDL and must not drift: the writer that owns the durable
 * archive ({@link ../otel/ingestStore.IngestStore}) creates them once so they
 * persist, and the read path creates them on its private snapshot copy
 * ({@link ./database.ensureSnapshotIndexes}) for the sources it is not allowed
 * to write — Copilot's own `agent-traces.db`.
 *
 * Every statement must be `IF NOT EXISTS`: both callers run this on every open,
 * so it doubles as the migration for databases written before it shipped.
 */

/**
 * `span_attributes` is declared `PRIMARY KEY (span_id, key)`, so its only index
 * is on that pair — leading with `span_id`. A lookup BY KEY alone therefore has
 * no usable index and SQLite plans a full table scan (`SCAN a`).
 *
 * That table is where all the bulk lives: the raw prompts, tool definitions and
 * system instructions. In a real archive it is ~1.6 GB across ~300k rows, so a
 * single "find the rows with this key" scan drags most of the file through the
 * WASM driver. Three read-layer queries do exactly that, and two of them run on
 * the FIRST query against a fresh handle, which is why opening the first
 * Copilot session used to take minutes while later ones took seconds:
 *
 *   - {@link ./repositoryResolver.RepositoryResolver.fromDatabase} — 8.9 s → 38 ms
 *   - `TelemetryDatabase.agentModesBySession`                      — 2.0 s → 16 ms
 *   - `TelemetryDatabase.contentBySpan` (twice per session opened)
 *
 * Building it costs ~2 s once on a 1.6 GB archive and adds ~10 MB.
 */
export const SPAN_ATTRIBUTES_KEY_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_span_attributes_key ON span_attributes(key);';

/** Every read-layer index, as one idempotent script. */
export const READ_INDEX_DDL = SPAN_ATTRIBUTES_KEY_INDEX;
