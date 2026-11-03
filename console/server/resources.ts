/**
 * DuckDB sized to the container the console runs in.
 *
 * The console holds one DuckDB instance of its own and one more for every statement scanning
 * (`data/duckdb.ts::withSandbox`), at most `CONSOLE_STATEMENT_CONCURRENCY` of them (`runs/store.ts`
 * admits no more). `memory_limit` bounds what DuckDB's buffer manager holds, not the process: measured in a 2-CPU pod scanning 1,178
 * objects, a sandbox capped at 1.5 GB reached 1.27 GiB resident with its file cache off and 2.5 GiB
 * with it on, against 490 MiB DuckDB said it held. So every instance gets an equal share of what Node
 * leaves, and half of that share is its limit: the other half is room for what DuckDB does not count.
 *
 * Threads trade the same way against CPU. Remote reads wait on round trips, so more threads than
 * cores keep more requests in flight; but past a few per core a CPU-limited pod is throttled. The same
 * scan took 8.8 s on 4 threads, 10.5 s on 8, 28.8 s on 16, and had not finished after 75 s on 32.
 */

import { availableParallelism, totalmem } from 'node:os';

const MIB = 1024 * 1024;

/** What Node itself needs beside DuckDB: its heap, the live store, buffers in flight. */
export const NODE_RESERVE_BYTES = 512 * MIB;

/** The least memory an instance is given, however small the container. */
export const MIN_INSTANCE_BYTES = 128 * MIB;

/** DuckDB threads per CPU, and the bounds on the total. */
export const THREADS_PER_CPU = 4;
export const MIN_THREADS = 4;
export const MAX_THREADS = 64;

/**
 * The memory the console may use, when the deployment does not say (the chart passes the container's
 * limit as `CONSOLE_CONTAINER_MEMORY_BYTES`): the cgroup's limit, or the machine's memory.
 */
export function detectMemoryBytes(): number {
  const constrained = process.constrainedMemory?.() ?? 0;
  const total = totalmem();
  // Without a limit, a cgroup reports a number larger than the machine; the machine's is the bound.
  return constrained > 0 ? Math.min(constrained, total) : total;
}

/** The CPUs the console may use, when the deployment does not say; Node counts a cgroup's CPU quota. */
export function detectCpus(): number {
  return availableParallelism();
}

/** `memory_limit` for each DuckDB instance: the console's own and every concurrent statement's. */
export function duckdbMemoryLimitFor(memoryBytes: number, statementConcurrency: number): string {
  const instances = Math.max(1, statementConcurrency) + 1;
  const share = Math.max(0, memoryBytes - NODE_RESERVE_BYTES) / instances;
  return `${Math.floor(Math.max(MIN_INSTANCE_BYTES, share / 2) / MIB)}MiB`;
}

/** DuckDB threads for each instance. */
export function duckdbThreadsFor(cpus: number): number {
  return Math.min(MAX_THREADS, Math.max(MIN_THREADS, Math.round(cpus * THREADS_PER_CPU)));
}
