#!/usr/bin/env node
/**
 * Dev-only utility — inspect a captured Copilot OTel JSON-lines file to VALIDATE
 * the field mapping BEFORE building live reconstruction. It reports a SAFE
 * inventory (span shapes, operations, attribute KEYS, value types, and a
 * reconstruction-readiness checklist). It NEVER prints raw content values
 * (prompts, completions, tool I/O) — only metadata values and lengths — so the
 * output is safe to paste back.
 *
 * Usage:
 *   node scripts/inspect-otel-capture.mjs <path-to-capture.jsonl>
 *
 * Not part of the shipped extension (esbuild bundles only src/extension.ts);
 * delete it whenever. Pure Node, no dependencies.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/inspect-otel-capture.mjs <capture.jsonl>');
  process.exit(1);
}

/** Attribute keys whose VALUES are raw content — never print them. */
const CONTENT_KEYS = new Set([
  'copilot_chat.user_request',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.tool.definitions',
  'gen_ai.tool.description',
  'copilot_chat.reasoning_content',
  'copilot_chat.hook_input',
  'copilot_chat.hook_output',
  'copilot_chat.hook_command',
  'copilot_chat.request.options',
]);

function decodeAnyValue(v) {
  if (v === null || typeof v !== 'object') return undefined;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (typeof v.intValue === 'number' || typeof v.intValue === 'string') return Number(v.intValue);
  if (typeof v.doubleValue === 'number' || typeof v.doubleValue === 'string') return Number(v.doubleValue);
  return '<complex>';
}

function decodeAttrs(attrs) {
  const out = new Map();
  if (!Array.isArray(attrs)) return out;
  for (const e of attrs) {
    if (e && typeof e === 'object' && typeof e.key === 'string') {
      out.set(e.key, decodeAnyValue(e.value));
    }
  }
  return out;
}

/** Normalize the supported OTLP/JSON shapes into [{ span, resource }]. */
function flatten(parsed) {
  const out = [];
  if (parsed === null || typeof parsed !== 'object') return out;
  const root = parsed;
  const resourceSpans = Array.isArray(root.resourceSpans)
    ? root.resourceSpans
    : root.resource !== undefined || root.scopeSpans !== undefined
      ? [root]
      : undefined;
  if (resourceSpans) {
    for (const rs of resourceSpans) {
      if (!rs || typeof rs !== 'object') continue;
      const resource = decodeAttrs(rs.resource?.attributes);
      const scopeSpans = Array.isArray(rs.scopeSpans)
        ? rs.scopeSpans
        : Array.isArray(rs.instrumentationLibrarySpans)
          ? rs.instrumentationLibrarySpans
          : [];
      for (const ss of scopeSpans) {
        const spans = ss?.spans;
        if (Array.isArray(spans)) for (const sp of spans) out.push({ span: sp, resource });
      }
    }
    return out;
  }
  if (Array.isArray(root.spans)) {
    for (const sp of root.spans) out.push({ span: sp, resource: new Map() });
    return out;
  }
  if (typeof root.name === 'string' || typeof root.spanId === 'string') {
    out.push({ span: root, resource: new Map() });
  }
  return out;
}

/** Collapse volatile span-name suffixes so the name histogram is readable. */
function namePattern(name) {
  return String(name)
    .replace(/^(turn_(?:start|end)):\d+$/, '$1:N')
    .replace(/^(runSubagent)(?:-.+)?$/, '$1-*');
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);

let spanCount = 0;
let parseErrors = 0;
const opCounts = new Map();
const attrKeysByOp = new Map(); // op -> Map<key, count>
const nameCounts = new Map();
const statusCodes = new Map(); // code -> count
let sawStatusField = false;
const idObservations = { conversationId: 0, sessionIdResource: 0, chatSessionId: 0, spawnLike: 0 };
const metaSamples = new Map(); // key -> example metadata value (safe)
const contentKeysSeen = new Set();

