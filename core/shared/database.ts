// NOTE: To inspect the IDB in Chromium-based browsers, go to an extension-page (e.g. options.html) and to the DevTools tab there (service worker does not show the IDB)
// see https://groups.google.com/a/chromium.org/g/chromium-extensions/c/iMmV93LyNjI

export const DOMAIN = "domain" as const;
export const MAIN_DOMAIN = "mainDomain" as const;
export const SCION_ENABLED = "scionEnabled" as const;

export type RequestSchema = {
    [DOMAIN]: string;
    [MAIN_DOMAIN]: string;
    [SCION_ENABLED]: boolean;
};

/**
 * Extends the {@link RequestSchema} by the {@link key} and {@link lastAccessed} properties.
 */
type RequestEntryInternal = RequestSchema & {
    key: string;
    lastAccessed: number;
};

const DB_NAME = "scion-cache-db";
const DB_VERSION = 1;

const STORE_ENTRIES = "entries";
const STORE_META = "meta";

const INDEX_LAST_ACCESSED = "by_lastAccessed";
const INDEX_DOMAIN = "by_domain";

const MAX_ENTRIES = browser.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES - 500; // subtracting some buffer
const EVICT_COUNT = 100; // arbitrary number that results in eviction process taking ~15ms

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Returns all entries stored in the DB.
 *
 * Note: This operation is slow (~1000ms for a DB with 30k entries). Use it appropriately.
 */
export async function getRequestsInDB(): Promise<RequestSchema[]> {
    const db = await openDB();

    const transaction = db.transaction(STORE_ENTRIES, "readonly");
    const store = transaction.objectStore(STORE_ENTRIES);
    const req = store.openCursor();

    const result: RequestSchema[] = [];

    await new Promise<void>((resolve, reject) => {
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
                resolve();
                return;
            }

            const entry = cursor.value as RequestEntryInternal;
            result.push({
                [DOMAIN]: entry.domain,
                [MAIN_DOMAIN]: entry.mainDomain,
                [SCION_ENABLED]: entry.scionEnabled,
            });

            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });

    return result;
}

/**
 * Add or update request
 * - overwrites scionEnabled if present
 * - updates TTL
 */
/**
 * Adds or updates an entry in the DB.
 *
 * The {@link RequestSchema.domain} and {@link RequestSchema.mainDomain} are used
 * as the key in the DB; if an entry already exists with this key, the {@link RequestSchema.scionEnabled} value is
 * overwritten and {@link RequestEntryInternal.lastAccessed} is updated.
 */
export async function addOrUpdateRequestInDB(
    entry: RequestSchema
): Promise<void> {
    const db = await openDB();
    const key = getKey(entry.domain, entry.mainDomain);

    const transaction = db.transaction([STORE_ENTRIES, STORE_META], "readwrite");
    const store = transaction.objectStore(STORE_ENTRIES);
    const metaStore = transaction.objectStore(STORE_META);

    const existingReq = store.get(key);

    const existing = await new Promise<RequestEntryInternal | undefined>(
        (resolve) => {
            existingReq.onsuccess = () =>
                resolve(existingReq.result);
            existingReq.onerror = () => resolve(undefined);
        }
    );

    const newEntry: RequestEntryInternal = {
        ...entry,
        key,
        lastAccessed: now(),
    };

    store.put(newEntry);

    const count = await getEntryCount(metaStore);
    if (!existing) {
        await setEntryCount(metaStore, count + 1);
    }

    if (count + 1 > MAX_ENTRIES) {
        await evictLRU(store, metaStore, EVICT_COUNT);
    }

    await transactionDone(transaction);
}

/**
 * Finds a returns the first entry that matches the {@link domain}. Returns `null` if no such element
 * was found.
 *
 * This function also updates the {@link RequestEntryInternal.lastAccessed} to the current timestamp,
 * if an element was found.
 */
export async function findRequestInDB(
    domain: RequestSchema[typeof DOMAIN]
): Promise<RequestSchema | null> {
    const db = await openDB();
    const transaction = db.transaction(STORE_ENTRIES, "readwrite");
    const store = transaction.objectStore(STORE_ENTRIES);
    const index = store.index(INDEX_DOMAIN);

    // since we only need a single entry that matches the `domain` and a secondary index
    // exists on the domain, it suffices to read from the cursor
    const req = index.openCursor(IDBKeyRange.only(domain));
    const entry = await new Promise<RequestEntryInternal | null>(
        (resolve, reject) => {
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve(null);
                    return;
                }
                resolve(cursor.value as RequestEntryInternal);
            };
            req.onerror = () => reject(req.error);
        }
    );

    // no entry was found that matched the requested `domain`, return null in this case
    if (!entry) {
        await transactionDone(transaction);
        return null;
    }

    // update the timestamp, as this entry was requested
    entry.lastAccessed = now();
    store.put(entry);

    await transactionDone(transaction);

    return {
        [DOMAIN]: entry.domain,
        [MAIN_DOMAIN]: entry.mainDomain,
        [SCION_ENABLED]: entry.scionEnabled,
    };
}

