/**
 * MongoDB connection wrapper — serverless-friendly.
 *
 * Vercel serverless functions are stateless per invocation but the Node
 * process is kept warm across invocations. So we cache the MongoClient on
 * the module's globalThis to reuse connections across warm invocations and
 * avoid burning a TCP handshake + auth roundtrip on every request.
 *
 * The DB we use is "Zoho Database" (with space) per user spec. All
 * collections we create live inside this DB — never touch `asbl_loft`,
 * `ASBLVoiceBot`, or any existing DB on the cluster.
 *
 * Connection config matches the URI shape:
 *   tls=true + tlsAllowInvalidCertificates=true (self-signed cert)
 *   authSource=admin
 *   self-hosted on 13.127.144.117:27017
 *
 * IMPORTANT FOR CALLERS:
 *   - Always go through `getDb()` — never instantiate MongoClient yourself.
 *   - Always pass collection names through the COL.* constants below so
 *     a future rename is one-file change.
 *   - Never call `client.close()` from a handler — connection is shared
 *     across all warm invocations.
 */

import { MongoClient, Db, Collection, MongoClientOptions } from "mongodb";

const MONGO_URI = process.env.MONGO_URI || "";

/** Database name. User asked for "Zoho Database" (with space) but the
 *  MongoDB Node driver rejects spaces in database names — we use the
 *  closest alternative with an underscore. Compass / mongosh both show
 *  this as "Zoho_Database". */
export const DB_NAME = "Zoho_Database";

/** Canonical collection names. Anything new being migrated to Mongo
 *  must register its name here so we have a single index of what lives
 *  in this DB. */
export const COL = {
  BOT_SETTINGS:       "bot_settings",
  USER_PROFILES:      "user_profiles",
  DOC_SEND_LOG:       "doc_send_log",
  WHATSAPP_MESSAGES:  "whatsapp_messages",
  PROJECT_FACTS:      "project_facts",
  PROJECT_DOCUMENTS:  "project_documents",
  LEADS:              "leads",
  MLID_REGISTRY:      "mlid_registry",
  PLID_REGISTRY:      "plid_registry",
  PRD_STATE:          "prd_state",
  /** Internal: monotonic counters used by getNextSequence() to mimic
   *  Postgres serial sequences atomically (e.g. for MLID/PLID). */
  COUNTERS:           "_counters",
} as const;

// ─── Cached client (shared across warm Vercel invocations) ────────────────

// We stash on globalThis so `next dev` HMR + Vercel's reused process don't
// open 100 sockets across hot reloads. Declared as `any` because TS doesn't
// model the cache pattern natively.
const G = globalThis as any;

interface MongoCache {
  client: MongoClient | null;
  connectPromise: Promise<MongoClient> | null;
}

function getCache(): MongoCache {
  if (!G.__asblMongo) {
    G.__asblMongo = { client: null, connectPromise: null } as MongoCache;
  }
  return G.__asblMongo as MongoCache;
}

const CLIENT_OPTIONS: MongoClientOptions = {
  // Self-signed cert on the EC2 host
  tls: true,
  tlsAllowInvalidCertificates: true,
  // Tight timeouts — Vercel function budget is 10s on Hobby; fail fast so
  // we don't waste budget on a hung connection.
  serverSelectionTimeoutMS: 8000,
  connectTimeoutMS: 8000,
  socketTimeoutMS: 20000,
  // Small pool — each warm invocation handles ONE request at a time, so
  // 1-2 connections is plenty. Reduces pressure on the self-hosted Mongo.
  maxPoolSize: 4,
  minPoolSize: 0,
  // Force IPv4 since the host advertises IPv4 only
  family: 4,
};

/** Returns a connected MongoClient. Reuses the cached instance if it's
 *  still healthy; otherwise opens a fresh connection. Concurrent callers
 *  share the same connection-in-progress promise to avoid stampeding the
 *  server with parallel handshakes on cold-ish starts. */
export async function getClient(): Promise<MongoClient> {
  if (!MONGO_URI) {
    throw new Error("MONGO_URI env var is not set");
  }
  const cache = getCache();

  if (cache.client) {
    // Quick health check — if topology has been closed, drop the cache
    try {
      // @ts-ignore — internal but reliable
      if (cache.client.topology && !cache.client.topology.isDestroyed()) {
        return cache.client;
      }
    } catch {
      // fall through to reconnect
    }
    cache.client = null;
  }

  if (!cache.connectPromise) {
    const client = new MongoClient(MONGO_URI, CLIENT_OPTIONS);
    cache.connectPromise = client
      .connect()
      .then((c) => {
        cache.client = c;
        cache.connectPromise = null;
        return c;
      })
      .catch((err) => {
        cache.connectPromise = null;
        throw err;
      });
  }
  return cache.connectPromise;
}

/** Get the "Zoho Database" Db handle. Convenience for most call sites. */
export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(DB_NAME);
}

/** Get a typed Collection handle. The generic T is the document shape. */
export async function getCollection<T extends Record<string, any> = any>(
  name: (typeof COL)[keyof typeof COL] | string,
): Promise<Collection<T>> {
  const db = await getDb();
  return db.collection<T>(name) as Collection<T>;
}

// ─── Atomic sequence generator (replaces Postgres get_or_create_mlid) ─────

/**
 * Get the next sequence value for `key`, starting from `startAt` (default 1)
 * if the key doesn't exist. Uses findOneAndUpdate with $inc, which is atomic
 * even under concurrent calls — same guarantee as Postgres sequences.
 *
 * Used by leads.ts to mint new MLIDs and PLIDs.
 */
export async function getNextSequence(
  key: string,
  startAt: number = 1,
): Promise<number> {
  const col = await getCollection<{ _id: string; seq: number }>(COL.COUNTERS);
  const result = await col.findOneAndUpdate(
    { _id: key as any },
    { $inc: { seq: 1 }, $setOnInsert: { _id: key as any } },
    { upsert: true, returnDocument: "after" },
  );
  // If we just inserted, seq becomes 1 from the $inc on null=0+1. If
  // startAt > 1 is requested AND the row was fresh-inserted, bump it.
  const seq = (result as any)?.seq ?? 1;
  if (seq < startAt) {
    // Rare path: bumped from 0 to 1 but we wanted to start higher
    const fix = await col.findOneAndUpdate(
      { _id: key as any },
      { $set: { seq: startAt } },
      { returnDocument: "after" },
    );
    return (fix as any)?.seq ?? startAt;
  }
  return seq;
}

/** Health probe for /api/chat-history?action=mongo-diag. */
export async function ping(): Promise<{
  ok: boolean;
  db: string;
  collections: string[];
  error?: string;
  ms?: number;
}> {
  const t0 = Date.now();
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    const cols = await db.listCollections({}, { nameOnly: true }).toArray();
    return {
      ok: true,
      db: DB_NAME,
      collections: cols.map((c) => c.name).sort(),
      ms: Date.now() - t0,
    };
  } catch (err: any) {
    return {
      ok: false,
      db: DB_NAME,
      collections: [],
      error: err.message,
      ms: Date.now() - t0,
    };
  }
}
