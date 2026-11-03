/**
 * The lake as Explore's Tables rail shows it (docs/design/explore.md §4.3, §6.3): every domain, its
 * datasets, their tables - each with the state of the materialization writing it, and what the
 * person may do with it. Built from what the page already holds: the live fleet, for which
 * materialization writes a table and how it is, and each domain's datasets, for names, locks and ids.
 *
 * No React: tested as plain functions.
 */

// With their extensions, so `node --test` loads them without the bundler.
import { itemStatus, type Status } from '../../lib/status.ts';
import { matchName, searchTerms } from '../../lib/nameSearch.ts';
import type { Fleet, DomainMaterialization } from '../../lib/fleetMerge.ts';
import type { ConsoleDomain, CpDataset, DomainFleet, TableRef } from '@shared/types';

export interface LakeTable {
  /** `domain.dataset.table`, lowercase: as SQL compares names. */
  key: string;
  ref: TableRef;
  domainName: string;
  datasetId: string;
  /** The materialization writing it; null for one the fleet does not list as written: kept, or being created. */
  materializationId: string | null;
  /** Its materialization's state; null when that is not known. */
  status: Status | null;
  topic: string | null;
  /** The person may query its dataset. */
  queryable: boolean;
  /** And may see the materialization writing it, which browsing reads for its schema and tail. */
  browsable: boolean;
  /** Its dataset is locked to the person: they see its name, not its schema or data. */
  locked: boolean;
}

export interface LakeDataset {
  key: string;
  domain: string;
  id: string;
  name: string;
  description: string;
  locked: boolean;
  tables: LakeTable[];
}

export interface LakeDomain {
  id: string;
  name: string;
  config: ConsoleDomain;
  /** Whether the person may see its tables now: `ok`, else why not. */
  access: DomainFleet['access'];
  datasets: LakeDataset[];
  /** Its fleet or datasets have not answered yet. */
  loading: boolean;
}

/** One domain's datasets, as far as its read has got. */
export interface DatasetsRead {
  data: CpDataset[] | undefined;
  /** The read was refused or failed; its status when it was an answer. */
  failed: number | null;
  loading: boolean;
}

export interface LakeInput {
  domains: readonly ConsoleDomain[];
  fleet: Fleet | null;
  datasets: Readonly<Record<string, DatasetsRead | undefined>>;
  /** Whether the person holds a permission in a domain - on a dataset, for a dataset permission. */
  can: (domain: string, permission: string, datasetId?: string | null) => boolean;
}

const byName = (left: { name: string }, right: { name: string }): number => left.name.localeCompare(right.name);

