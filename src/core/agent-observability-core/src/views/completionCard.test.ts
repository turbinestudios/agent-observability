import { describe, expect, it } from 'vitest';
import { decideCompletion, type CompletionEvidence } from '../analysis/completionCheck';
import { COMPLETION_CARD_FOOTER, renderCompletionCard } from './sessionDetailHtml';

function evidence(over: Partial<CompletionEvidence> = {}): CompletionEvidence {
  return {
    sourceComplete: true,
    codeEditCalls: 2,
    docEditCalls: 0,
    filesEdited: 1,
    lastEditTurnIndex: 1,
    verifyRuns: 0,
    verifyFailures: 0,
    verifyUnknownResult: 0,
    verifiedAfterLastEdit: false,
    lastVerifyFailed: false,
    lastVerifyResultKnown: false,
    endedOnFailedTool: false,
    trailingFailedTools: 0,
    claim: 'done',
    admitsSkippedChecks: false,
    filesOutsideRepo: 0,
    filesNeverReadBack: 0,
    ...over,
  };
}

describe('renderCompletionCard', () => {
  it('renders nothing when there is no check or it does not apply', () => {
    expect(renderCompletionCard(undefined)).toBe('');
    expect(renderCompletionCard(decideCompletion(evidence({ codeEditCalls: 0, filesEdited: 0 })))).toBe('');
    expect(renderCompletionCard(decideCompletion(evidence({ sourceComplete: false })))).toBe('');
  });

  it('labels an unverified session, states the claim, and always carries the limits footer', () => {
    const html = renderCompletionCard(decideCompletion(evidence()));
    expect(html).toContain('Not verified');
    expect(html).toContain('The last reply reported the work as done.');
    expect(html).toContain(COMPLETION_CARD_FOOTER.replace(/'/g, '&#39;').split('(')[0].trim().slice(0, 30));
    expect(html).toContain('completion-unverified');
  });

  it('labels verified, check-failed and unfinished sessions and links evidence turns', () => {
    const verified = renderCompletionCard(
      decideCompletion(
        evidence({ verifyRuns: 1, verifiedAfterLastEdit: true, lastVerifyResultKnown: true, lastVerifyClass: 'test', lastVerifyTurnIndex: 2 }),
      ),
    );
    expect(verified).toContain('Verified');
    expect(verified).toContain('data-turn="t');

    const failed = renderCompletionCard(
      decideCompletion(
        evidence({
          verifyRuns: 1,
          verifyFailures: 1,
          verifiedAfterLastEdit: true,
          lastVerifyFailed: true,
          lastVerifyResultKnown: true,
          lastVerifyClass: 'test',
          lastVerifyTurnIndex: 2,
        }),
      ),
    );
    expect(failed).toContain('Check failed');

    const unfinished = renderCompletionCard(decideCompletion(evidence({ claim: 'partial' })));
    expect(unfinished).toContain('Left unfinished');
    expect(unfinished).toContain('The last reply said work remained.');
  });
});
