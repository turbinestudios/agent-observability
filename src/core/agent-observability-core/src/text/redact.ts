/**
 * Secret redaction for text the app QUOTES into something the user may paste
 * elsewhere (the review packet, the hand-off brief).
 *
 * This is a best-effort pattern pass, not a guarantee: it catches the common
 * shapes (vendor tokens, JWTs, authorization headers, secret-looking
 * assignments, private keys, credentials in URLs) and will miss a secret
 * written as prose or in an unfamiliar format. Callers therefore quote little,
 * show a redaction count, and never describe the output as "safe to share".
 *
 * Pure: no node imports, so the renderer can bundle it. Every quantifier is
 * bounded, so no pattern can backtrack badly on hostile input.
 */

export type RedactionKind = 'token' | 'authorization' | 'env-assignment' | 'private-key' | 'url-credentials';

export interface RedactionResult {
  text: string;
  /** How many strings were replaced. */
  redactions: number;
  /** The distinct kinds replaced, in first-seen order. */
  kinds: RedactionKind[];
}

/** How much of a text {@link quoteLine} looks at; the rest is never quoted. */
export const REDACT_SCAN_MAX_CHARS = 4000;

const PLACEHOLDER = (kind: RedactionKind): string => `[REDACTED:${kind}]`;

/** Never re-redact a placeholder: keeps the pass idempotent and the count honest. */
const NOT_REDACTED = '(?!\\[REDACTED:)';
/**
 * The same guard placed BEFORE optional spaces and an optional quote, so the
 * regex engine cannot backtrack around it by giving a space back.
 */
const NOT_REDACTED_AHEAD = '(?!\\s{0,3}["\']?\\[REDACTED:)';

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  /** Builds the replacement; defaults to the bare placeholder. */
  replace?: (...groups: string[]) => string;
}

const SECRET_KEY_WORD =
  '(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CONN(?:ECTION)?_?STR(?:ING)?|CREDENTIAL)';

const RULES: readonly Rule[] = [
  // A PEM private key block; the END line is optional so a block cut short
  // by a cap is still removed.
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,8000}(?:-----END [A-Z ]{0,40}PRIVATE KEY-----)?/g,
  },
  // Authorization headers: the whole value to the end of the line.
  {
    kind: 'authorization',
    pattern: new RegExp(`\\b((?:Proxy-)?Authorization)(\\s{0,3}[:=]${NOT_REDACTED_AHEAD}\\s{0,3})[^\\r\\n]{1,2000}`, 'gi'),
    replace: (_m, name, sep) => `${name}${sep}${PLACEHOLDER('authorization')}`,
  },
  {
    kind: 'authorization',
    pattern: new RegExp(`\\b(Bearer)(\\s{1,3})${NOT_REDACTED}[A-Za-z0-9._~+/=-]{8,2000}`, 'g'),
    replace: (_m, word, sep) => `${word}${sep}${PLACEHOLDER('authorization')}`,
  },
  // scheme://user:password@host
  {
    kind: 'url-credentials',
    pattern: new RegExp(`\\b([a-z][a-z0-9+.-]{1,20}://)${NOT_REDACTED}[^\\s:/@]{1,200}:[^\\s@/]{1,200}@`, 'gi'),
    replace: (_m, scheme) => `${scheme}${PLACEHOLDER('url-credentials')}@`,
  },
  // Vendor token shapes.
  { kind: 'token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g },
  { kind: 'token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g },
  { kind: 'token', pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,255}/g },
  { kind: 'token', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g },
  { kind: 'token', pattern: /\bAIza[0-9A-Za-z_-]{30,60}/g },
  { kind: 'token', pattern: /\bglpat-[A-Za-z0-9_-]{16,255}/g },
  { kind: 'token', pattern: /\bnpm_[A-Za-z0-9]{30,255}\b/g },
  // JSON Web Tokens: header.payload.signature, both parts starting "eyJ".
  { kind: 'token', pattern: /\beyJ[A-Za-z0-9_-]{5,2000}\.eyJ[A-Za-z0-9_-]{5,4000}\.[A-Za-z0-9_-]{0,2000}/g },
  // KEY=VALUE / KEY: VALUE where the key names a secret. The key is kept.
  {
    kind: 'env-assignment',
    pattern: new RegExp(
      `\\b([A-Za-z0-9_.-]{0,40}${SECRET_KEY_WORD}[A-Za-z0-9_]{0,40})(["']?\\s{0,3}[:=]${NOT_REDACTED_AHEAD}\\s{0,3})(["']?)[^\\s"'\`,;]{3,500}\\3`,
      'gi',
    ),
    replace: (_m, key, sep, quote) => `${key}${sep}${quote}${PLACEHOLDER('env-assignment')}${quote}`,
  },
];

