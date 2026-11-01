import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = join(HERE, 'design-baseline.json');

/**
 * The design language's rules that a script can check (docs/10-design-system.md), over every source
 * file of the client.
 *
 * The repository runs no linter, so this is the narrow substitute, as `hooks.test.ts` is for hooks:
 * each rule is a pattern for something the design language never uses in new code. What a script
 * cannot judge — one question per screen, plain words, Current only for flowing or live things —
 * is the `console-design` skill's checklist (`.claude/skills/console-design/SKILL.md`).
 *
 * Screens built before the design language still break some rules. Their counts are the baseline
 * (`design-baseline.json`), per rule and file, and the baseline only goes down: a file may not gain
 * a violation, a file not in it may have none, and a fix lowers it in the same change —
 * `DESIGN_BASELINE=lower node --test src/design.test.ts` rewrites it, lowering and never raising.
 * A deliberate exception is added to the baseline by hand, where review sees it.
 */
export interface DesignRule {
  id: string;
  /** What is wrong, and what to use instead: the message a failure prints. */
  fix: string;
  pattern: RegExp;
  /** Files the rule does not apply to: the one place a thing legitimately lives. */
  exempt?: readonly string[];
}

export const DESIGN_RULES: readonly DesignRule[] = [
  {
    id: 'literal-colour',
    fix: 'Use a token from src/styles.css (§10.3), never a literal colour.',
    pattern: /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b|\b(?:rgba?|hsla?)\(\s*\d/g,
  },
  {
    id: 'palette-class',
    fix: 'Use a token class, text-[var(--color-ink-muted)], never a Tailwind palette class such as text-gray-500 or bg-white (§10.11).',
    pattern:
      /\b(?:text|bg|border|ring|fill|stroke|from|to|via|outline|divide|decoration|shadow|placeholder|caret|accent)-(?:(?:red|green|blue|emerald|amber|yellow|orange|purple|violet|gray|slate|zinc|neutral|stone|sky|teal|cyan|rose|pink|indigo|lime|fuchsia)-\d{2,3}|white|black)\b/g,
  },
  {
    id: 'legacy-token',
    fix: 'Use the Current names (§10.3): --color-ink for what was the accent, and a state through statusOf and components/Status.tsx, never --color-accent or --color-phase-*.',
    pattern: /--color-(?:accent-soft|accent|phase-[a-z]+)\b/g,
  },
  {
    id: 'motion-outside-vocabulary',
    fix: 'Motion comes from §10.7: Shimmer for work under way, Skeleton for loading, StatusGlyph for a state, Ticker for a number — never animate-pulse, -spin, -ping or -bounce.',
    pattern: /\banimate-(?:pulse|spin|ping|bounce)\b/g,
  },
  {
    id: 'all-caps',
    fix: 'Sentence case for every label, title and button (§10.4): no uppercase.',
    pattern: /\buppercase\b|textTransform:\s*['"]uppercase/g,
  },
  {
    id: 'state-colour-badge',
    fix: "A state's colour is for a state (§10.3): draw a state with StatusPill or StatusLabel, and any other label with a neutral Badge.",
    pattern: /<Badge\b[^>]*\btone="(?:running|pending|paused|failed)"|\btone:\s*'(?:running|pending|paused|failed)'/g,
  },
  {
    id: 'live-dot-on-a-page',
    fix: 'Liveness is said by what moves (§10.7): a page has no live dot; the shell says when the link is down.',
    pattern: /\bLiveIndicator\b/g,
    exempt: ['components/AppShell.tsx'],
  },
];

/**
 * The source with its comments blanked — newlines kept, so line numbers hold — so a comment about
 * a rule never breaks it. Strings are left alone: `'http://…'` is not a comment.
 */
export function withoutComments(source: string): string {
  let out = '';
  let index = 0;
  let quote: string | null = null;
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (quote) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

export interface Violation {
  rule: string;
  line: number;
  text: string;
}

/** Every place `source` breaks a rule, with its line. `file` is relative to `src`, for exemptions. */
export function findViolations(source: string, file: string, rules: readonly DesignRule[] = DESIGN_RULES): Violation[] {
  const code = withoutComments(source);
  const lines = source.split('\n');
  const found: Violation[] = [];
  for (const rule of rules) {
    if (rule.exempt?.includes(file)) continue;
    for (const match of code.matchAll(rule.pattern)) {
      const line = code.slice(0, match.index).split('\n').length;
      found.push({ rule: rule.id, line, text: (lines[line - 1] ?? '').trim().slice(0, 140) });
    }
  }
  return found;
}

/** Counts per rule, per file: the shape of the baseline. */
export type Counts = Record<string, Record<string, number>>;

export function countViolations(files: ReadonlyMap<string, string>): { counts: Counts; violations: Map<string, Violation[]> } {
  const counts: Counts = Object.fromEntries(DESIGN_RULES.map((rule) => [rule.id, {}]));
  const violations = new Map<string, Violation[]>();
  for (const [file, source] of files) {
    const found = findViolations(source, file);
    if (found.length === 0) continue;
    violations.set(file, found);
    for (const violation of found) {
      const perFile = counts[violation.rule] as Record<string, number>;
      perFile[file] = (perFile[file] ?? 0) + 1;
    }
  }
  return { counts, violations };
}

/** What differs from the baseline: files gaining violations, and counts the baseline holds too high. */
export function compareToBaseline(counts: Counts, baseline: Counts): { over: string[]; stale: string[] } {
  const over: string[] = [];
  const stale: string[] = [];
  for (const rule of DESIGN_RULES) {
    const now = counts[rule.id] ?? {};
    const allowed = baseline[rule.id] ?? {};
    for (const [file, count] of Object.entries(now)) {
      const limit = allowed[file] ?? 0;
      if (count > limit) over.push(`${rule.id} in ${file}: ${count}, the baseline allows ${limit}`);
    }
    for (const [file, limit] of Object.entries(allowed)) {
      const count = now[file] ?? 0;
      if (count < limit) stale.push(`${rule.id} in ${file}: ${count}, the baseline still allows ${limit}`);
    }
  }
  return { over, stale };
}

/** The baseline lowered to `counts` wherever they are lower: never raised, never given a new entry. */
export function lowered(baseline: Counts, counts: Counts): Counts {
  const next: Counts = {};
  for (const rule of DESIGN_RULES) {
    const entries: Record<string, number> = {};
    for (const [file, limit] of Object.entries(baseline[rule.id] ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const count = Math.min(limit, counts[rule.id]?.[file] ?? 0);
      if (count > 0) entries[file] = count;
    }
    next[rule.id] = entries;
  }
  return next;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the design rules', () => {
  const flagged = (source: string, file = 'features/x/X.tsx'): string[] => findViolations(source, file).map((violation) => violation.rule);

  it('flag what the design language never uses', () => {
    assert.deepEqual(flagged(`<p className="text-gray-500 bg-white">`), ['palette-class', 'palette-class']);
    assert.deepEqual(flagged(`<span style={{ color: '#3ef0c5' }} className="bg-[#fff]" />`), ['literal-colour', 'literal-colour']);
    assert.deepEqual(flagged(`ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';`), ['literal-colour']);
    assert.deepEqual(flagged(`<a className="text-[var(--color-accent)] bg-[var(--color-phase-running)]">`), ['legacy-token', 'legacy-token']);
    assert.deepEqual(flagged(`<Loader2 className="size-3 animate-spin" />`), ['motion-outside-vocabulary']);
    assert.deepEqual(flagged(`<h3 className="text-[11px] uppercase tracking-wide">`), ['all-caps']);
    assert.deepEqual(flagged(`<Badge tone="running">append</Badge>`), ['state-colour-badge']);
    assert.deepEqual(flagged(`const STATES = { active: { label: 'written', tone: 'running' } };`), ['state-colour-badge']);
    assert.deepEqual(flagged(`import { LiveIndicator } from '@/components/AppShell';`), ['live-dot-on-a-page']);
  });

  it('pass what it uses', () => {
    assert.deepEqual(flagged(`<p className="text-[var(--color-ink-muted)] bg-[var(--color-raised)]">`), []);
    assert.deepEqual(flagged(`<Badge tone="neutral">kept</Badge> <Badge>current</Badge>`), []);
    assert.deepEqual(flagged(`sql({ dialect: PostgreSQL, upperCaseKeywords: true })`), []);
    assert.deepEqual(flagged(`ctx.strokeStyle = \`rgba(\${r},\${g},\${b},\${a})\`;`), [], 'a colour composed from tokens at run time');
    assert.deepEqual(flagged(`const url = 'https://example.com/#/path';`), []);
    assert.deepEqual(flagged(`export function LiveIndicator() {}`, 'components/AppShell.tsx'), [], 'its own home');
  });

  it('ignore comments, keeping line numbers', () => {
    const source = `// never text-gray-500 or #fff\n/* animate-pulse\n uppercase */\nconst a = 1;\n{/* <Badge tone="failed"> */}\n<p className="animate-ping" />`;
    assert.deepEqual(findViolations(source, 'features/x/X.tsx'), [
      { rule: 'motion-outside-vocabulary', line: 6, text: '<p className="animate-ping" />' },
    ]);
  });

  it('lower the baseline and never raise it', () => {
    const rule = DESIGN_RULES[0]?.id as string;
    const baseline: Counts = { [rule]: { 'a.tsx': 3, 'b.tsx': 2, 'gone.tsx': 1 } };
    const counts: Counts = { [rule]: { 'a.tsx': 1, 'b.tsx': 5, 'new.tsx': 4 } };
    assert.deepEqual(lowered(baseline, counts)[rule], { 'a.tsx': 1, 'b.tsx': 2 });
    const { over, stale } = compareToBaseline(counts, baseline);
    assert.equal(over.length, 2, 'b.tsx gained, and new.tsx has violations without a baseline');
    assert.equal(stale.length, 2, 'a.tsx and gone.tsx are lower than the baseline says');
  });
});

describe('the console keeps to its design language', () => {
  const files = new Map(sourceFiles(HERE).map((path) => [relative(HERE, path).split('\\').join('/'), readFileSync(path, 'utf8')]));
  const { counts, violations } = countViolations(files);
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Counts;

  if (process.env.DESIGN_BASELINE === 'lower') {
    writeFileSync(BASELINE_FILE, `${JSON.stringify(lowered(baseline, counts), null, 2)}\n`);
  }
  const current = process.env.DESIGN_BASELINE === 'lower' ? lowered(baseline, counts) : baseline;

  it('finds the source to check', () => {
    assert.ok(files.size > 50);
  });

  it('adds no violation of the design rules', () => {
    const { over } = compareToBaseline(counts, current);
    const detail = over.flatMap((entry) => {
      const [rule, file] = /^(\S+) in (\S+):/.exec(entry)?.slice(1) ?? [];
      const fix = DESIGN_RULES.find((candidate) => candidate.id === rule)?.fix ?? '';
      const lines = (violations.get(file ?? '') ?? []).filter((violation) => violation.rule === rule).map((violation) => `    ${file}:${violation.line}  ${violation.text}`);
      return [`  ${entry}. ${fix}`, ...lines];
    });
    assert.deepEqual(over, [], `New violations of the design language (docs/10-design-system.md):\n${detail.join('\n')}`);
  });

  it('keeps the baseline as low as the code', () => {
    const { stale } = compareToBaseline(counts, current);
    assert.deepEqual(
      stale,
      [],
      `Fewer violations than the baseline allows — lower it so they cannot come back:\n  DESIGN_BASELINE=lower node --test src/design.test.ts\n  ${stale.join('\n  ')}`,
    );
  });
});