for (const line of lines) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    parseErrors++;
    continue;
  }
  for (const { span, resource } of flatten(parsed)) {
    spanCount++;
    const a = decodeAttrs(span.attributes);
    const op = a.get('gen_ai.operation.name') ?? '(none)';
    opCounts.set(op, (opCounts.get(op) ?? 0) + 1);

    const nm = namePattern(span.name ?? '');
    nameCounts.set(nm, (nameCounts.get(nm) ?? 0) + 1);

    // OTLP span status is a TOP-LEVEL field, not an attribute.
    if (span.status && typeof span.status === 'object') {
      sawStatusField = true;
      const code = span.status.code ?? '(unset)';
      statusCodes.set(String(code), (statusCodes.get(String(code)) ?? 0) + 1);
    }

    const conv = a.get('gen_ai.conversation.id') ?? a.get('conversation_id');
    const chat = a.get('chat_session_id');
    const sess = resource.get('session.id');
    if (typeof conv === 'string') idObservations.conversationId++;
    if (typeof sess === 'string') idObservations.sessionIdResource++;
    if (typeof chat === 'string') idObservations.chatSessionId++;
    if (typeof conv === 'string' && typeof chat === 'string' && conv !== chat) idObservations.spawnLike++;

    let keys = attrKeysByOp.get(op);
    if (!keys) {
      keys = new Map();
      attrKeysByOp.set(op, keys);
    }
    for (const [k, v] of a) {
      keys.set(k, (keys.get(k) ?? 0) + 1);
      if (CONTENT_KEYS.has(k)) {
        contentKeysSeen.add(k);
      } else if (!metaSamples.has(k)) {
        const s = typeof v === 'string' ? (v.length > 60 ? v.slice(0, 60) + '…' : v) : v;
        metaSamples.set(k, s);
      }
    }
  }
}

const sortDesc = (m) => [...m.entries()].sort((x, y) => y[1] - x[1]);
const has = (key) => [...attrKeysByOp.values()].some((m) => m.has(key));

console.log(`\n=== OTel capture inspection: ${file} ===`);
console.log(`lines: ${lines.length} | spans: ${spanCount} | parse errors: ${parseErrors}\n`);

console.log('-- operations (gen_ai.operation.name) --');
for (const [op, n] of sortDesc(opCounts)) console.log(`  ${n.toString().padStart(5)}  ${op}`);

console.log('\n-- span names (volatile suffixes collapsed) --');
for (const [nm, n] of sortDesc(nameCounts).slice(0, 25)) console.log(`  ${n.toString().padStart(5)}  ${nm}`);

console.log('\n-- span.status.code distribution (success/failure source) --');
console.log(sawStatusField ? '' : '  (no span.status field seen on any span!)');
for (const [code, n] of sortDesc(statusCodes)) console.log(`  ${n.toString().padStart(5)}  code=${code}`);

console.log('\n-- id observations (turn anchoring) --');
console.log(`  spans w/ gen_ai.conversation.id : ${idObservations.conversationId}`);
console.log(`  spans w/ resource session.id    : ${idObservations.sessionIdResource}`);
console.log(`  spans w/ chat_session_id        : ${idObservations.chatSessionId}`);
console.log(`  spans where conversation!=chat  : ${idObservations.spawnLike}  (spawned sub-agents)`);

console.log('\n-- attribute keys per operation (count) --');
for (const [op, keys] of attrKeysByOp) {
  console.log(`  [${op}]`);
  for (const [k, n] of sortDesc(keys)) {
    const tag = CONTENT_KEYS.has(k) ? '  <content: value hidden>' : '';
    console.log(`      ${n.toString().padStart(5)}  ${k}${tag}`);
  }
}

console.log('\n-- safe metadata sample values --');
for (const [k, v] of [...metaSamples.entries()].sort()) console.log(`  ${k} = ${JSON.stringify(v)}`);

console.log('\n=== reconstruction-readiness checklist ===');
const checks = [
  ['span.status (success/failure)', sawStatusField],
  ['gen_ai.operation.name', has('gen_ai.operation.name')],
  ['gen_ai.agent.name (agentName)', has('gen_ai.agent.name')],
  ['copilot_chat.user_request (anchor content)', contentKeysSeen.has('copilot_chat.user_request')],
  ['gen_ai.conversation.id', has('gen_ai.conversation.id') || has('conversation_id')],
  ['chat_session_id', has('chat_session_id')],
  ['repo attribute (copilot_chat.repo.*)', [...attrKeysByOp.values()].some((m) => [...m.keys()].some((k) => k.startsWith('copilot_chat.repo')))],
  ['turn_start/turn_end markers', [...nameCounts.keys()].some((n) => n.startsWith('turn_'))],
  ['gen_ai.tool.name', has('gen_ai.tool.name')],
  ['gen_ai.usage.input_tokens', has('gen_ai.usage.input_tokens')],
];
for (const [label, ok] of checks) console.log(`  [${ok ? 'OK ' : 'GAP'}] ${label}`);
console.log('');
