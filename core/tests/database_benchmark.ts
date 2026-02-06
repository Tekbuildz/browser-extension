// ------------------------------------------------------------
// Performance benchmarking for IndexedDB-based storage functions
// of `database.ts`
// ------------------------------------------------------------

import {
    addOrUpdateRequestInDB,
    findRequestInDB,
    getRequestsInDB,
    evictLRUBenchmark, getCount, getCustomCount, type RequestSchema,
} from "../shared/database.js";

// value in same order of magnitude as real limit (30k) but without hitting the automatic eviction-process when adding another test-entry
const INITIAL_ENTRIES = 29000;

/**
 * Performs the benchmark for various tasks.
 */
export async function runDatabasePerformance(): Promise<void> {
    console.log("=== IndexedDB Performance Benchmark ===");

    await initializeDatabase();

    await benchmarkAddNew();
    await benchmarkUpdateExisting();
    await benchmarkFindExisting();
    await benchmarkFindMissing();
    await benchmarkGetAll();
    await benchmarkEvictLRU();
    await benchmarkCount();
    await benchmarkCustomCount();

    console.log("=== Benchmark complete ===");
}

/**
 * Initializes the DB for benchmarking.
 */
async function initializeDatabase(): Promise<void> {
    console.log(`Initializing database with ${INITIAL_ENTRIES} entries...`);

    // this is a very slow and naive implementation (creates new transaction for each entry)
    // but since initialization is not timed, it does not really matter
    for (let i = 0; i < INITIAL_ENTRIES; i++) {
        await addOrUpdateRequestInDB(generateDummyEntry(i));
    }

    console.log("Initialization complete")
}

// ------------------------------------------------------------
// Benchmarks
// ------------------------------------------------------------
/**
 * Benchmark for adding a new (non-existing) entry.
 * @see {addOrUpdateRequestInDB}
 */
async function benchmarkAddNew(): Promise<void> {
    const entry: RequestSchema = {
        domain: "brand-new.example.com",
        mainDomain: "example.com",
        scionEnabled: true,
    };

    const t0 = now();
    await addOrUpdateRequestInDB(entry);
    log("Add (new entry)", t0);
}

/**
 * Benchmark for updating an existing entry (`scionEnabled` is overwritten).
 * @see {addOrUpdateRequestInDB}
 */
async function benchmarkUpdateExisting(): Promise<void> {
    const entry: RequestSchema = {
        domain: "sub100.example.com",
        mainDomain: "example.com",
        scionEnabled: false,
    };

    const t0 = now();
    await addOrUpdateRequestInDB(entry);
    log("Update (existing entry)", t0);
}

/**
 * Benchmark for finding an item (known to exist).
 * @see {findRequestInDB}
 */
async function benchmarkFindExisting(): Promise<void> {
    const t0 = now();
    const result = await findRequestInDB("sub200.example.com");
    log("Find (existing)", t0);

    if (result === null) {
        console.warn("Unexpected: existing entry not found");
    }
}

/**
 * Benchmark for trying to find a non-existing item.
 * @see {findRequestInDB}
 */
async function benchmarkFindMissing(): Promise<void> {
    const t0 = now();
    const result = await findRequestInDB("does-not-exist.example.com");
    log("Find (missing)", t0);

    if (result !== null) {
        console.warn("Unexpected: missing entry was found");
    }
}

/**
 * Benchmark to fetch all entries of the IDB.
 * @see {getRequestsInDB}
 */
async function benchmarkGetAll(): Promise<void> {
    const t0 = now();
    const all = await getRequestsInDB();
    log("Get all entries", t0);

    console.log(`Retrieved ${all.length} entries`);
}

/**
 * Benchmark for the eviction of entries.
 * @see {evictLRUBenchmark}
 */
async function benchmarkEvictLRU(): Promise<void> {
    const t0 = now();
    await evictLRUBenchmark();
    log("Evict LRU", t0);
}

async function benchmarkCount(): Promise<void> {
    const t0 = now();
    const count = await getCount();
    log(`Count: ${count}, took`, t0);
}

async function benchmarkCustomCount(): Promise<void> {
    const t0 = now();
    const count = await getCustomCount();
    log(`CustomCount: ${count}, took`, t0);
}

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------
function now(): number {
    return performance.now();
}

function log(label: string, start: number): void {
    const dt = performance.now() - start;
    console.log(`${label}: ${dt.toFixed(2)} ms`);
}

function generateDummyEntry(i: number): RequestSchema {
    return {
        domain: `sub${i}.example.com`,
        mainDomain: "example.com",
        scionEnabled: (i & 1) === 0,
    };
}
