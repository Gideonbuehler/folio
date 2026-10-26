/**
 * A small key-value store in IndexedDB, where the browser build keeps
 * autosaves and recent file handles. Values are stored by structured clone,
 * so bytes and FileSystemFileHandles go in as they are.
 */
const STORE = 'kv';
let opening: Promise<IDBDatabase> | null = null;

function db() {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('folio', 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  opening.catch(() => (opening = null));
  return opening;
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const tx = (await db()).transaction(STORE, mode);
  const req = fn(tx.objectStore(STORE));
  return new Promise<T>((resolve, reject) => {
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
  });
}

export const idb = {
  get: <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key)),
  set: (key: string, value: unknown) => run('readwrite', (s) => s.put(value, key)).then(() => {}),
  del: (key: string) => run('readwrite', (s) => s.delete(key)).then(() => {}),
  keys: () => run('readonly', (s) => s.getAllKeys()).then((keys) => keys.map(String)),
};
