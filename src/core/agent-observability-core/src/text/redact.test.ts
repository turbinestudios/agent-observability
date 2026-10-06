import { describe, expect, it } from 'vitest';
import { REDACTION_RULES, REDACT_SCAN_MAX_CHARS, quoteLine, quoteLineCounted, redactSecrets } from './redact';

/** Fixture secrets are assembled at runtime so no scanner flags this file. */
const A = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0';
const ghp = `ghp_${A.slice(0, 36)}`;
const jwt = `eyJ${'hbGciOiJIUzI1NiJ9'}.eyJ${'zdWIiOiIxMjM0NTY3ODkwIn0'}.${A.slice(0, 20)}`;

describe('redactSecrets', () => {
  const rows: [string, string, string, string][] = [
    ['GitHub token', `push with ${ghp} now`, ghp, 'token'],
    ['fine-grained PAT', `x github_pat_${A} y`, `github_pat_${A}`, 'token'],
    ['OpenAI-style key', `key sk-${A.slice(0, 30)}`, `sk-${A.slice(0, 30)}`, 'token'],
    ['Anthropic-style key', `sk-ant-${A.slice(0, 30)}`, `sk-ant-${A.slice(0, 30)}`, 'token'],
    ['AWS access key id', 'id AKIAIOSFODNN7EXAMPLE end', 'AKIAIOSFODNN7EXAMPLE', 'token'],
    ['Slack token', `xoxb-${'1234567890-abcdefghij'}`, 'xoxb-1234567890-abcdefghij', 'token'],
    ['Google API key', `AIza${A.slice(0, 35)}`, `AIza${A.slice(0, 35)}`, 'token'],
    ['GitLab PAT', `glpat-${A.slice(0, 20)}`, `glpat-${A.slice(0, 20)}`, 'token'],
    ['npm token', `npm_${A.slice(0, 36)}`, `npm_${A.slice(0, 36)}`, 'token'],
    ['JWT', `cookie ${jwt}`, jwt, 'token'],
    ['Authorization header', 'curl -H "Authorization: Basic dXNlcjpwYXNz"', 'dXNlcjpwYXNz', 'authorization'],
    ['Proxy-Authorization header', 'Proxy-Authorization: Digest abc123xyz', 'abc123xyz', 'authorization'],
    ['Bearer token', `use Bearer ${A.slice(0, 24)} here`, A.slice(0, 24), 'authorization'],
    ['env assignment', 'DB_PASSWORD=hunter2hunter2', 'hunter2hunter2', 'env-assignment'],
    ['quoted JSON assignment', '{"apiKey": "s3cr3tValue99"}', 's3cr3tValue99', 'env-assignment'],
    ['connection string key', 'CONNECTION_STRING: Server=db;x', 'Server=db', 'env-assignment'],
    ['URL credentials', 'git clone https://bob:p4ssw0rd@example.com/r.git', 'p4ssw0rd', 'url-credentials'],
  ];

  it.each(rows)('replaces a %s', (_name, input, secret, kind) => {
    const result = redactSecrets(input);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(`[REDACTED:${kind}]`);
    expect(result.redactions).toBeGreaterThan(0);
    expect(result.kinds).toContain(kind);
  });

  it('removes a private key block, terminated or cut short', () => {
    const body = `${A}\n${A}\n`;
    const whole = `before\n-----BEGIN RSA PRIVATE KEY-----\n${body}-----END RSA PRIVATE KEY-----\nafter`;
    const cut = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`;
    expect(redactSecrets(whole).text).toBe('before\n[REDACTED:private-key]\nafter');
    expect(redactSecrets(cut).text).not.toContain(A);
  });

  it('keeps the key of an assignment and the scheme and host of a URL', () => {
    expect(redactSecrets('API_KEY=abcdef123456').text).toBe('API_KEY=[REDACTED:env-assignment]');
    expect(redactSecrets('postgres://u:pw@db.internal:5432/app').text).toBe(
      'postgres://[REDACTED:url-credentials]@db.internal:5432/app',
    );
  });

  it('falls back to a long random-looking run on a line that mentions a key-ish word', () => {
    const hex = '0123456789abcdef0123456789abcdef0123';
    expect(redactSecrets(`signing key is "${hex}"`).text).toBe('signing key is "[REDACTED:token]"');
    // The same run on a line with no key-ish word is left alone (a commit hash, say).
    expect(redactSecrets(`commit: ${hex}`).text).toBe(`commit: ${hex}`);
    // A long lowercase path after "key:" is not random-looking.
    const path = 'docs/architecture/aggregate-payload-schema-notes';
    expect(redactSecrets(`cache key: ${path}`).text).toBe(`cache key: ${path}`);
  });

  it('is idempotent, and a second pass counts nothing', () => {
    const input = `GH_TOKEN=${ghp}\nAuthorization: Bearer ${A}\nurl https://a:b@h.io\npassword: "longenough"`;
    const once = redactSecrets(input);
    const twice = redactSecrets(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.redactions).toBe(0);
    expect(once.text).not.toContain(ghp);
  });

  it('leaves ordinary prose and code untouched', () => {
    const prose =
      'Refactor the parser so the task-runner handles empty input, then run npm test.\n' +
      'See src/core/index.ts line 42; the risk-assessment note explains why.';
    const result = redactSecrets(prose);
    expect(result.text).toBe(prose);
    expect(result.redactions).toBe(0);
    expect(result.kinds).toEqual([]);
  });

  it('completes on a very large input', () => {
    const big = `${'lorem ipsum dolor sit amet '.repeat(8000)}${ghp}`;
    expect(big.length).toBeGreaterThan(200_000);
    expect(redactSecrets(big).text.endsWith('[REDACTED:token]')).toBe(true);
  });

  it('exposes its rules for documentation', () => {
    expect(REDACTION_RULES.length).toBeGreaterThan(10);
    expect(REDACTION_RULES.every((rule) => rule.pattern instanceof RegExp)).toBe(true);
  });
});

describe('quoteLine', () => {
  it('redacts, collapses whitespace and truncates with an ellipsis', () => {
    const line = quoteLine(`  fix   the\n\tbug using ${ghp}  please and then some more words `, 40);
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith('…')).toBe(true);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('  ');
    expect(line).not.toContain('ghp_');
    expect(quoteLine('short  text', 40)).toBe('short text');
  });

  it('redacts before truncating, so a token straddling the cut is gone', () => {
    const text = `deploy with ${ghp} to prod`;
    const cutInsideToken = 'deploy with '.length + 10;
    const line = quoteLine(text, cutInsideToken);
    expect(line).not.toContain('ghp_');
    expect(line.startsWith('deploy with [REDACTED')).toBe(true);
  });

  it('drops a token cut in half by the scan cap, even when little else survives', () => {
    const padding = ' '.repeat(REDACT_SCAN_MAX_CHARS - 12);
    const text = `note${padding}${ghp} trailing words`;
    const line = quoteLine(text, 200);
    expect(line).not.toContain('ghp_');
    expect(line).toBe('note…');
  });

  it('caps a 200 KB input and reports the redaction count', () => {
    const big = `token=${A} ${'word '.repeat(50_000)}`;
    const result = quoteLineCounted(big, 140);
    expect(result.line.length).toBeLessThanOrEqual(140);
    expect(result.redactions).toBe(1);
    expect(result.line).not.toContain(A);
  });
});