/**
 * The pattern rules, in the order they run. A final line-based fallback (a
 * long random-looking run after `=`, `:` or a quote on a line that mentions a
 * key-ish word) is applied after them and is not listed here.
 */
export const REDACTION_RULES: readonly { kind: RedactionKind; pattern: RegExp }[] = RULES;

const KEYISH_LINE = /secret|token|passw|key|credential|auth/i;
const GENERIC_RUN = new RegExp(`([=:"'\`]\\s{0,3})${NOT_REDACTED}([A-Za-z0-9+/_-]{32,512}={0,2})`, 'g');

/** Hex of any case, or mixed-case alphanumerics that do not read like a path. */
function looksRandom(run: string): boolean {
  if (/^[0-9a-fA-F]{32,}$/.test(run)) {
    return true;
  }
  const slashes = run.split('/').length - 1;
  return /[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run) && slashes <= 3;
}

/** Replace every secret-looking string with `[REDACTED:<kind>]`. Idempotent. */
export function redactSecrets(text: string): RedactionResult {
  let redactions = 0;
  const kinds: RedactionKind[] = [];
  const note = (kind: RedactionKind): void => {
    redactions += 1;
    if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  };

  let out = text;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      note(rule.kind);
      const groups = args.filter((a): a is string => typeof a === 'string');
      return rule.replace === undefined ? PLACEHOLDER(rule.kind) : rule.replace(...groups);
    });
  }

  if (KEYISH_LINE.test(out)) {
    out = out
      .split('\n')
      .map((line) => {
        if (!KEYISH_LINE.test(line)) {
          return line;
        }
        GENERIC_RUN.lastIndex = 0;
        return line.replace(GENERIC_RUN, (match: string, lead: string, run: string) => {
          if (!looksRandom(run)) {
            return match;
          }
          note('token');
          return `${lead}${PLACEHOLDER('token')}`;
        });
      })
      .join('\n');
  }

  return { text: out, redactions, kinds };
}

/**
 * One quoted line plus how many strings were replaced in it. See
 * {@link quoteLine}.
 */
export function quoteLineCounted(text: string, maxChars: number): { line: string; redactions: number } {
  let scanned = text;
  if (text.length > REDACT_SCAN_MAX_CHARS) {
    scanned = text.slice(0, REDACT_SCAN_MAX_CHARS);
    // The cap may have cut a token in half so that it no longer matches any
    // rule; drop the trailing partial word rather than risk quoting it.
    const lastBreak = Math.max(scanned.lastIndexOf(' '), scanned.lastIndexOf('\n'), scanned.lastIndexOf('\t'));
    scanned = lastBreak < 0 ? '' : scanned.slice(0, lastBreak);
  }
  const redacted = redactSecrets(scanned);
  const flat = redacted.text.replace(/\s+/g, ' ').trim();
  const limit = Math.max(1, Math.floor(maxChars));
  const cut = text.length > REDACT_SCAN_MAX_CHARS;
  if (flat.length <= limit && !cut) {
    return { line: flat, redactions: redacted.redactions };
  }
  const body = flat.length > limit - 1 ? flat.slice(0, limit - 1) : flat;
  return { line: `${body}…`, redactions: redacted.redactions };
}

/**
 * The ONLY way a builder may emit quoted text: look at no more than
 * {@link REDACT_SCAN_MAX_CHARS}, redact, collapse whitespace to single spaces,
 * then truncate with an ellipsis. Redaction happens BEFORE truncation, because
 * truncating first can cut a token so that it no longer matches.
 */
export function quoteLine(text: string, maxChars: number): string {
  return quoteLineCounted(text, maxChars).line;
}