// ==============================
// Functions intended for benchmarks
// ==============================
/**
 * Returns the number of entries in the main store via a call to {@link IDBObjectStore.count}.
 *
 * Note: Since this method is slow for larger numbers of entries (see comment about `Metastore` further below), this
 * function should exclusively be used for benchmark-purposes. Use {@link getEntryCount} instead.
 */
export async function getCount() {
    const db = await openDB();
    const transaction = db.transaction([STORE_ENTRIES, STORE_META], "readwrite");
    const store = transaction.objectStore(STORE_ENTRIES);
    const request = store.count();
    const count = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    await transactionDone(transaction);
    return count;
}

/**
 * Wrapper for {@link getEntryCount} that handles opening the DB and transaction.
 *
 * Note: This function is exclusively intended for benchmark-purposes. Use {@link getEntryCount} instead.
 */
export async function getCustomCount() {
    const db = await openDB();
    const transaction = db.transaction([STORE_META], "readwrite");
    const metaStore = transaction.objectStore(STORE_META);
    const count = getEntryCount(metaStore);
    await transactionDone(transaction);
    return count;
}

/**
 * Manually performs the eviction process through {@link evictLRU}.
 * This function is exclusively to be used by benchmarks.
 */
export async function evictLRUBenchmark() {
    const db = await openDB();
    const transaction = db.transaction([STORE_ENTRIES, STORE_META], "readwrite");
    const store = transaction.objectStore(STORE_ENTRIES);
    const metaStore = transaction.objectStore(STORE_META);
    await evictLRU(store, metaStore, EVICT_COUNT);
    await transactionDone(transaction);
}

// ==============================
// Metastore:
// Separately storing the information about the number of entries in the main store, since
// the `count()` function of stores is comparably slow (~50x slower than reading/writing a single item once
// in meta store if the DB contains ~30k entries)
// ==============================
/**
 * Returns the number of entries stored in the main store.
 */
async function getEntryCount(metaStore: IDBObjectStore): Promise<number> {
    const req = metaStore.get("entryCount");
    return await new Promise<number>((resolve) => {
        req.onsuccess = () => {
            resolve(req.result?.value ?? 0);
        };
        req.onerror = () => resolve(0);
    });
}

/**
 * Sets the number of entries stored in the main store.
 */
async function setEntryCount(metaStore: IDBObjectStore, value: number): Promise<void> {
    metaStore.put({key: "entryCount", value: value});
}
// ==============================

/**
 * Opens or returns the DB and ensures it is up-to-date.
 */
function openDB(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = () => {
            const db = req.result;

            // main store
            const entryStore = db.createObjectStore(STORE_ENTRIES, {
                keyPath: "key",
            });

            entryStore.createIndex(
                INDEX_LAST_ACCESSED,
                "lastAccessed",
                {unique: false}
            );

            entryStore.createIndex(
                INDEX_DOMAIN,
                "domain",
                {unique: false}
            );

            // metadata store
            db.createObjectStore(STORE_META, {
                keyPath: "key",
            });
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

    return dbPromise;
}

/**
 * Performs the eviction process of the '{@link count}' least recently used items in IDB.
 *
 * Note that this function neither handles opening nor closing of the transaction.
 */
async function evictLRU(store: IDBObjectStore, metaStore: IDBObjectStore, count: number): Promise<void> {
    const index = store.index(INDEX_LAST_ACCESSED);

    let removed = 0;
    const req = index.openCursor(); // ascending TTL

    await new Promise<void>((resolve, reject) => {
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor || removed >= count) {
                resolve();
                return;
            }

            store.delete(cursor.primaryKey);
            removed++;
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });

    const currentCount = await getEntryCount(metaStore);
    await setEntryCount(metaStore, Math.max(0, currentCount - removed));
}

function getKey(domain: string, mainDomain: string): string {
    return `${domain}|${mainDomain}`;
}

/**
 * Gets current timestamp.
 */
function now(): number {
    return Date.now();
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}
