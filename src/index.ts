interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Global Fishing Watch — AIS-derived fishing vessel identity, at-sea events (apparent fishing, vessel-to-vessel encounters, loitering, port visits, AIS gaps) and aggregated apparent fishing effort by flag, gear type and area.
 *
 * Every endpoint on gateway.api.globalfishingwatch.org requires a Bearer
 * token — there is no keyless or demo path (an unauthenticated request to any
 * path, real or invented, answers `401 {"error":"invalid token"}`, so a 401
 * here proves nothing about the path). Tokens are free for non-commercial use
 * after registration; the platform token is injected as `_apiKey`, and a caller
 * may pass their own instead.
 *
 * SHAPES ARE NOW VERIFIED (fleet #2245, 2026-09-18). They were originally
 * written from documentation alone, because with no token every request — to a
 * real path or an invented one — answered 401, so nothing could be told apart.
 * The first probe on the real token returned 422 on vessels/search: paging
 * there is a `since` CURSOR, not an `offset`, and sending offset is rejected.
 * Events paginate the other way (offset/limit/nextOffset), so the two endpoints
 * genuinely differ — do not unify them. Each tool below now names the live call
 * that proved it.
 */


const BASE = 'https://gateway.api.globalfishingwatch.org/v3';
const UA = 'pipeworx-mcp-global-fishing-watch/1.0 (+https://pipeworx.io)';
const KEY_HELP =
  'Get one free for non-commercial use at globalfishingwatch.org/our-apis/tokens: sign in, request an API access token, and pass it here.';
const NO_KEY = `Global Fishing Watch requires an API key. Pass your own Bearer token via _apiKey — every endpoint on this API is authenticated and there is no public or demo path. ${KEY_HELP}`;

async function pwFetch(url: string, key: string, init?: RequestInit): Promise<Response> {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
    ...(init?.headers ?? {}),
  };
  return fetchWithTimeout(url, { ...init, headers }, 'Global Fishing Watch');
}

