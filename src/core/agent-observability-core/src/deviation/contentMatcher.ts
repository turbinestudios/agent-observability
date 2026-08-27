import { ContentPredicate } from './models';

/**
 * Local-only matcher for a {@link ContentPredicate} against a single raw
 * `span_attributes` value.
 *
 * PRIVACY: this module returns ONLY a boolean. The caller passes raw content in
 * and never gets it back, so the matched text can never leak into a
 * {@link ./models.WorkflowDeviation}. It imports neither `vscode` nor the
 * database, so it stays pure and unit-testable.
 *
 * ReDoS / catastrophic-backtracking strategy (the plan's "linear-time subset"):
 * JavaScript's `RegExp` exposes no execution-step limit and cannot be interrupted
 * mid-match on this synchronous path, so rather than try to time out a running
 * match we restrict `matches` to a CONSERVATIVE STATIC SUBSET that excludes the
 * known catastrophic-backtracking shapes, and reject anything outside it:
 *   1. INPUT CAP — `contains` values are truncated to {@link MAX_CONTENT_LENGTH}
 *      (10,000); `matches` (regex) input is truncated to the much tighter
 *      {@link MAX_REGEX_INPUT_LENGTH} (1,000), which bounds the n in any residual
 *      polynomial backtracking to ~100ms even for patterns the static guard misses.
 *   2. PATTERN CAP — sources longer than {@link MAX_PATTERN_LENGTH} are rejected.
 *   3. STATIC REJECTION ({@link hasDangerousQuantifiedGroup}) — a group under a
 *      REPETITION quantifier (`*`, `+`, `{m,}`, or `{m,n}`/`{m}` with max >= 2) is
 *      rejected when its body contains EITHER (a) a VARIABLE-count quantifier —
 *      unbounded `*`/`+`/`{m,}` or variable-bounded `{m,n}` (n > m) — (the `(a+)+`,
 *      `(.*a){20}`, `(a{1,2}){1,2}` shapes, including arbitrarily deep nesting
 *      such as `(((a{1,2}){1,2}){1,2})`) OR (b) an alternation `|` (the ambiguous
 *      shapes `(a|a)*` / `(a|aa)+`). An EXACT `{m}` body (e.g. `(a{2}){2}`) is
 *      deterministic and allowed. To keep the subset SAFE rather than clever, ALL
 *      alternation under a repetition is rejected, including disjoint ones like
 *      `(a|b)+`; rewrite those as a character class (`[ab]+`), which is allowed.
 *   4. ADJACENT-QUANTIFIER REJECTION ({@link hasAdjacentRedundantVariableQuantifier})
 *      — the GROUP-FREE polynomial family `a*a*`, `\d*\d*\d*`, `.*.*`,
 *      `[a-z]*[a-z]*` (adjacent IDENTICAL atoms each variable-quantified) is
 *      rejected; (3) only inspects quantified group bodies and would miss these.
 *   5. SUBSTRING PREFERENCE — `contains` (a linear `String.includes`) is always
 *      preferred over `matches`, so the regex engine is only used when a regex is
 *      explicitly requested.
 * A pattern that fails any guard (or fails to compile) is treated as a non-match
 * rather than throwing, so a malformed config degrades gracefully. The subset is
 * conservative but not provably complete — NON-identical overlapping quantifiers
 * (adjacent like `\d*\w*`, or separated like `.*x.*y$`) are not statically
 * detected. They are only POLYNOMIAL, and the tight regex input cap
 * ({@link MAX_REGEX_INPUT_LENGTH}) bounds the common 2–3 quantifier cases to
 * ~100ms; a deeply overlapping pattern (e.g. 4+ ordered `.*` segments) may still
 * stall for a few seconds, but always TERMINATES. `matches` is operator-authored
 * config (not remote input) evaluated locally on a one-time panel render, and
 * statically dangerous (exponential) patterns are also rejected at config parse
 * time ({@link ../config/workflowParsing}) before reaching this synchronous path.
 */

/** Maximum characters fed to a `contains` match (linear, ReDoS-free). */
export const MAX_CONTENT_LENGTH = 10_000;

