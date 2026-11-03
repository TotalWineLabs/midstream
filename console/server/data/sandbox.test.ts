/**
 * A sandbox's memory: no external file cache, since nothing reads it again once the statement ends,
 * and work larger than the memory limit spills into the directory it is given instead of failing.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const dataDir = await mkdtemp(join(tmpdir(), 'console-sandbox-'));
process.env.CONSOLE_DATA_DIR = dataDir;
process.env.CONSOLE_DUCKDB_MEMORY_LIMIT = '128MB';
process.env.CONSOLE_DUCKDB_THREADS = '2';
after(() => rm(dataDir, { recursive: true, force: true }));

const { withSandbox } = await import('./duckdb.ts');
import type { DuckDBConnection } from '@duckdb/node-api';

async function setting(connection: DuckDBConnection, name: string): Promise<unknown> {
  return (await connection.runAndReadAll(`SELECT current_setting('${name}') AS value`)).getRowObjects()[0]?.value;
}

/** A sort several times the memory limit, written to `path`. */
const BIG_SORT = (path: string): string => `COPY (SELECT range AS n FROM range(30000000) ORDER BY hash(range)) TO '${path}' (FORMAT PARQUET)`;

describe('a sandbox', () => {
  it('keeps no external file cache', async () => {
    await withSandbox({ directories: [], paths: [] }, async (connection) => {
      assert.equal(await setting(connection, 'enable_external_file_cache'), false);
    });
  });

  it('spills what does not fit into its spill directory, inside its own directory', async () => {
    const workDir = join(dataDir, 'run-spill');
    const spill = join(workDir, 'spill');
    await mkdir(workDir, { recursive: true });
    await withSandbox({ directories: [`${workDir}/`], paths: [], spillDirectory: spill }, async (connection) => {
      assert.equal(await setting(connection, 'temp_directory'), spill);
      await connection.run(BIG_SORT(join(workDir, 'result.parquet')));
    });
    assert.ok((await readdir(workDir)).includes('result.parquet'));
  });

  it('without a spill directory, may not spill', async () => {
    const workDir = join(dataDir, 'run-no-spill');
    await mkdir(workDir, { recursive: true });
    await withSandbox({ directories: [`${workDir}/`], paths: [] }, async (connection) => {
      assert.equal(await setting(connection, 'temp_directory'), '');
      await assert.rejects(connection.run(BIG_SORT(join(workDir, 'result.parquet'))), /Out of Memory|memory/i);
    });
  });
});
