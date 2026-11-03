/**
 * How a statement names tables (handbook 20): always with their domain, `<domain>.<dataset>.<table>`.
 * The rules live in `shared/statementNames.ts`, so the browser reads a draft's tables as the server
 * runs it.
 */

export {
  canonicalName,
  namedTables,
  nativeCatalog,
  unqualifiedReferences,
  type TableReference,
} from '../../shared/statementNames.ts';