/**
 * Maximum characters fed to a `matches` (regex) match — much smaller than
 * {@link MAX_CONTENT_LENGTH}. The static guards reject the EXPONENTIAL and
 * adjacent-identical families, but POLYNOMIAL backtracking from overlapping
 * quantifiers (e.g. `\d*\w*$`, `.*x.*y$`) cannot be detected structurally without
 * a linear-time engine. Capping the regex input length bounds that residual cost:
 * a near-cubic pattern over 1,000 chars completes in ~100ms, versus tens of
 * seconds over 10,000. `contains` keeps the full window since it cannot backtrack.
 */
export const MAX_REGEX_INPUT_LENGTH = 1_000;

/** Maximum accepted regex source length; longer patterns are rejected. */
export const MAX_PATTERN_LENGTH = 1_000;

/**
 * Evaluate a content predicate against a raw attribute value.
 *
 * Truncates the value (to {@link MAX_CONTENT_LENGTH} for `contains`, to the
 * tighter {@link MAX_REGEX_INPUT_LENGTH} for `matches`), applies `contains`
 * (preferred) or `matches`, then `negate`. A predicate with neither `contains`
 * nor `matches` never matches (config parsing rejects that case, so this is only
 * a defensive floor). Returns the inverted result when `negate === true`.
 */
export function matchesContent(value: string, predicate: ContentPredicate): boolean {
  const outcome = evaluate(value, predicate);
  return predicate.negate === true ? !outcome : outcome;
}

/** The raw (pre-negation) match outcome. */
function evaluate(value: string, predicate: ContentPredicate): boolean {
  // `contains` is preferred: a linear substring scan with no ReDoS surface.
  if (predicate.contains !== undefined) {
    const text = value.length > MAX_CONTENT_LENGTH ? value.slice(0, MAX_CONTENT_LENGTH) : value;
    return text.toLowerCase().includes(predicate.contains.toLowerCase());
  }
  if (predicate.matches !== undefined) {
    // Tighter cap bounds polynomial backtracking the static guard cannot detect.
    const text =
      value.length > MAX_REGEX_INPUT_LENGTH ? value.slice(0, MAX_REGEX_INPUT_LENGTH) : value;
    return safeRegexTest(predicate.matches, text);
  }
  return false;
}

/**
 * Compile `pattern` if it is non-empty, within the length cap, outside the
 * dangerous static subset, and valid; otherwise return `undefined`. Never throws.
 * Exposed so config parsing can reject a dangerous/invalid `matches` up front.
 */
export function compileSafeRegex(pattern: string): RegExp | undefined {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    return undefined;
  }
  if (hasDangerousQuantifiedGroup(pattern) || hasAdjacentRedundantVariableQuantifier(pattern)) {
    return undefined;
  }
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

/**
 * Whether `pattern` is a non-empty, compilable regex within the safe static
 * subset (see the module header). Used at config parse time to drop a dangerous
 * or invalid `matches` so it never reaches the synchronous match path.
 */
export function isSafeRegexSource(pattern: string): boolean {
  return compileSafeRegex(pattern) !== undefined;
}

/**
 * Compile and run `pattern` against `text` under the ReDoS guards. Returns
 * `false` (never throws) when the pattern is empty, too long, structurally
 * dangerous, or fails to compile.
 */
export function safeRegexTest(pattern: string, text: string): boolean {
  const regex = compileSafeRegex(pattern);
  if (regex === undefined) {
    return false;
  }
  try {
    return regex.test(text);
  } catch {
    return false;
  }
}

/**
 * Detect a catastrophic-backtracking shape: a group under a REPETITION quantifier
 * (`*`, `+`, `{m,}`, or `{m,n}`/`{m}` with max >= 2) whose body contains either an
 * VARIABLE-count quantifier — unbounded `*`/`+`/`{m,}` OR variable-bounded `{m,n}`
 * (n>m) — (`(a+)+`, `(a*)*`, `(.+)+`, `([a-z]+)*`, `((x)+)+`, `(.*a){20}`,
 * `(a{1,2}){1,2}`, deeply nested `(((a{1,2}){1,2}){1,2})`) or an alternation
 * (`(a|a)*`, `(a|aa)+`, `(?:a|aa)+`, and — to keep the subset safe rather than
 * clever — disjoint ones like `(a|b)+`). An EXACT `{m}`/`{m,m}` body is not
 * ambiguous and is allowed (`(a{2}){2}` is deterministic). Conservative and
 * linear: escapes and `[...]` character classes are skipped so their contents are
 * treated as literals.
 */
