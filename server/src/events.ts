// Live updates. Postgres triggers (schema.sql) announce file and share changes on 'cloudy_changes'
// after commit; one LISTEN connection batches them and pushes Server-Sent Events to the browsers and
// apps of every user who can see the changed folder. Clients reload the view when an event matches it.
import pg from 'pg';
import type { ServerResponse } from 'node:http';
import { config } from './config.ts';
import { q } from './db.ts';

/** `folders`: ids of folders whose listing changed. `shares`: shared-with-me list changed. */
export interface ChangeEvent { folders: number[]; shares: boolean }

const clients = new Map<string, Set<ServerResponse>>();
const MAX_STREAMS_PER_USER = 20;
const BATCH_MS = 250;

/**
 * A write after `end()` is an 'error' event on the response, and nobody listens for it: an uncaught exception that
 * takes the whole server down. An ended stream stays in `clients` until its 'close' event, so a ping or a change in
 * between (an evicted 21st stream, shutdown) must not write to it.
 */
function write(res: ServerResponse, data: string): void {
  if (!res.writableEnded && !res.destroyed) res.write(data);
}

export function openStream(userId: string, res: ServerResponse): void {
  const set = clients.get(userId) ?? new Set();
  if (set.size >= MAX_STREAMS_PER_USER) {
    const oldest = set.values().next().value;
    if (oldest) { set.delete(oldest); oldest.end(); }
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
    Connection: 'keep-alive',
  });
  res.write('retry: 5000\n\n');
  set.add(res);
  clients.set(userId, set);
  const ping = setInterval(() => write(res, ': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (!set.size && clients.get(userId) === set) clients.delete(userId);
  });
}

/** Ends every stream (shutdown): browsers and apps reconnect to the new process after `retry`. */
export function closeStreams(): void {
  for (const set of clients.values()) for (const res of set) res.end();
}

function send(userId: string, ev: ChangeEvent): void {
  const data = `event: change\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients.get(userId) ?? []) write(res, data);
}

// ---------------------------------------------------------------- batching and recipients

let pendingFolders = new Map<number, string>(); // folder id -> owner (owner is known even after a purge)
let pendingShareUsers = new Set<string>();
let pendingShareGroups = new Set<string>();
let timer: NodeJS.Timeout | null = null;

function schedule(): void {
  timer ??= setTimeout(() => { timer = null; void flush().catch((e) => console.error('live update failed', e)); }, BATCH_MS);
}

/** Users who can see `folderId`: its owner plus user/group shares on it or any ancestor. */
async function viewersOf(folderIds: number[]): Promise<Map<number, string[]>> {
  const rows = await q<{ folder: number; user_id: string }>(
    `WITH RECURSIVE up AS (
       SELECT id AS folder, id, parent_id FROM nodes WHERE id = ANY($1::bigint[])
       UNION ALL SELECT up.folder, n.id, n.parent_id FROM nodes n JOIN up ON n.id = up.parent_id)
     SELECT DISTINCT up.folder, COALESCE(m.user_id, s.share_with) AS user_id
       FROM up JOIN shares s ON s.node_id = up.id AND s.type IN ('user', 'group')
       LEFT JOIN group_members m ON s.type = 'group' AND m.group_id = s.share_with`,
    [folderIds],
  );
  const out = new Map<number, string[]>();
  for (const r of rows) if (r.user_id) out.set(r.folder, [...(out.get(r.folder) ?? []), r.user_id]);
  return out;
}

async function flush(): Promise<void> {
  const folders = pendingFolders;
  const shareUsers = pendingShareUsers;
  const shareGroups = pendingShareGroups;
  pendingFolders = new Map();
  pendingShareUsers = new Set();
  pendingShareGroups = new Set();
  if (!clients.size) return;

  const perUser = new Map<string, ChangeEvent>();
  const ev = (u: string) => perUser.get(u) ?? perUser.set(u, { folders: [], shares: false }).get(u)!;
  if (folders.size) {
    const viewers = await viewersOf([...folders.keys()]);
    for (const [folder, owner] of folders) {
      for (const u of new Set([owner, ...(viewers.get(folder) ?? [])])) if (clients.has(u)) ev(u).folders.push(folder);
    }
  }
  if (shareGroups.size) {
    for (const r of await q<{ user_id: string }>(`SELECT user_id FROM group_members WHERE group_id = ANY($1::text[])`, [[...shareGroups]])) {
      shareUsers.add(r.user_id);
    }
  }
  for (const u of shareUsers) if (clients.has(u)) ev(u).shares = true;
  for (const [u, e] of perUser) send(u, e);
}

function onNotify(payload: string | undefined): void {
  let m: { t: string; p?: number | null; o?: string; k?: string; w?: string };
  try { m = JSON.parse(payload ?? ''); } catch { return; }
  if (m.t === 'n' && m.p != null && m.o) pendingFolders.set(Number(m.p), m.o);
  else if (m.t === 's' && m.w) {
    (m.k === 'group' ? pendingShareGroups : pendingShareUsers).add(m.w);
    if (m.o && m.p != null) pendingFolders.set(Number(m.p), m.o); // the parent listing shows share badges
  } else return;
  schedule();
}

// ---------------------------------------------------------------- LISTEN connection (reconnects)

export async function startLiveUpdates(): Promise<void> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  let retrying = false;
  const retry = () => {
    if (retrying) return;
    retrying = true;
    client.end().catch(() => {});
    setTimeout(() => void startLiveUpdates(), 5000).unref();
  };
  client.on('notification', (n) => onNotify(n.payload));
  client.on('error', (e) => {
    console.error('live updates: database connection lost', e.message);
    retry();
  });
  try {
    await client.connect();
    await client.query('LISTEN cloudy_changes');
  } catch (e: any) {
    console.error('live updates: cannot listen', e.message);
    retry();
  }
}
