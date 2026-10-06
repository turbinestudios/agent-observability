import { describe, expect, it } from 'vitest';
import { commandOutcome, isVerificationClass } from '../analysis/sessionActivity';
import { ClaudeCodeService, ClaudeServiceConfig } from './claudeCodeService';

/**
 * Opt-in smoke check over THIS machine's real Claude Code sessions. Skipped by
 * default, because a test must never depend on the machine that runs it; run
 * with `AO_REAL_CLAUDE=1` to see the completion check hold up on real
 * transcripts. Asserts only that it does not throw and yields a known status,
 * and prints counts per status — never any session content.
 */
const enabled = process.env.AO_REAL_CLAUDE === '1';
const KNOWN = ['verified', 'unverified', 'contradicted', 'incomplete', 'not-applicable'];

describe.skipIf(!enabled)('completion check over real sessions (opt-in)', () => {
  it(
    'yields a known status for each of the most recent sessions',
    () => {
      const config: ClaudeServiceConfig = {
        isClaudeEnabled: () => true,
        getClaudeProjectsPathOverride: () => undefined,
        getClaudeScanDepth: () => 4,
        getClaudeMaxSessions: () => 40,
        getCodeFileExtensions: () => [],
        getDocFileExtensions: () => ['.md', '.mdx', '.markdown', '.rst', '.txt', '.adoc', '.asciidoc'],
        getExcludedRepositories: () => new Set<string>(),
      };
      const service = new ClaudeCodeService(config);
      const sessions = service.listSessions(undefined, 40);
      expect(sessions.ok).toBe(true);
      const counts: Record<string, number> = {};
      // Counts only: how verification commands were masked, and how each
      // masked form resolved. Never command text, output, paths or prompts.
      const masking: Record<string, number> = {};
      const bump = (key: string): void => {
        masking[key] = (masking[key] ?? 0) + 1;
      };
      let claimedDone = 0;
      if (sessions.ok) {
        for (const summary of sessions.value) {
          const activity = service.getSessionActivity(summary.sessionId);
          if (activity.ok) {
            for (const command of activity.value.commands) {
              if (!isVerificationClass(command.class)) {
                continue;
              }
              bump('verification');
              const outcome = commandOutcome(command);
              if (command.background) {
                bump(`background:${outcome}`);
              } else if (command.resultMasked) {
                bump('masked');
                bump(`${command.maskedBy ?? 'masked'}:${outcome}`);
              } else {
                bump(`unmasked:${outcome}`);
              }
            }
          }
          const retro = service.getSessionRetrospective(summary.sessionId);
          if (!retro.ok) {
            counts.unreadable = (counts.unreadable ?? 0) + 1;
            continue;
          }
          const status = retro.value.completion?.status ?? 'absent';
          if (status === 'unverified' && activity.ok) {
            // Why: no check after the last edit, or a check whose result could not be read.
            const ranAfterEdit = retro.value.completion?.checks.find((c) => c.id === 'verification-after-last-edit')?.passed === true;
            const checks = activity.value.commands.filter((c) => isVerificationClass(c.class)).sort((a, b) => a.order - b.order);
            const last = checks[checks.length - 1];
            bump(
              !ranAfterEdit || last === undefined
                ? 'unverified:no-check-after-last-edit'
                : `unverified:last-check-unreadable:${last.class}:${last.background ? 'background' : (last.maskedBy ?? 'unmasked')}`,
            );
          }
          expect([...KNOWN, 'absent']).toContain(status);
          counts[status] = (counts[status] ?? 0) + 1;
          if (retro.value.completion?.claim === 'done') {
            claimedDone += 1;
          }
        }
      }
      service.dispose();
      console.log(`completion smoke: ${JSON.stringify(counts)} claimedDone=${claimedDone}`);
      console.log(`completion smoke masking: ${JSON.stringify(masking)}`);
    },
    300_000,
  );
});