const tools: McpToolExport['tools'] = [
  {
    name: 'gfwfish_vessels_search',
    description:
      'Search the Global Fishing Watch vessel identity database by name, MMSI, IMO or call sign. Returns each matching vessel with its GFW vessel id (pass it to gfwfish_events), flag state, gear type, registry names and the AIS transmission window. AUTHORITATIVE for identifying a fishing or carrier vessel across flag and name changes. Requires your own free GFW API token, passed as _apiKey.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Vessel name, MMSI, IMO or call sign — at least 3 characters, e.g. "ARCTIC LOON" or "224224000".' },
        datasets: { type: 'string', description: 'Comma-separated GFW vessel datasets. Default "public-global-vessel-identity:latest".' },
        limit: { type: 'number', description: 'Max vessels to return (1-50, default 10).' },
        since: { type: 'string', description: 'Paging CURSOR from a previous call\'s next_since. This endpoint pages by cursor, not by offset — an offset argument is rejected upstream.' },
        includes: { type: 'string', description: 'Comma-separated extras to return: MATCH_CRITERIA, OWNERSHIP, AUTHORIZATIONS.' },
        _apiKey: { type: 'string', description: `Your own Global Fishing Watch API token (BYO). ${KEY_HELP}` },
      },
      required: ['query'],
    },
  },
  {
    name: 'gfwfish_events',
    description:
      'Global Fishing Watch vessel events over a date range — apparent fishing, encounters between vessels at sea, loitering, port visits and AIS gaps (transmission switched off). Each event carries its position, start/end time and the vessels involved. Answers "where was this vessel fishing", "did it meet another vessel at sea", "did it go dark". Requires your own free GFW API token, passed as _apiKey.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        vessel_id: { type: 'string', description: 'GFW vessel id from gfwfish_vessels_search (comma-separate for several). Omit to search all vessels in the window.' },
        event_type: { type: 'string', description: 'One of "fishing", "encounter", "loitering", "port_visit", "gap". Default "fishing".' },
        start_date: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'End date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Max events to return (1-100, default 20).' },
        offset: { type: 'number', description: 'Skip this many events (default 0). Events page by offset; the response returns next_offset.' },
        _apiKey: { type: 'string', description: `Your own Global Fishing Watch API token (BYO). ${KEY_HELP}` },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'gfwfish_4wings_report',
    description:
      'Aggregate apparent fishing effort (hours) from Global Fishing Watch over a bounding box and date range, grouped by flag state, gear type or vessel. This is the AIS-derived fishing-pressure layer behind the GFW map — use it for "how much fishing happened in this area, by whose fleet". Requires your own free GFW API token, passed as _apiKey.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        bbox: { type: 'string', description: 'Bounding box as "minLon,minLat,maxLon,maxLat" in WGS84, e.g. "-80,-10,-70,0". Required unless you pass region_id instead.' },
        region_id: { type: 'string', description: 'A named GFW region id instead of a bbox — e.g. an EEZ id such as "8371". Takes precedence over bbox.' },
        region_dataset: { type: 'string', description: 'Which region dataset region_id belongs to. Default "public-eez-areas"; also "public-mpa-all" and "public-rfmo".' },
        start_date: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'End date, YYYY-MM-DD.' },
        group_by: { type: 'string', description: 'One of "FLAG", "GEARTYPE", "VESSEL_ID", "FLAGANDGEARTYPE", "MMSI". Default "FLAG".' },
        temporal_resolution: { type: 'string', description: 'One of "HOURLY", "DAILY", "MONTHLY", "YEARLY", "ENTIRE". Default "ENTIRE".' },
        spatial_resolution: { type: 'string', description: 'One of "LOW" (0.1 degree) or "HIGH" (0.01 degree). Default "LOW".' },
        datasets: { type: 'string', description: 'Comma-separated GFW effort datasets. Default "public-global-fishing-effort:latest".' },
        filters: { type: 'string', description: 'Comma-separated upstream filter expressions, e.g. "geartype in (\'trawlers\')".' },
        _apiKey: { type: 'string', description: `Your own Global Fishing Watch API token (BYO). ${KEY_HELP}` },
      },
      required: ['start_date', 'end_date'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const key = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  if (!key) throw new Error(NO_KEY);
  switch (name) {
    case 'gfwfish_vessels_search': {
      const q = reqStr(args, 'query', '"ARCTIC LOON"');
      if (q.length < 3) throw new Error('Global Fishing Watch needs at least 3 characters in "query".');
      const p = new URLSearchParams();
      p.set('query', q);
      p.set('limit', String(clamp(numArg(args.limit, 10), 1, 50)));
      // Paging here is a CURSOR, not an offset. Sending `offset` is a 422 from
      // the vendor (measured 2026-09-18); the response carries `since`, which
      // is what you pass back for the next page. /v3/events is the opposite.
      if (typeof args.since === 'string' && args.since.trim()) p.set('since', args.since.trim());
      // Indexed brackets, like datasets[0] — the bare `includes[]` form is a
      // 422 on this endpoint (measured live 2026-09-18).
      for (const [i, inc] of listArg(args.includes).entries()) p.append(`includes[${i}]`, inc.toUpperCase());
      for (const [i, ds] of datasetList(args.datasets, 'public-global-vessel-identity:latest').entries()) {
        p.append(`datasets[${i}]`, ds);
      }
      const body = (await getJson(`${BASE}/vessels/search?${p}`, key)) as VesselSearchResponse;
      const entries = Array.isArray(body.entries) ? body.entries : [];
      return {
        query: q,
        total: body.total ?? entries.length,
        returned: entries.length,
        next_since: body.since ?? null,
        did_you_mean: body.metadata?.didYouMean ?? null,
        vessels: entries.map(summariseVessel),
        source: 'Global Fishing Watch API v3 vessel identity (gateway.api.globalfishingwatch.org)',
        licence: 'Global Fishing Watch data is free for non-commercial use; commercial use needs their permission.',
      };
    }
    case 'gfwfish_events': {
      const start = reqDate(args, 'start_date');
      const end = reqDate(args, 'end_date');
      const type = String(args.event_type ?? 'fishing').toLowerCase();
      const dataset = EVENT_DATASETS[type];
      if (!dataset) {
        throw new Error(`Unknown event_type "${type}". Use one of: ${Object.keys(EVENT_DATASETS).join(', ')}.`);
      }
      const p = new URLSearchParams();
      p.append('datasets[0]', dataset);
      p.set('start-date', start);
      p.set('end-date', end);
      // offset and limit are REQUIRED on /v3/events (unlike /v3/vessels/search,
      // where offset is a 422 and paging is the `since` cursor). Always send
      // both; the response's `nextOffset` is what you pass back.
      p.set('limit', String(clamp(numArg(args.limit, 20), 1, 100)));
      p.set('offset', String(Math.max(0, numArg(args.offset, 0))));
      for (const [i, v] of listArg(args.vessel_id).entries()) p.append(`vessels[${i}]`, v);
      const body = (await getJson(`${BASE}/events?${p}`, key)) as EventsResponse;
      const entries = Array.isArray(body.entries) ? body.entries : [];
      return {
        event_type: type,
        dataset,
        start_date: start,
        end_date: end,
        vessel_id: typeof args.vessel_id === 'string' ? args.vessel_id : null,
        total: body.total ?? entries.length,
        returned: entries.length,
        next_offset: body.nextOffset ?? null,
        events: entries.map(summariseEvent),
        source: 'Global Fishing Watch API v3 events (gateway.api.globalfishingwatch.org)',
        licence: 'Global Fishing Watch data is free for non-commercial use; commercial use needs their permission.',
      };
    }
    case 'gfwfish_4wings_report': {
      const start = reqDate(args, 'start_date');
      const end = reqDate(args, 'end_date');
      const groupBy = enumArg(args.group_by, GROUP_BY, 'FLAG', 'group_by');
      const temporal = enumArg(args.temporal_resolution, TEMPORAL_RES, 'ENTIRE', 'temporal_resolution');
      const spatial = enumArg(args.spatial_resolution, SPATIAL_RES, 'LOW', 'spatial_resolution');
      const p = new URLSearchParams();
      p.set('spatial-resolution', spatial);
      p.set('temporal-resolution', temporal);
      p.set('group-by', groupBy);
      p.set('date-range', `${start},${end}`);
      p.set('format', 'JSON');
      for (const [i, ds] of datasetList(args.datasets, 'public-global-fishing-effort:latest').entries()) {
        p.append(`datasets[${i}]`, ds);
      }
      for (const [i, f] of listArg(args.filters).entries()) p.append(`filters[${i}]`, f);

      // Two ways to name the area, and they are different request bodies.
      // A named region is the documented path ({"region":{"dataset","id"}});
      // a bbox becomes a custom polygon under the top-level "geojson" key.
      let region: Record<string, unknown>;
      const regionId = args.region_id;
      if (regionId !== undefined && regionId !== null && String(regionId).trim() !== '') {
        const regionDataset = typeof args.region_dataset === 'string' && args.region_dataset.trim()
          ? args.region_dataset.trim()
          : 'public-eez-areas';
        region = { region: { dataset: regionDataset, id: String(regionId) } };
      } else {
        const bbox = parseBbox(reqStr(args, 'bbox', '"-80,-10,-70,0"'));
        region = {
          geojson: {
            type: 'Polygon',
            coordinates: [[
              [bbox[0], bbox[1]],
              [bbox[2], bbox[1]],
              [bbox[2], bbox[3]],
              [bbox[0], bbox[3]],
              [bbox[0], bbox[1]],
            ]],
          },
        };
      }

      const res = await pwFetch(`${BASE}/4wings/report?${p}`, key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(region),
      });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) throw new Error(`${NO_KEY} (upstream answered ${res.status})`);
      if (!res.ok) throw new Error(`Global Fishing Watch: ${res.status} ${summarizeErrorBody(text)}`);
      const body = safeJson(text) as FourWingsResponse | null;
      // The report comes back as entries[] where each entry is itself an array
      // of grouped rows — flattening it here is the difference between a usable
      // answer and a nested blob the caller has to reverse-engineer.
      const raw = Array.isArray(body?.entries) ? body!.entries! : [];
      const rows: unknown[] = [];
      for (const e of raw) {
        if (Array.isArray(e)) rows.push(...e);
        else if (e && typeof e === 'object') {
          for (const v of Object.values(e as Record<string, unknown>)) {
            if (Array.isArray(v)) rows.push(...v);
          }
        }
      }
      return {
        area: 'region_id' in args && String(args.region_id ?? '') !== ''
          ? { region_dataset: args.region_dataset ?? 'public-eez-areas', region_id: String(args.region_id) }
          : { bbox: args.bbox },
        start_date: start,
        end_date: end,
        group_by: groupBy,
        temporal_resolution: temporal,
        spatial_resolution: spatial,
        row_count: rows.length,
        rows,
        source: 'Global Fishing Watch API v3 apparent fishing effort (gateway.api.globalfishingwatch.org)',
        licence: 'Global Fishing Watch data is free for non-commercial use; commercial use needs their permission.',
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

interface VesselSearchResponse {
  entries?: RawVessel[];
  total?: number;
  since?: string;
  metadata?: { didYouMean?: unknown };
}
interface RawVessel {
  dataset?: string;
  registryInfo?: Record<string, unknown>[];
  selfReportedInfo?: Record<string, unknown>[];
  combinedSourcesInfo?: unknown;
}
interface EventsResponse {
  entries?: Record<string, unknown>[];
  total?: number;
  nextOffset?: number | null;
}
interface FourWingsResponse {
  entries?: unknown[];
}

const GROUP_BY = ['VESSEL_ID', 'FLAG', 'GEARTYPE', 'FLAGANDGEARTYPE', 'MMSI'];
const TEMPORAL_RES = ['HOURLY', 'DAILY', 'MONTHLY', 'YEARLY', 'ENTIRE'];
const SPATIAL_RES = ['LOW', 'HIGH'];

/**
 * A vessel entry nests its identity under two parallel arrays — what the vessel
 * broadcast about itself (selfReportedInfo) and what a registry says
 * (registryInfo) — and they can disagree, which is the point. Lift the common
 * fields to the top so an answer is readable, and keep both arrays so the
 * disagreement is still inspectable.
 */
function summariseVessel(v: RawVessel): Record<string, unknown> {
  const self = Array.isArray(v.selfReportedInfo) ? v.selfReportedInfo[0] ?? {} : {};
  const reg = Array.isArray(v.registryInfo) ? v.registryInfo[0] ?? {} : {};
  const pick = (k: string): unknown => self[k] ?? reg[k] ?? null;
  return {
    vessel_id: pick('id') ?? pick('vesselId'),
    shipname: pick('shipname') ?? pick('nShipname'),
    flag: pick('flag'),
    imo: pick('imo'),
    mmsi: pick('ssvid'),
    callsign: pick('callsign'),
    vessel_type: pick('shiptype') ?? pick('vesselType'),
    gear_type: pick('geartypes') ?? pick('geartype'),
    transmission_start: pick('transmissionDateFrom'),
    transmission_end: pick('transmissionDateTo'),
    dataset: v.dataset ?? null,
    self_reported_info: v.selfReportedInfo ?? [],
    registry_info: v.registryInfo ?? [],
  };
}

/** Events nest position under `position` and the vessel under `vessel`; lift
 *  the few fields every caller wants and keep the raw event alongside. */
function summariseEvent(e: Record<string, unknown>): Record<string, unknown> {
  const pos = (e.position ?? {}) as Record<string, unknown>;
  const vessel = (e.vessel ?? {}) as Record<string, unknown>;
  return {
    event_id: e.id ?? null,
    type: e.type ?? null,
    start: e.start ?? null,
    end: e.end ?? null,
    lat: pos.lat ?? null,
    lon: pos.lon ?? null,
    vessel_id: vessel.id ?? null,
    vessel_name: vessel.name ?? null,
    vessel_flag: vessel.flag ?? null,
    regions: e.regions ?? null,
    detail: e,
  };
}

const EVENT_DATASETS: Record<string, string> = {
  fishing: 'public-global-fishing-events:latest',
  encounter: 'public-global-encounters-events:latest',
  loitering: 'public-global-loitering-events:latest',
  port_visit: 'public-global-port-visits-events:latest',
  gap: 'public-global-gaps-events:latest',
};

/** Accept either a comma-separated string or a real array for repeated
 *  `name[i]=` parameters — the router fills these both ways. */
function listArg(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s2) => s2.trim()).filter(Boolean);
  return [];
}