/** The lake, domain by domain in the registry's order, datasets and tables by name. */
export function buildLake({ domains, fleet, datasets, can }: LakeInput): LakeDomain[] {
  return domains
    .filter((domain) => domain.status !== 'misconfigured')
    .map((domain): LakeDomain => {
      const entry = fleet?.domains.find((candidate) => candidate.domain === domain.id) ?? null;
      const items = fleet?.items.filter((item) => item.domain === domain.id && item.desired_phase !== 'deleted') ?? [];
      // Which materialization writes each table, as SQL names it in its domain.
      const writers = new Map<string, { item: DomainMaterialization; topic: string | null }>();
      for (const item of items) {
        item.tables.forEach((name, index) => writers.set(name.toLowerCase(), { item, topic: item.source_topics[index] ?? null }));
      }
      const read = datasets[domain.id];
      const seesDetails = can(domain.id, 'materializations.view_details');
      const table = (dataset: { id: string; name: string; locked: boolean }, name: string): LakeTable => {
        const writer = writers.get(`${dataset.name}.${name}`.toLowerCase()) ?? null;
        const queryable = !dataset.locked && (dataset.id ? can(domain.id, 'data.query', dataset.id) : can(domain.id, 'data.query'));
        return {
          key: `${domain.id}.${dataset.name}.${name}`.toLowerCase(),
          ref: { domain: domain.id, dataset: dataset.name, table: name },
          domainName: domain.name,
          datasetId: dataset.id,
          materializationId: writer?.item.materialization_id ?? null,
          status: writer ? itemStatus(writer.item) : null,
          topic: writer?.topic ?? null,
          queryable,
          browsable: queryable && seesDetails,
          locked: dataset.locked,
        };
      };

      let lakeDatasets: LakeDataset[];
      if (read?.data) {
        lakeDatasets = read.data.map((dataset) => {
          const place = { id: dataset.dataset_id, name: dataset.name, locked: dataset.locked };
          // The dataset's own list, and any written table the fleet knows that it does not name yet.
          const names = new Set(dataset.tables);
          for (const key of writers.keys()) if (key.startsWith(`${dataset.name.toLowerCase()}.`)) names.add(key.slice(dataset.name.length + 1));
          return {
            key: `${domain.id}.${dataset.name}`.toLowerCase(),
            domain: domain.id,
            id: dataset.dataset_id,
            name: dataset.name,
            description: dataset.description,
            locked: dataset.locked,
            tables: [...names].map((name) => table(place, name)).sort((left, right) => left.ref.table.localeCompare(right.ref.table)),
          };
        });
      } else {
        // Without its datasets - the person may not see them there - the fleet still says what is written.
        const grouped = new Map<string, string[]>();
        for (const key of writers.keys()) {
          const dot = key.indexOf('.');
          grouped.set(key.slice(0, dot), [...(grouped.get(key.slice(0, dot)) ?? []), key.slice(dot + 1)]);
        }
        lakeDatasets = [...grouped].map(([name, tables]) => ({
          key: `${domain.id}.${name}`,
          domain: domain.id,
          id: '',
          name,
          description: '',
          locked: false,
          tables: tables.map((entry) => table({ id: '', name, locked: false }, entry)).sort((left, right) => left.ref.table.localeCompare(right.ref.table)),
        }));
      }
      lakeDatasets.sort(byName);

      const access: DomainFleet['access'] = entry?.access ?? (read?.failed === 401 ? 'sign_in_required' : read?.failed === 403 ? 'forbidden' : 'ok');
      return {
        id: domain.id,
        name: domain.name,
        config: domain,
        access: read?.data ? 'ok' : access,
        datasets: lakeDatasets,
        loading: (fleet === null || (read?.loading ?? false)) && lakeDatasets.length === 0,
      };
    });
}

/** Every table of the lake, domain by domain. */
export function lakeTables(lake: readonly LakeDomain[]): LakeTable[] {
  return lake.flatMap((domain) => domain.datasets.flatMap((dataset) => dataset.tables));
}

export interface TableMatch {
  table: LakeTable;
  /** The name it matched by, as shown: `dataset.table`, or `domain.dataset.table` with several domains. */
  shown: string;
  /** Ranges of `shown` that matched, for emphasis. */
  ranges: Array<[number, number]>;
}

/**
 * Tables matching a search, best first: every term must appear in the name as shown, and an exact
 * name, a name starting with a term, then a term starting a part (`sales.orders`, `order_items`) rank
 * ahead of a plain substring; shorter names break ties. A blank query matches every table.
 */
export function searchLake(lake: readonly LakeDomain[], query: string, options: { qualified: boolean; limit?: number }): TableMatch[] {
  const terms = searchTerms(query);
  const shownName = (table: LakeTable): string => (options.qualified ? `${table.ref.domain}.${table.ref.dataset}.${table.ref.table}` : `${table.ref.dataset}.${table.ref.table}`);
  const scored: Array<TableMatch & { score: number; order: number }> = [];
  lakeTables(lake).forEach((table, order) => {
    const shown = shownName(table);
    if (terms.length === 0) {
      scored.push({ table, shown, ranges: [], score: 0, order });
      return;
    }
    const match = matchName(shown.toLowerCase(), terms);
    if (match) scored.push({ table, shown, ranges: match.ranges, score: match.score, order });
  });
  scored.sort((left, right) => left.score - right.score || left.shown.length - right.shown.length || left.order - right.order);
  return scored.slice(0, options.limit ?? scored.length).map(({ table, shown, ranges }) => ({ table, shown, ranges }));
}

/** A table of the lake by reference, as SQL compares names. */
export function findTable(lake: readonly LakeDomain[], ref: TableRef | null): LakeTable | null {
  if (!ref) return null;
  const key = `${ref.domain}.${ref.dataset}.${ref.table}`.toLowerCase();
  return lakeTables(lake).find((table) => table.key === key) ?? null;
}
