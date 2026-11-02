import { Check, ChevronDown, Copy } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { PartitionsPanel } from './PartitionsPanel';
import { ENGINES, snippet, type Engine } from '../detail/connect';
import { readState, useTableDetail } from '../detail/TableTab';
import { PageBody } from '@/components/AppShell';
import { CopyButton } from '@/components/Inline';
import { Panel, SegmentedControl } from '@/components/ui/primitives';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { shortSnapshotId } from '@/lib/format';
import type { CatalogConnection, CpTable, CpTableSpec, DetailSnapshot, TableMetadataView, TableStorage } from '@shared/types';

/**
 * How another engine reads a table, and how it is laid out (docs/11-feature-reference.md §11.10):
 * the catalog and a snippet for each engine; where its data is in time; how engines see it. Read
 * from the table itself, so it works while the runtime is stopped.
 */
export function TableConnect({ snapshot, table }: { snapshot: DetailSnapshot; table: CpTableSpec }): ReactNode {
  const query = useTableDetail(snapshot.materializationId, table.name);
  const state = readState(query, table);
  if (state || !query.data) return state;
  const { record, metadata, connection, storage } = query.data;
  return (
    <PageBody className="space-y-6">
      <ConnectPanel connection={connection} record={record} metadata={metadata} table={table} storage={storage} />
      <PartitionsPanel metadata={metadata} />
      <PropertiesPanel record={record} metadata={metadata} />
    </PageBody>
  );
}

/** One thing to copy, named: a label, the value in full or ellipsed with its tooltip, and a copy button. */
function CopyLine({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <dt className="w-[92px] shrink-0 text-[12px] text-[var(--color-ink-faint)]">{label}</dt>
      <dd className="numeric min-w-0 flex-1 truncate text-[13px]" title={value}>
        {value}
      </dd>
      <CopyButton value={value} label={`Copy the ${label.toLowerCase()}`} className="shrink-0" />
    </div>
  );
}

function ConnectPanel({
  connection,
  record,
  metadata,
  table,
  storage,
}: {
  connection: CatalogConnection | null;
  record: CpTable | null;
  metadata: TableMetadataView | null;
  /** The table, in its dataset: its namespace on the catalog. */
  table: CpTableSpec;
  /** The console's storage profile for its location: what the data-file half of a snippet says. */
  storage: TableStorage | null;
}): ReactNode {
  const { can } = useAuth();
  const [engine, setEngine] = useState<Engine>('duckdb');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  // The catalog lists a dataset's tables to those who may read them through it.
  if (!can('catalog.read', table.dataset_id) || !connection) return null;
  const location = metadata?.location ?? record?.location ?? '<table location>';
  const text = snippet(engine, connection, table.dataset, table.name, location, storage);
  const notes = [
    !connection.enabled ? { tone: 'attention', text: 'The REST catalog is turned off (Settings › Iceberg catalog); engines can still read the table by path.' } : null,
    storage === null
      ? { tone: 'muted', text: 'This console has no storage profile for the table’s location, so the snippet names no endpoint, region or account of its own: add your storage’s where it needs them.' }
      : null,
    !connection.configured
      ? { tone: 'muted', text: 'This is the address the console reaches the control plane at. Engines outside the cluster need the one set in CONTROL_PLANE_CATALOG_BASE_URL.' }
      : null,
  ].filter((note): note is { tone: string; text: string } => note !== null);

  return (
    <Panel className="overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0 max-w-[620px]">
          <h2 className="text-[15px] font-semibold">Connect</h2>
          <p className="mt-1 text-[13px] text-[var(--color-ink-muted)]">
            Any engine that reads Iceberg reads it through the REST catalog — and joins it with any table you may read — with
            an access token from{' '}
            <Link to="/settings/account" className="font-medium text-[var(--color-ink)] hover:underline">
              your account
            </Link>
            .
          </p>
        </div>
        <SegmentedControl value={engine} onChange={setEngine} options={ENGINES} />
      </header>
      <dl className="grid gap-x-8 gap-y-2 border-t border-[var(--color-line)] px-5 py-3 lg:grid-cols-2">
        <CopyLine label="Table" value={`lake.${table.dataset}.${table.name}`} />
        <CopyLine label="Catalog" value={connection.uri} />
      </dl>
      {notes.map((note) => (
        <p
          key={note.text}
          className={cn(
            'border-t border-[var(--color-line)] px-5 py-2.5 text-[12px]',
            note.tone === 'attention' ? 'text-[var(--color-buoy-ink)]' : 'text-[var(--color-ink-muted)]',
          )}
        >
          {note.text}
        </p>
      ))}
      <div className="relative border-t border-[var(--color-line)] bg-[var(--color-raised)]">
        <pre className="numeric overflow-x-auto px-5 py-4 pr-24 text-[12px] leading-relaxed">{text}</pre>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => setCopied(true));
          }}
          className="absolute top-2.5 right-3 inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Panel>
  );
}