function hasDangerousQuantifiedGroup(pattern: string): boolean {
  const groupStart: number[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (c === ']') {
        inClass = false;
      }
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') {
      groupStart.push(i);
      continue;
    }
    if (c === ')') {
      const start = groupStart.pop();
      if (start === undefined) {
        continue; // unbalanced — new RegExp will reject it anyway
      }
      if (isRepeatQuantifierAt(pattern, i + 1)) {
        const body = pattern.slice(start + 1, i);
        if (containsVariableRepeat(body) || containsAlternation(body)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Does a quantifier that can repeat its atom 2+ times start at `idx`? That is
 * `*`, `+`, `{m,}` (unbounded), or `{m,n}`/`{m}` whose max bound is >= 2. A `?`,
 * `{0,1}`, `{1}`, or `{1,1}` is NOT a repetition (cannot drive backtracking).
 */
function isRepeatQuantifierAt(pattern: string, idx: number): boolean {
  const c = pattern[idx];
  if (c === '*' || c === '+') {
    return true;
  }
  if (c === '{') {
    const close = pattern.indexOf('}', idx);
    if (close === -1) {
      return false;
    }
    const inner = pattern.slice(idx + 1, close);
    const m = /^(\d+)(?:,(\d*))?$/.exec(inner);
    if (m === null) {
      return false;
    }
    if (inner.includes(',')) {
      // `{m,}` (open upper bound) repeats; `{m,n}` repeats iff n >= 2.
      const max = m[2];
      return max === undefined || max === '' ? true : Number(max) >= 2;
    }
    // `{m}` repeats iff m >= 2.
    return Number(m[1]) >= 2;
  }
  return false;
}

/**
 * Does a VARIABLE-count `{...}` quantifier start at `idx` (i.e. `pattern[idx]`
 * is `{`)? Variable means the atom may match a RANGE of counts — `{m,}` (open
 * upper bound) or `{m,n}` with n>m — which is what lets a repeated body drive
 * backtracking. An EXACT `{m}` or `{m,m}` matches a fixed count and is NOT
 * variable, so it is safe even when nested under a repetition.
 */
function isVariableBraceQuantifierAt(pattern: string, idx: number): boolean {
  const close = pattern.indexOf('}', idx);
  if (close === -1) {
    return false;
  }
  const inner = pattern.slice(idx + 1, close);
  const m = /^(\d+)(?:,(\d*))?$/.exec(inner);
  if (m === null) {
    return false;
  }
  if (!inner.includes(',')) {
    return false; // `{m}` — exact count.
  }
  const max = m[2];
  // `{m,}` (open upper bound) is variable; `{m,n}` is variable iff n > m.
  return max === undefined || max === '' ? true : Number(max) > Number(m[1]);
}

/** Does `body` contain a top-or-nested alternation `|` (outside a char class)? */
function containsAlternation(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') {
        inClass = false;
      }
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '|') {
      return true;
    }
  }
  return false;
}

/**
 * Does `body` contain a VARIABLE-count repetition (outside a character class)?
 * That is `*`, `+`, or a variable `{...}` (`{m,}` or `{m,n}` with n>m). Such a
 * repetition inside a repeated group is what drives catastrophic backtracking;
 * an exact `{m}` is not variable and does not.
 */
function containsVariableRepeat(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') {
        inClass = false;
      }
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '*' || c === '+') {
      return true;
    }
    if (c === '{' && isVariableBraceQuantifierAt(body, i)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect adjacent REDUNDANT variable-count quantifiers over the SAME atom — the
 * GROUPLESS polynomial-backtracking family `a*a*`, `a*a*a*`, `\d*\d*\d*\d*`,
 * `[a-z]*[a-z]*`, `.*.*` (and their `+` / `{m,n}` variants). {@link
 * hasDangerousQuantifiedGroup} only inspects quantified GROUP bodies, so these
 * group-free shapes need their own check: two consecutive atoms with IDENTICAL
 * source text, each variable-count quantified, can partition the same run of
 * input combinatorially → O(n^k) backtracking when an anchor/suffix later fails.
 *
 * Restricting to TEXTUALLY IDENTICAL adjacent atoms keeps this near-zero false
 * positive — `a*a*` is always redundant (≡ `a*`) so no legitimate pattern uses
 * it, while disjoint neighbours like `\w+\s+` (different atoms) are NOT flagged.
 * Recurses into group bodies so `(a*a*)` is caught too. Linear-time.
 */
function hasAdjacentRedundantVariableQuantifier(pattern: string): boolean {
  let prevText: string | undefined;
  let prevVariable = false;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    let atomText: string;
    let atomEnd: number;
    if (c === '\\') {
      atomText = pattern.slice(i, i + 2);
      atomEnd = Math.min(i + 2, pattern.length);
    } else if (c === '[') {
      atomEnd = charClassEnd(pattern, i);
      atomText = pattern.slice(i, atomEnd);
    } else if (c === '(') {
      atomEnd = groupEnd(pattern, i);
      // Recurse into the group body (strip the outer parens).
      if (hasAdjacentRedundantVariableQuantifier(pattern.slice(i + 1, Math.max(i + 1, atomEnd - 1)))) {
        return true;
      }
      atomText = pattern.slice(i, atomEnd);
    } else if (c === '|' || c === '^' || c === '$' || c === ')') {
      // Alternation / anchor breaks adjacency.
      prevText = undefined;
      prevVariable = false;
      i++;
      continue;
    } else {
      atomText = c;
      atomEnd = i + 1;
    }

    const q = variableQuantifierAt(pattern, atomEnd);
    if (prevText !== undefined && q.variable && prevVariable && prevText === atomText) {
      return true;
    }
    prevText = atomText;
    prevVariable = q.variable;
    i = q.end;
  }
  return false;
}

