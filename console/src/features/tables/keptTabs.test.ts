import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const FEATURES = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What a table's tabs render: their folders, and the History tab, which lives with the detail page. */
const TAB_FOLDERS = ['data', 'schema', 'tables'];
const TAB_FILES = ['detail/TableTab.tsx'];

/**
 * A table's page keeps each tab it has shown while another is on screen (components/TabPanel.tsx),
 * and a key a tab listens for on the document still reaches it there: ⌘↵ would run the Data tab's
 * query from the Schema tab, and `j` step through a row nobody can see. So a key listener on the
 * document or the window, in what the tabs render, asks `useTabShown` first.
 *
 * The rule is per file, like the rules-of-hooks detector beside the Data tab: a file that listens for
 * keys there and never asks whether its tab is shown.
 */
export function unaskedKeyListeners(source: string): string[] {
  if (/\buseTabShown\(\)/.test(source)) return [];
  return source
    .split('\n')
    .flatMap((line, index) =>
      /\b(document|window)\.addEventListener\(\s*['"]key(down|up|press)['"]/.test(line) ? [`line ${index + 1}: ${line.trim()}`] : [],
    );
}

describe('the kept-tab key listener detector', () => {
  it('flags a key listener on the document that never asks', () => {
    const source = ['useEffect(() => {', "  document.addEventListener('keydown', onKeyDown);", '}, []);'].join('\n');
    assert.deepEqual(unaskedKeyListeners(source), ["line 2: document.addEventListener('keydown', onKeyDown);"]);
  });

  it('flags one on the window too', () => {
    assert.equal(unaskedKeyListeners("window.addEventListener('keyup', onKeyUp);").length, 1);
  });

  it('passes a file that asks, and listeners that are not for keys', () => {
    assert.deepEqual(unaskedKeyListeners("const shown = useTabShown();\ndocument.addEventListener('keydown', onKeyDown);"), []);
    assert.deepEqual(unaskedKeyListeners("document.addEventListener('visibilitychange', onChange);"), []);
  });
});

describe('the tabs of a table’s page', () => {
  const files = [
    ...TAB_FOLDERS.flatMap((folder) =>
      readdirSync(join(FEATURES, folder))
        .filter((name) => name.endsWith('.tsx'))
        .map((name) => `${folder}/${name}`),
    ),
    ...TAB_FILES,
  ];

  it('finds components to check', () => {
    assert.ok(files.length > 20);
  });

  for (const file of files) {
    it(`${file} listens for keys on the document only while its tab is shown`, () => {
      const offenders = unaskedKeyListeners(readFileSync(join(FEATURES, file), 'utf8'));
      assert.deepEqual(offenders, [], `key listeners that never ask useTabShown in ${file}:\n  ${offenders.join('\n  ')}`);
    });
  }
});
