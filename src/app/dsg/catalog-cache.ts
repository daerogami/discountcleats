const DB_NAME = 'discountcleats.catalogs';
const STORE = 'results';
export const CATALOG_CACHE_MS = 10 * 60 * 1000;

interface CacheRecord<T> {
  savedAt: number;
  payload: T;
}

let opening: Promise<IDBDatabase> | null = null;

export async function readCatalog<T>(key: string): Promise<{ savedAt: number; payload: T } | null> {
  try {
    const db = await openDb();
    const record = await requestResult<CacheRecord<T> | undefined>(
      db.transaction(STORE, 'readonly').objectStore(STORE).get(key),
    );
    if (!record || typeof record.savedAt !== 'number') return null;
    if (Date.now() - record.savedAt > CATALOG_CACHE_MS) {
      void dropCatalog(key);
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

export async function writeCatalog<T>(
  key: string,
  payload: T,
  savedAt = Date.now(),
): Promise<void> {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    await requestResult(store.put({ savedAt, payload } satisfies CacheRecord<T>, key));
  } catch {
    // Quota or private browsing. The board still works for this visit.
  }
}

export async function dropCatalog(key: string): Promise<void> {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    await requestResult(store.delete(key));
  } catch {
    // Ignore. A missing cache only means the next visit asks the shop again.
  }
}

export async function pruneCatalog(prefix: string, max: number): Promise<void> {
  try {
    const db = await openDb();
    const read = db.transaction(STORE, 'readonly').objectStore(STORE);
    const keysRequest = read.getAllKeys();
    const valuesRequest = read.getAll();
    const [keys, values] = await Promise.all([
      requestResult<IDBValidKey[]>(keysRequest),
      requestResult<CacheRecord<unknown>[]>(valuesRequest),
    ]);
    const dated = keys
      .map((key, index) => ({ key, savedAt: values[index]?.savedAt ?? 0 }))
      .filter((item): item is { key: string; savedAt: number } => typeof item.key === 'string')
      .filter((item) => item.key.startsWith(prefix))
      .sort((a, b) => b.savedAt - a.savedAt);
    const extras = dated.slice(max);
    if (!extras.length) return;
    const write = db.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const extra of extras) write.delete(extra.key);
    await transactionDone(write.transaction);
  } catch {
    // Ignore. Extra saved searches expire on their own.
  }
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined')
    return Promise.reject(new Error('IndexedDB is unavailable.'));
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB did not open.'));
  });
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB request failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB request failed.'));
  });
}