/** Index just past the `]` closing a char class that starts at `open`. */
function charClassEnd(s: string, open: number): number {
  let j = open + 1;
  if (s[j] === '^') {
    j++;
  }
  if (s[j] === ']') {
    j++; // a `]` as the first class member is a literal
  }
  while (j < s.length && s[j] !== ']') {
    if (s[j] === '\\') {
      j++;
    }
    j++;
  }
  return j < s.length ? j + 1 : s.length;
}

/** Index just past the `)` matching the group that starts at `open`. */
function groupEnd(s: string, open: number): number {
  let depth = 0;
  let inClass = false;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (inClass) {
      if (c === ']') {
        inClass = false;
      }
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) {
        return j + 1;
      }
    }
  }
  return s.length;
}

/**
 * Inspect a possible quantifier at `idx`. Returns whether it is VARIABLE-count
 * (`*`, `+`, `{m,}`, or `{m,n}` with n>m — not `?`, `{m}`, or `{m,m}`) and the
 * index just past it (including a trailing lazy `?`). When `idx` is not a
 * quantifier, `variable` is false and `end === idx`.
 */
function variableQuantifierAt(s: string, idx: number): { variable: boolean; end: number } {
  const c = s[idx];
  let end: number;
  let variable: boolean;
  if (c === '*' || c === '+') {
    end = idx + 1;
    variable = true;
  } else if (c === '?') {
    end = idx + 1;
    variable = false;
  } else if (c === '{') {
    const close = s.indexOf('}', idx);
    if (close === -1 || !/^\d+(?:,\d*)?$/.test(s.slice(idx + 1, close))) {
      return { variable: false, end: idx }; // a literal `{`
    }
    end = close + 1;
    variable = isVariableBraceQuantifierAt(s, idx);
  } else {
    return { variable: false, end: idx };
  }
  if (s[end] === '?') {
    end++; // lazy suffix
  }
  return { variable, end };
}
