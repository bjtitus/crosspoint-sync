import { decideMatch, extractTitleAuthor, scoreCandidate, type Candidate } from './matching.js';
import {
  ConnectorOperationError,
  type Connector,
  type ConnectorContext,
  type Credential,
  type DocumentMeta,
  type ExternalBook,
  type HttpTransport,
  type Match,
  type OutboundEvent,
  type PushResult,
  type ValidateResult,
} from './types.js';

/**
 * Readwise Books connector (Tier 1, beta) — shelf status, reading dates and
 * reading sessions via the Readwise Books API (readwise.io/books_api,
 * `https://readwise.io/books/api/v1`). Distinct from the `readwise` (highlights,
 * classic v2) and `readwise-reader` (Reader documents, v3) connectors; all three
 * accept the same personal access token from readwise.io/access_token.
 *
 * What it carries:
 *  - progress events: the book is added to the library when missing (POST
 *    /books, matched server-side by title/author), moved to Currently reading
 *    and given a start date. Finished / did-not-finish / deleted books are left
 *    alone — we never downgrade a shelf the user set.
 *  - finished events: shelf → Finished with `finished_reading_at`.
 *  - optionally (`position_sessions`), the reading position itself: Readwise has
 *    no progress setter — `progress` is derived from sessions — so a zero-time
 *    session (`paused_seconds` = its whole span) moves the position without
 *    inventing reading time. Off by default; readers that measure sessions
 *    (CrossInk's PUT /stats/sessions) get real sessions from
 *    readwise-books-sessions.ts instead.
 *
 * The Books API is marked experimental by Readwise; every call goes through
 * request() so a shape change is one place to fix.
 */

export const BASE = 'https://readwise.io/books/api/v1';
export const TOKEN_URL = 'https://readwise.io/access_token';

// GET /books accepts up to 1000 per page; a library walk is bounded anyway.
const PAGE_LIMIT = 1000;
const MAX_LIBRARY_PAGES = 5;
// Span of a position-only session; paused for all of it, so it logs no time.
const POSITION_SESSION_SECONDS = 60;

// Rate-limit backoff, per token (20/min on GET, 50/min on writes). We can't
// read Retry-After through HttpTransport, so a 429 parks that token for a
// cooldown window; the queue retries with its own backoff after that.
const COOLDOWN_MS = Number(process.env.READWISE_RATE_COOLDOWN_MS ?? 60_000);
const rateLimitedUntil = new Map<string, number>();
function rateLimited(token: string): boolean {
  const until = rateLimitedUntil.get(token) ?? 0;
  if (Date.now() < until) return true;
  if (until) rateLimitedUntil.delete(token);
  return false;
}

export type Shelf = 'unsorted' | 'want_to_read' | 'currently_reading' | 'finished' | 'did_not_finish' | 'deleted';

export interface ReadwiseBook {
  id: number;
  title: string | null;
  author: string | null;
  status: Shelf;
  progress: number | null;
  started_reading_at: string | null;
  finished_reading_at: string | null;
  product: { id: string; title?: string | null; author?: string | null; isbn?: string | null } | null;
}
interface Page<T> {
  results?: T[];
  next?: string | null;
}
interface ApiError {
  error?: { code?: string; message?: string; details?: { field?: string; message?: string }[] };
}
interface ItemResult {
  status: string;
  id?: number;
  book_id?: number;
  session_id?: number;
  matched_by?: string | null;
  error?: string | null;
}

export interface SessionInput {
  book_id: number;
  started_at: string;
  ended_at: string;
  paused_seconds: number;
  format: 'ebook';
  percent_at_start: number;
  percent_at_end: number;
  timezone?: string;
  device?: { model: string; type: 'E-Reader' | 'Tablet' | 'Handset'; vendor?: string };
  publish_to_feed: boolean;
}

