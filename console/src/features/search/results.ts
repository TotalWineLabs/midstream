import type { SearchResult } from '@shared/types';

import { domainPath, tablePath } from '../../lib/paths.ts';

/** Where a result opens: in its domain, a materialization's page, a table's page, a dataset's page. */
export function resultPath(result: SearchResult): string {
  switch (result.kind) {
    case 'materialization':
      return domainPath(result.domain, `/materializations/${encodeURIComponent(result.id)}`);
    case 'table': {
      // `<dataset>.<table>`: a dataset's name has no dot.
      const dot = result.id.indexOf('.');
      return domainPath(result.domain, tablePath(result.id.slice(0, dot), result.id.slice(dot + 1)));
    }
    case 'dataset':
      return domainPath(result.domain, `/datasets/${encodeURIComponent(result.id)}`);
  }
}
