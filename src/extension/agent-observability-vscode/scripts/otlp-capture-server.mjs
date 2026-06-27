#!/usr/bin/env node
/**
 * Dev-only THROWAWAY localhost OTLP receiver — to VALIDATE what Copilot's OTLP
 * exporter actually sends (endpoint/path, content-type, gzip, and whether the
 * spans are RICH) BEFORE building the real receiver. Binds 127.0.0.1 only, saves
 * each request body + metadata to a capture dir, and answers 200 so Copilot does
 * not error/retry. Pure Node, no deps. Not shipped (esbuild bundles only
 * src/extension.ts); delete it whenever.
 *
 * Usage: node scripts/otlp-capture-server.mjs [port=4318] [outdir]
 */
import { createServer } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const PORT = Number(process.argv[2] ?? 4318);
const OUTDIR = process.argv[3] ?? path.join(process.cwd(), 'otlp-capture');
mkdirSync(OUTDIR, { recursive: true });

let n = 0;
const handler = (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const enc = String(req.headers['content-encoding'] ?? '').toLowerCase();
    const ct = String(req.headers['content-type'] ?? '');
    let decoded = raw;
    let note = '';
    try {
      if (enc.includes('gzip')) { decoded = gunzipSync(raw); note = ' (gunzip)'; }
      else if (enc.includes('deflate')) { decoded = inflateSync(raw); note = ' (inflate)'; }
    } catch (e) {
      note = ` (decode failed: ${e.message})`;
    }

    const i = n++;
    const base = path.join(OUTDIR, `req-${String(i).padStart(4, '0')}`);
    writeFileSync(base + '.bin', decoded);
    writeFileSync(
      base + '.meta.json',
      JSON.stringify(
        { method: req.method, url: req.url, contentType: ct, contentEncoding: enc, rawBytes: raw.length, decodedBytes: decoded.length },
        null,
        2,
      ),
    );

    let peek;
    if (ct.includes('json')) {
      try { peek = 'JSON keys=' + Object.keys(JSON.parse(decoded.toString('utf8'))).join(','); }
      catch { peek = 'JSON parse FAILED'; }
    } else {
      peek = 'first16=' + decoded.subarray(0, 16).toString('hex') + ' (likely protobuf)';
    }
    console.log(`#${i} ${req.method} ${req.url} | ct=${ct}${note} | ${decoded.length}B | ${peek}`);

    // Minimal OTLP-ish success so the exporter is satisfied.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
};

// Bind BOTH loopback families so it works whether Copilot resolves "localhost"
// to IPv4 (127.0.0.1) or IPv6 (::1). Loopback only — never exposed to the LAN.
function start(host) {
  const srv = createServer(handler);
  srv.on('error', (e) => console.error(`listen ${host}: ${e.message}`));
  srv.listen(PORT, host, () => {
    const shown = host.includes(':') ? `[${host}]` : host;
    console.log(`OTLP capture listening on http://${shown}:${PORT}  (saving to ${OUTDIR})`);
  });
}
start('127.0.0.1');
start('::1');
