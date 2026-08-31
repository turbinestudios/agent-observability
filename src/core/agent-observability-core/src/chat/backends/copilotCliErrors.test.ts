import { describe, it, expect } from 'vitest';
import { CopilotCliError, describeCopilotCliError } from './copilotCliErrors';
import { CliBackendError } from './cliError';

describe('describeCopilotCliError', () => {
  it('maps a missing binary to the install hint with the host cliPathHint', () => {
    const friendly = describeCopilotCliError(new CopilotCliError('spawn failed', { code: 'ENOENT' }), {
      cliPathHint: 'set the Copilot CLI path in Settings',
    });
    expect(friendly.message).toContain('npm install -g @github/copilot');
    expect(friendly.message).toContain('set the Copilot CLI path in Settings');
    expect(friendly.recoverable).toBe(false);
  });

  it('maps auth failures to sign-in guidance', () => {
    const friendly = describeCopilotCliError(
      new CopilotCliError('failed', { stderrTail: 'error: you are not logged in, run copilot login' }),
    );
    expect(friendly.message).toContain('copilot login');
    expect(friendly.recoverable).toBe(true);
  });

  it('maps quota and rate limits to try-later guidance', () => {
    expect(describeCopilotCliError(new CopilotCliError('http 429')).message).toContain('Try again later');
    expect(describeCopilotCliError(new CopilotCliError('premium credit limit reached')).recoverable).toBe(true);
  });

  it('maps an unknown option to a version problem before anything else', () => {
    const friendly = describeCopilotCliError(new CopilotCliError("unknown option '--stream'"));
    expect(friendly.message).toContain('copilot update');
  });

  it('falls back to the raw detail for anything unrecognized', () => {
    const friendly = describeCopilotCliError(new CopilotCliError('something odd happened'));
    expect(friendly.message).toContain('something odd happened');
    expect(friendly.recoverable).toBe(false);
  });
});

describe('CopilotCliError', () => {
  it('is a CliBackendError, so shared catch sites see both vendors', () => {
    expect(new CopilotCliError('x') instanceof CliBackendError).toBe(true);
  });
});
