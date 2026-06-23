import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sanitizeRepositoryUrl, REPOSITORY_PATTERN } from './repositoryUrl';

/**
 * Privacy-critical sanitizer tests. Every output MUST satisfy the aggregate
 * batch schema `repository` pattern — a credential-bearing remote must not pass.
 */

// Load the canonical pattern straight from the shared schema so this test fails
// if the producer-side pattern ever drifts from the contract.
interface AggregateSchema {
  $defs: { bucket: { properties: { repository: { pattern: string } } } };
}
const schema = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../../schemas/aggregate-batch.schema.json'),
    'utf8',
  ),
) as AggregateSchema;
const SCHEMA_REPO_PATTERN = new RegExp(schema.$defs.bucket.properties.repository.pattern);

describe('sanitizeRepositoryUrl', () => {
  const cases: Array<[string, string | null | undefined, string]> = [
    [
      'strips userinfo + .git from an https token URL',
      'https://x-access-token:ghp_x@github.com/o/r.git',
      'https://github.com/o/r',
    ],
    [
      'strips basic-auth userinfo',
      'https://user:pass@github.com/o/r.git',
      'https://github.com/o/r',
    ],
    ['converts scp-style ssh to https', 'git@github.com:o/r.git', 'https://github.com/o/r'],
    [
      'converts ssh:// url to https',
      'ssh://git@github.com/o/r.git',
      'https://github.com/o/r',
    ],
    [
      'strips query and fragment',
      'https://github.com/o/r?token=x#f',
      'https://github.com/o/r',
    ],
    ['lowercases the host', 'https://GitHub.COM/o/r', 'https://github.com/o/r'],
    ['empty string -> unknown', '', 'unknown'],
    ['null -> unknown', null, 'unknown'],
    ['undefined -> unknown', undefined, 'unknown'],
    ['whitespace -> unknown', '   ', 'unknown'],
    ['garbage -> unknown', 'not a url at all', 'unknown'],
    ['preserves the fixture repo (minus .git)', 'https://github.com/example-org/sample-repo.git', 'https://github.com/example-org/sample-repo'],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      const out = sanitizeRepositoryUrl(input);
      expect(out).toBe(expected);
      // Output must always satisfy BOTH the local copy and the shared schema.
      expect(REPOSITORY_PATTERN.test(out)).toBe(true);
      expect(SCHEMA_REPO_PATTERN.test(out)).toBe(true);
    });
  }

  it('never emits a forbidden character even for hostile input', () => {
    const hostile = [
      'https://x-access-token:ghp_VERYSECRET@github.com/o/r.git?a=b#c',
      'git@gitlab.example.com:group/sub/proj.git',
      'https://user:p@ss@self-hosted.example.com:8443/team/repo.git',
      'HTTPS://EXAMPLE.COM/A/B/',
    ];
    for (const raw of hostile) {
      const out = sanitizeRepositoryUrl(raw);
      expect(out).not.toMatch(/[@?#\s]/);
      expect(SCHEMA_REPO_PATTERN.test(out)).toBe(true);
    }
  });

  it('keeps a custom port', () => {
    expect(sanitizeRepositoryUrl('https://self-hosted.example.com:8443/team/repo.git')).toBe(
      'https://self-hosted.example.com:8443/team/repo',
    );
  });
});
