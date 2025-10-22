// User ops not yet stored by the server, kept in IndexedDB per project so they survive a reload
// while the API is down (LLD §10, §14). A memory store stands in where IndexedDB is missing
// (Node tests, some private windows).
import type { OpEnvelope } from "../gen/contract.ts";

export interface Pending {
  /** The server's rev the first envelope applies to. */
  baseRev: number;
  envelopes: OpEnvelope[];
}

export interface PendingStore {
  get(project: string): Promise<Pending | null>;
  /** Empty envelopes delete the entry. */
  put(project: string, pending: Pending): Promise<void>;
}

export function memoryPendingStore(): PendingStore {
  const m = new Map<string, Pending>();
  return {
    get: async (p) => structuredClone(m.get(p) ?? null),
    put: async (p, pending) => {
      if (pending.envelopes.length) m.set(p, structuredClone(pending));
      else m.delete(p);
    },
  };
}

const DB = "circuit-forge";
const STORE = "pending-ops";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function indexedDbPendingStore(): PendingStore {
  if (typeof indexedDB === "undefined") return memoryPendingStore();
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  const fallback = memoryPendingStore();
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    async get(project) {
      try {
        return ((await request((await tx("readonly")).get(project))) as Pending | undefined) ?? null;
      } catch {
        return fallback.get(project); // storage blocked: this tab's memory only
      }
    },
    async put(project, pending) {
      try {
        const store = await tx("readwrite");
        if (pending.envelopes.length) await request(store.put(pending, project));
        else await request(store.delete(project));
      } catch {
        await fallback.put(project, pending);
      }
    },
  };
}