function tokenOf(cred: Credential): string {
  const t = (cred as { token?: unknown }).token;
  if (typeof t !== 'string' || t.length === 0) throw new ConnectorOperationError('missing readwise token', false, true);
  return t;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Token ${token}`, 'content-type': 'application/json', accept: 'application/json' };
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const iso = (unixSeconds: number): string => new Date(Math.max(0, unixSeconds) * 1000).toISOString();

/** A Readwise error body's message, or a status-based fallback. */
function errorMessage(body: unknown, status: number): string {
  const e = (body as ApiError | null)?.error;
  if (e?.message) {
    const detail = e.details?.find((d) => d.message)?.message;
    return detail ? `${e.message} (${detail})` : e.message;
  }
  return `Readwise answered ${status}`;
}

/**
 * One Books API call. Returns the status and parsed body for the caller to
 * judge; throws only on transport failure. `path` is relative to BASE or an
 * absolute `next` URL from a previous page (which must stay on readwise.io).
 */
async function request(
  token: string,
  http: HttpTransport,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const url = path.startsWith('https://') ? path : `${BASE}${path}`;
  if (!url.startsWith(BASE)) throw new Error('refusing to follow a Readwise page link off readwise.io');
  const res = await http(url, {
    method,
    headers: authHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 429) rateLimitedUntil.set(token, Date.now() + COOLDOWN_MS);
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/** Turn an HTTP status into a push decision, or null when the call succeeded. */
function classify(r: { status: number; body: unknown }): PushResult | null {
  if (r.status === 401 || r.status === 403) {
    return { ok: false, retryable: false, needsReauth: true, error: errorMessage(r.body, r.status) };
  }
  if (r.status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (r.status >= 500) return { ok: false, retryable: true, error: `server ${r.status}` };
  if (r.status < 200 || r.status >= 300) return { ok: false, retryable: false, error: errorMessage(r.body, r.status) };
  return null;
}

/** Same judgement as classify(), as an exception (for callers outside the queue). */
export function throwIfFailed(r: { status: number; body: unknown }, what: string): void {
  const c = classify(r);
  if (!c || c.ok) return;
  throw new ConnectorOperationError(`${what}: ${c.error}`, c.retryable, c.needsReauth);
}

/** Walk GET /books pages. Never throws on an API refusal: the caller sees fewer books. */
async function listBooks(
  token: string,
  http: HttpTransport,
  params: Record<string, string>,
  maxPages = MAX_LIBRARY_PAGES
): Promise<ReadwiseBook[]> {
  const out: ReadwiseBook[] = [];
  const q = new URLSearchParams({ limit: String(PAGE_LIMIT), ...params });
  let next: string | null = `/books?${q.toString()}`;
  const seen = new Set<string>();
  for (let page = 0; page < maxPages && next; page++) {
    const r = await request(token, http, 'GET', next);
    if (r.status !== 200) break;
    const body = r.body as Page<ReadwiseBook>;
    out.push(...(body.results ?? []));
    next = body.next ?? null;
    if (next && seen.has(next)) break; // loop guard on a repeated cursor
    if (next) seen.add(next);
  }
  return out;
}

function bookTitle(b: ReadwiseBook): string | null {
  return b.title ?? b.product?.title ?? null;
}
function bookAuthor(b: ReadwiseBook): string | null {
  return b.author ?? b.product?.author ?? null;
}

function candidatesOf(books: ReadwiseBook[]): Candidate[] {
  const out: Candidate[] = [];
  for (const b of books) {
    const title = bookTitle(b);
    if (b.status === 'deleted' || !Number.isSafeInteger(b.id) || !title) continue;
    out.push({ externalId: String(b.id), title, author: bookAuthor(b) });
  }
  return out;
}

const toExternal = (c: Candidate): ExternalBook => ({ externalId: c.externalId, title: c.title, author: c.author ?? null });

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  try {
    const r = await request(tokenOf(cred), http, 'GET', '/books?limit=1');
    if (r.status === 200) return { ok: true };
    if (r.status === 401) return { ok: false, error: 'invalid token' };
    if (r.status === 403) return { ok: false, error: `token lacks access to the Books API (${errorMessage(r.body, r.status)})` };
    return { ok: false, error: `unexpected status ${r.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Match against the whole library (every shelf but Deleted). */
async function match(cred: Credential, doc: DocumentMeta, http: HttpTransport): Promise<Match | null> {
  const token = tokenOf(cred);
  if (rateLimited(token)) return null;
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;
  const candidates = candidatesOf(await listBooks(token, http, {}));
  const decision = decideMatch(ta.title, ta.author, candidates);
  if (!decision.accepted || !decision.best) return null;
  return {
    externalId: decision.best.externalId,
    confidence: decision.best.score,
    queryUsed: `${ta.title} ${ta.author}`.trim(),
    title: decision.best.title,
    author: decision.best.author ?? null,
  };
}

/**
 * Not in the library yet: add it. Readwise matches the product in its catalog
 * (title + author here; the EPUB carries no ISBN we could pass) and returns the
 * library book id either way. Only real EPUB metadata qualifies — a filename
 * guess must not seed someone's library with junk titles.
 */
async function createBook(cred: Credential, doc: DocumentMeta, ev: OutboundEvent, http: HttpTransport): Promise<Match | null> {
  const token = tokenOf(cred);
  if (rateLimited(token) || !doc.title?.trim()) return null;
  const title = doc.title.trim().slice(0, 511);
  const author = doc.author?.trim().slice(0, 511);
  const finished = ev.kind === 'finished' || (ev.percentage ?? 0) >= 0.999;
  const when = iso(ev.timestamp > 0 ? ev.timestamp : Math.floor(Date.now() / 1000));
  const r = await request(token, http, 'POST', '/books', {
    items: [
      {
        product: { title, ...(author ? { author } : {}) },
        status: finished ? 'finished' : 'currently_reading',
        started_reading_at: when,
        ...(finished ? { finished_reading_at: when } : {}),
      },
    ],
  });
  throwIfFailed(r, 'adding the book to Readwise failed');
  const item = (r.body as { results?: ItemResult[] } | null)?.results?.[0];
  if (!item || item.status === 'error' || !Number.isSafeInteger(item.book_id)) {
    throw new ConnectorOperationError(`Readwise did not add the book: ${item?.error ?? 'no result'}`, false);
  }
  return { externalId: String(item.book_id), confidence: 1, queryUsed: title, title, author: author ?? null };
}

async function listCurrentlyReading(cred: Credential, http: HttpTransport): Promise<ExternalBook[]> {
  return candidatesOf(await listBooks(tokenOf(cred), http, { status: 'currently_reading' })).map(toExternal);
}

/** The manual-match picker searches the user's own library (the API has no catalog search). */
async function search(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]> {
  const q = query.trim();
  if (!q) return [];
  const candidates = candidatesOf(await listBooks(tokenOf(cred), http, {}));
  return candidates
    .map((c) => ({ c, score: scoreCandidate(q, '', c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((x) => toExternal(x.c));
}

/** A pasted Readwise library book id. */
async function lookup(cred: Credential, externalId: string, http: HttpTransport): Promise<ExternalBook | null> {
  if (!/^\d{1,18}$/.test(externalId)) return null;
  const book = await fetchBook(tokenOf(cred), http, Number(externalId));
  if (!book || book.status === 'deleted') return null;
  const title = bookTitle(book);
  return title ? { externalId: String(book.id), title, author: bookAuthor(book) } : null;
}

async function fetchBook(token: string, http: HttpTransport, id: number): Promise<ReadwiseBook | null> {
  const r = await request(token, http, 'GET', `/books?ids=${id}`);
  throwIfFailed(r, 'reading the book from Readwise failed');
  return (r.body as Page<ReadwiseBook> | null)?.results?.[0] ?? null;
}

/** POST one finished session; returns Readwise's id. Shared with the measured-session exporter. */
export async function postSession(cred: Credential, http: HttpTransport, session: SessionInput): Promise<number> {
  const token = tokenOf(cred);
  if (rateLimited(token)) throw new ConnectorOperationError('Readwise is rate limited; try again later', true);
  const r = await request(token, http, 'POST', '/sessions', { items: [session] });
  throwIfFailed(r, 'posting the reading session to Readwise failed');
  const item = (r.body as { results?: ItemResult[] } | null)?.results?.[0];
  if (!item || item.status === 'error' || !Number.isSafeInteger(item.session_id)) {
    throw new ConnectorOperationError(`Readwise did not accept the reading session: ${item?.error ?? 'no result'}`, false);
  }
  return item.session_id!;
}

/** DELETE one session. A session already gone counts as deleted. */
export async function deleteSession(cred: Credential, http: HttpTransport, remoteId: number): Promise<void> {
  const token = tokenOf(cred);
  if (rateLimited(token)) throw new ConnectorOperationError('Readwise is rate limited; try again later', true);
  const r = await request(token, http, 'DELETE', `/sessions?ids=${remoteId}`);
  if (r.status === 404) return;
  throwIfFailed(r, 'deleting the old reading session on Readwise failed');
  const item = (r.body as { results?: ItemResult[] } | null)?.results?.[0];
  if (item?.status === 'error' && !/not.?found/i.test(item.error ?? '')) {
    throw new ConnectorOperationError(`Readwise did not delete the old session: ${item.error}`, false);
  }
}

/**
 * Readwise wants an IANA zone for a session's local date. Devices report a UTC
 * offset; whole-hour offsets map onto the Etc/GMT zones (sign inverted by that
 * convention: Etc/GMT+5 is UTC-5). Other offsets send no zone.
 */
export function timezoneFor(utcOffsetMinutes: number): string | undefined {
  if (!Number.isInteger(utcOffsetMinutes) || utcOffsetMinutes % 60 !== 0) return undefined;
  const h = utcOffsetMinutes / 60;
  if (h === 0) return 'Etc/UTC';
  if (h < -12 || h > 14) return undefined;
  return `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`;
}

function shouldPush(ev: OutboundEvent): boolean {
  return ev.kind === 'progress' || ev.kind === 'finished';
}

/**
 * The account's `position_sessions` option. Read directly rather than through
 * store.ts's connectorOptions(): store imports the registry, which imports this
 * file, and that cycle breaks when this module is loaded first (as a test does).
 */
function positionSessionsOn(ctx: ConnectorContext): boolean {
  const row = ctx.db
    .prepare('SELECT options FROM connector_accounts WHERE user_id = ? AND connector_id = ?')
    .get(ctx.userId, 'readwise-books') as { options: string | null } | undefined;
  if (!row?.options) return false;
  try {
    return (JSON.parse(row.options) as Record<string, unknown>).position_sessions === true;
  } catch {
    return false;
  }
}

async function push(cred: Credential, m: Match, ev: OutboundEvent, http: HttpTransport, ctx?: ConnectorContext): Promise<PushResult> {
  if (!shouldPush(ev)) return { ok: true };
  let token: string;
  try {
    token = tokenOf(cred);
  } catch (err) {
    return { ok: false, retryable: false, needsReauth: true, error: (err as Error).message };
  }
  if (rateLimited(token)) return { ok: false, retryable: true, error: 'rate limited' };
  const bookId = Number(m.externalId);
  if (!Number.isSafeInteger(bookId) || bookId <= 0) return { ok: false, retryable: false, error: 'bad book id' };

  // 1) Current shelf state first, so we only write what actually changes.
  const got = await request(token, http, 'GET', `/books?ids=${bookId}`);
  const gotAuth = classify(got);
  if (gotAuth) return gotAuth;
  const book = (got.body as Page<ReadwiseBook> | null)?.results?.[0];
  if (!book) return { ok: false, retryable: false, error: 'book is no longer in your Readwise library' };

  const pct = clamp01(ev.percentage ?? 0);
  const finished = ev.kind === 'finished' || pct >= 0.999;
  if (book.status === 'deleted') {
    return { ok: true, note: 'This book is on your Readwise Deleted shelf, so it is not synced. Restore it on Readwise to resume.' };
  }
  // A shelf the user closed stays closed: never reopen a finished book or
  // override a did-not-finish decision because a device synced again.
  if (book.status === 'finished' || book.status === 'did_not_finish') return { ok: true };

  const when = iso(ev.timestamp > 0 ? ev.timestamp : Math.floor(Date.now() / 1000));
  const patch: Record<string, unknown> = { id: bookId };
  if (finished) {
    patch.status = 'finished';
    patch.finished_reading_at = when;
    if (!book.started_reading_at) patch.started_reading_at = when;
  } else if (book.status !== 'currently_reading') {
    patch.status = 'currently_reading';
    if (!book.started_reading_at) patch.started_reading_at = when;
  } else if (!book.started_reading_at) {
    patch.started_reading_at = when;
  }
  if (Object.keys(patch).length > 1) {
    const r = await request(token, http, 'PATCH', '/books', { items: [patch] });
    const auth = classify(r);
    if (auth) return auth;
    const item = (r.body as { results?: ItemResult[] } | null)?.results?.[0];
    if (!item || item.status !== 'updated') {
      return { ok: false, retryable: false, error: `Readwise did not update the book: ${item?.error ?? 'no result'}` };
    }
  }
  if (finished) return { ok: true };

  // 2) Position, when asked for. Readwise derives `progress` from sessions, so a
  //    session paused for its whole span moves the position and logs no time.
  if (!ctx || !positionSessionsOn(ctx)) return { ok: true };
  const current = typeof book.progress === 'number' ? clamp01(book.progress) : 0;
  if (pct <= current + 0.0005) return { ok: true }; // Readwise is already there or further
  const endSeconds = ev.timestamp > 0 ? ev.timestamp : Math.floor(Date.now() / 1000);
  const r = await request(token, http, 'POST', '/sessions', {
    items: [
      {
        book_id: bookId,
        started_at: iso(endSeconds - POSITION_SESSION_SECONDS),
        ended_at: iso(endSeconds),
        paused_seconds: POSITION_SESSION_SECONDS,
        format: 'ebook',
        percent_at_start: current,
        percent_at_end: pct,
        publish_to_feed: false,
      } satisfies SessionInput,
    ],
  });
  const auth = classify(r);
  if (auth) return auth;
  const item = (r.body as { results?: ItemResult[] } | null)?.results?.[0];
  if (!item || item.status === 'error') {
    // Shelf and dates are synced; only the position write was refused. Surface
    // it on the book instead of failing (and retrying) the whole event.
    return { ok: true, note: `Readwise did not accept the position update: ${item?.error ?? 'no result'}` };
  }
  return { ok: true };
}

export const readwiseBooksConnector: Connector = {
  id: 'readwise-books',
  displayName: 'Readwise Books',
  tier: 1,
  capabilities: { read: false, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'token',
  beta: true,
  matchBy: 'metadata',
  options: [
    {
      key: 'position_sessions',
      label: 'Mirror my reading position (logs zero-time sessions; for readers that send no reading time)',
      default: false,
    },
  ],
  validate,
  shouldPush,
  match,
  createBook,
  push,
  listCurrentlyReading,
  search,
  lookup,
};
