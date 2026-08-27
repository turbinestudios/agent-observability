/**
 * Shared type contracts + pure helpers for the **Copilot (Autonomous)** source —
 * autonomous Copilot CLI agents (e.g. an Azure Container Apps job that remediates
 * an alert) which push their FULL `gen_ai.*` OTLP to a cloud landing spot in the
 * Agent Observability cloud. This extension pulls those raw batches down into a
 * local sink and folds them into the unified views.
 *
 * Unlike the Copilot (Cloud) source (which maps GitHub's bespoke agent-tasks
 * REST/SSE payloads), an autonomous agent emits the SAME OTel schema as local
 * Copilot Chat — so pulled batches flow through the shared `decodeTraceRequest`
 * → {@link ../otel/ingestStore.IngestStore} → {@link ../telemetry/telemetryService.TelemetryService}
 * read stack unchanged, lighting up the detail / context / deviation panels for
 * free. The producing agent's identity rides on OTLP **Resource** attributes
 * (`service.name` / `service.instance.id` / … plus custom `agent.*`), which
 * {@link ../otel/otlpToRows.RESOURCE_ATTR_KEY_PREFIXES} copies onto each span so
 * it survives into the ingest DB.
 *
 * Imports NO `vscode` and no network / heavy dependency, so every consumer stays
 * unit-testable headless.
 */

import type { FailureReason, Result } from '../telemetry/telemetryService';

/** Bumped when the sink's on-disk index shape changes (an older index is discarded). */
export const AGENT_SINK_INDEX_VERSION = 1;
/**
 * Bumped when the raw→rows derivation changes, so a re-pull re-derives the ingest
 * DB from the archived raw OTLP batches. Independent of {@link AGENT_SINK_INDEX_VERSION}.
 */
export const AGENT_PARSER_VERSION = 1;

/**
 * Config surface the puller + source read (satisfied by `Configuration`). Kept
 * narrow so both are unit-testable with a tiny fake.
 */
export interface AgentConfig {
  isCopilotAgentEnabled(): boolean;
  /**
   * Base URL of the cloud landing spot the agent OTLP is pulled from. `undefined`
   * (blank setting) leaves the source inert — nothing is pulled.
   */
  getCopilotAgentEndpoint(): string | undefined;
  /** Poll interval (ms) while no batch arrived on the previous poll. */
  getCopilotAgentIdlePollMs(): number;
  /** Poll interval (ms) right after a poll that pulled new batches (catch up faster). */
  getCopilotAgentActivePollMs(): number;
  /** How long ingested spans + archived raw batches are retained (ms). */
  getCopilotAgentRetentionMs(): number;
  /** Upper bound on batches pulled in one poll (back-pressure against a large backlog). */
  getCopilotAgentMaxSessions(): number;
  /** Repositories hidden from the whole extension; applied by the read stack. */
  getExcludedRepositories?(): ReadonlySet<string>;
}

/** A raw OTLP batch available at the landing spot, from the reader's list call. */
export interface RawOtlpBatchRef {
  /** Opaque, stable batch id (blob name / API id) — also the raw archive basename. */
  id: string;
  /** The producing agent's `service.name`, used to partition the raw archive. */
  service: string;
  /** When the batch landed at the source (epoch ms) — drives the pull watermark. */
  createdAtMs: number;
  /** Batch size in bytes when the listing exposed it (diagnostics only). */
  sizeBytes?: number;
}

/** One archived batch, recorded in the sink index after ingestion. */
export interface AgentBatchIndexEntry {
  batchId: string;
  service: string;
  /** The batch's source landing time (epoch ms) — the watermark basis. */
  createdAtMs: number;
  /** When THIS window ingested it (epoch ms). */
  ingestedAtMs: number;
  /**
   * Spans written from this batch. Recorded even when `0` (an empty or
   * undecodable batch) so a stable-id batch is never re-downloaded.
   */
  spanCount: number;
}

/** Per-poll health of the puller, surfaced by the source when there is no data. */
export interface AgentPullerStatus {
  lastPullAtMs: number;
  firstPullCompleted: boolean;
  /** `ok`, or the taxonomy failure of the last pull. */
  lastOutcome: 'ok' | FailureReason;
  lastErrorMessage?: string;
}

/** The sink's versioned index: pull watermark + puller status + per-batch cache. */
export interface AgentSinkIndex {
  version: number;
  parserVersion: number;
  /** Highest `createdAtMs` already pulled — the list-since cursor. */
  watermarkMs: number;
  puller: AgentPullerStatus;
  batches: Record<string, AgentBatchIndexEntry>;
}

/**
 * Reader over the cloud landing spot — pluggable so tests inject a fake and the
 * transport (dashboard read API vs. a read-scoped blob SAS) can change without
 * touching the puller. Binds no socket at construction; performs NO decode.
 */
export interface AgentBatchReader {
  /** List batches with `createdAtMs > sinceMs`, bounded to the newest `max`. */
  listBatches(sinceMs: number, max: number): Promise<Result<RawOtlpBatchRef[]>>;
  /** Download one batch's raw OTLP/JSON body verbatim (for archive + decode). */
  downloadBatch(ref: RawOtlpBatchRef): Promise<Result<string>>;
}

/** Display label for an agent `service.name`, or a sentinel when absent. */
export function agentServiceLabel(service: string | undefined): string {
  const trimmed = (service ?? '').trim();
  return trimmed.length > 0 ? trimmed : 'unknown-agent';
}