/** The settings engines leave to the writer, folded under the rest unless asked for. */
function housekeeping(key: string): boolean {
  return key.startsWith('commit.') || key.startsWith('write.metadata');
}

function PropertiesPanel({ record, metadata }: { record: CpTable | null; metadata: TableMetadataView | null }): ReactNode {
  const [all, setAll] = useState(false);
  const properties = Object.entries(metadata?.properties ?? {});
  const shown = all ? properties : properties.filter(([key]) => !housekeeping(key));
  const facts: Array<[string, string | null, string?]> = [
    ['Identifier', record?.identifier ?? null],
    ['Format', metadata ? `Iceberg v${metadata.formatVersion}` : null],
    ['Schema', metadata ? `schema ${metadata.currentSchemaId}` : record?.schema_id != null ? `schema ${record.schema_id}` : null],
    ['Partition spec', metadata?.partitionSpec ?? null],
    ['Sort order', metadata?.sortOrder ?? null],
    ['Current snapshot', metadata?.currentSnapshotId ? shortSnapshotId(metadata.currentSnapshotId) : null, metadata?.currentSnapshotId ?? undefined],
    ['Table UUID', metadata?.tableUuid ?? record?.table_uuid ?? null],
  ];
  const location = metadata?.location ?? record?.location ?? null;
  const metadataFile = metadata?.metadataLocation ?? record?.metadata_location ?? null;

  return (
    <Panel className="overflow-hidden">
      <header className="px-5 pt-4 pb-3">
        <h2 className="text-[15px] font-semibold">Properties</h2>
        <p className="mt-1 text-[13px] text-[var(--color-ink-muted)]">How engines see it.</p>
      </header>
      <dl className="grid gap-x-8 gap-y-4 border-t border-[var(--color-line)] px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
        {facts.map(([label, value, full]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[12px] text-[var(--color-ink-faint)]">{label}</dt>
            <dd className="numeric mt-0.5 truncate text-[13px]" title={full ?? value ?? undefined}>
              {value ?? '—'}
            </dd>
          </div>
        ))}
      </dl>
      {location || metadataFile ? (
        <dl className="space-y-2 border-t border-[var(--color-line)] px-5 py-3">
          {location ? <CopyLine label="Location" value={location} /> : null}
          {metadataFile ? <CopyLine label="Metadata file" value={metadataFile} /> : null}
        </dl>
      ) : null}
      {properties.length > 0 ? (
        <details className="group border-t border-[var(--color-line)]">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-[13px] font-medium [&::-webkit-details-marker]:hidden">
            Iceberg properties
            <span className="numeric font-normal text-[var(--color-ink-faint)]">{properties.length}</span>
            <ChevronDown className="ml-auto size-4 text-[var(--color-ink-faint)] transition-transform group-open:rotate-180" />
          </summary>
          <ul className="divide-y divide-[var(--color-line)] border-t border-[var(--color-line)]">
            {shown.map(([key, value]) => (
              <li key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 px-5 py-1.5 text-[12px]">
                <span className="numeric truncate text-[var(--color-ink-muted)]" title={key}>
                  {key}
                </span>
                <span className="numeric truncate" title={value}>
                  {value}
                </span>
              </li>
            ))}
          </ul>
          {properties.some(([key]) => housekeeping(key)) ? (
            <button
              type="button"
              onClick={() => setAll((current) => !current)}
              className="w-full border-t border-[var(--color-line)] py-2 text-[12px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            >
              {all ? 'Hide commit and metadata settings' : `Show all ${properties.length}, commit and metadata settings too`}
            </button>
          ) : null}
        </details>
      ) : null}
    </Panel>
  );
}
