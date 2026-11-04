// History storage in the browser (IndexedDB), so it survives page reloads and
// can hold large imported chat exports. Falls back to memory when IndexedDB
// isn't available (some private browsing modes).
//
// Stores:
//   runs           prompts sent from this app, with every model's answer
//   conversations  chats imported from ChatGPT, Claude, Gemini, ...

const DB_NAME = 'default-ai';
const DB_VERSION = 1;
const STORES = ['runs', 'conversations'];

let dbPromise = null;
const memory = { runs: new Map(), conversations: new Map() };
export let persistent = true;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        persistent = false;
        return resolve(null);
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        persistent = false;
        resolve(null);
      };
    });
  }
  return dbPromise;
}

/** Run `fn(store)` in a transaction; resolves with the value of the request it returns, if any. */
async function withStore(name, mode, fn) {
  const db = await openDb();
  if (!db) {
    const out = fn(null, memory[name]);
    return out && 'result' in out ? out.result : undefined;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const request = fn(tx.objectStore(name));
    tx.oncomplete = () => resolve(request && 'result' in request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage was full or blocked.'));
  });
}

export function getAll(name) {
  return withStore(name, 'readonly', (store, mem) => (store ? store.getAll() : { result: [...mem.values()] }));
}

export function putMany(name, items) {
  return withStore(name, 'readwrite', (store, mem) => {
    for (const item of items) store ? store.put(item) : mem.set(item.id, item);
  });
}

export function remove(name, ids) {
  return withStore(name, 'readwrite', (store, mem) => {
    for (const id of ids) store ? store.delete(id) : mem.delete(id);
  });
}
