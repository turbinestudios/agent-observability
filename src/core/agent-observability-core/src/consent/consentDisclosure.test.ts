import { describe, it, expect } from 'vitest';
import {
  WHAT_IS_SHARED,
  WHAT_IS_NOT_SHARED,
  DISCLOSURE_SUMMARY,
  consentModalDetail,
} from './consentDisclosure';

/**
 * The consent disclosure is the user-facing privacy promise. These assertions
 * lock the copy so a refactor cannot silently weaken it — every forbidden
 * category from aggregate-payload-schema-v1.md §7 must remain explicitly named
 * as NOT shared, and the shared statement must stay scoped to aggregate measures.
 */
describe('consent disclosure copy', () => {
  it('names the not-shared categories from the forbidden-fields list', () => {
    const lower = WHAT_IS_NOT_SHARED.toLowerCase();
    expect(lower).toContain('prompt');
    expect(lower).toContain('response');
    expect(lower).toContain('file content');
    expect(lower).toContain('file path');
    expect(lower).toContain('email');
    expect(lower).toContain('identity');
  });

  it('describes shared data as aggregate measures under a pseudonymous id', () => {
    const lower = WHAT_IS_SHARED.toLowerCase();
    expect(lower).toContain('30-minute');
    expect(lower).toContain('pseudonymous');
    expect(lower).toMatch(/count|token|latency/);
  });

  it('the condensed summary contains both halves', () => {
    expect(DISCLOSURE_SUMMARY).toContain(WHAT_IS_SHARED);
    expect(DISCLOSURE_SUMMARY).toContain(WHAT_IS_NOT_SHARED);
  });

  it('the modal detail states both shared and not-shared and reflects direction', () => {
    const on = consentModalDetail(true);
    expect(on).toContain(WHAT_IS_SHARED);
    expect(on).toContain(WHAT_IS_NOT_SHARED);
    expect(on.toLowerCase()).toContain('enable');

    const off = consentModalDetail(false);
    expect(off).toContain(WHAT_IS_NOT_SHARED);
    expect(off.toLowerCase()).toContain('disable');
  });
});