function enumArg(v: unknown, allowed: string[], fallback: string, argName: string): string {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const up = String(v).trim().toUpperCase();
  if (!allowed.includes(up)) {
    throw new Error(`"${argName}" must be one of ${allowed.join(', ')}; got "${String(v)}".`);
  }
  return up;
}

function datasetList(v: unknown, fallback: string): string[] {
  const raw = typeof v === 'string' && v.trim() ? v : fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBbox(s: string): number[] {
  const parts = s.split(',').map((x) => Number(x.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`bbox must be "minLon,minLat,maxLon,maxLat" with four numbers; got "${s}".`);
  }
  if (parts[0] >= parts[2] || parts[1] >= parts[3]) {
    throw new Error(`bbox "${s}" is not ordered min,min,max,max — minLon must be < maxLon and minLat < maxLat.`);
  }
  return parts;
}

async function getJson(url: string, key: string): Promise<unknown> {
  const res = await pwFetch(url, key);
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error(`${NO_KEY} (upstream answered ${res.status})`);
  if (!res.ok) throw new Error(`Global Fishing Watch: ${res.status} ${summarizeErrorBody(text)}`);
  const body = safeJson(text);
  if (body === null) throw new Error(`Global Fishing Watch returned a non-JSON response: ${summarizeErrorBody(text)}`);
  return body;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function reqStr(args: Record<string, unknown>, k: string, ex: string): string {
  const v = args[k];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${k}" is missing. Pass a string like ${ex}.`);
  return v.trim();
}
function reqDate(args: Record<string, unknown>, k: string): string {
  const v = reqStr(args, k, '"2024-01-01"');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`"${k}" must be a date as YYYY-MM-DD; got "${v}".`);
  return v;
}
function numArg(v: unknown, d: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
