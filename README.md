# @pipeworx/global-fishing-watch

Global Fishing Watch API v3 — AIS-derived vessel identity, at-sea events
(apparent fishing, encounters, loitering, port visits, AIS gaps) and aggregated
apparent fishing effort.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `gfwfish_vessels_search(query, datasets?, limit?, offset?, _apiKey)` — vessel
  identity by name, MMSI, IMO or call sign.
- `gfwfish_events(start_date, end_date, vessel_id?, event_type?, limit?,
  offset?, _apiKey)` — events over a date range.
- `gfwfish_4wings_report(bbox, start_date, end_date, group_by?,
  temporal_resolution?, spatial_resolution?, datasets?, _apiKey)` — apparent
  fishing effort aggregated over a bounding box.

## Auth

**Platform-backed since 2026-09-18.** `PLATFORM_GFW_FISHING_TOKEN` is in the
encrypted keystore (GFW API application "pipeworx", non-commercial intended
use); the gateway injects it as `_apiKey`, and a caller may pass their own
instead. Every v3 endpoint requires a Bearer token — there is no keyless or
demo path. Free non-commercial tokens:
<https://globalfishingwatch.org/our-apis/tokens>.

Distinct from `PLATFORM_GFW_KEY`, which is Global Forest **Watch** — different
organisation, different API, similar abbreviation.

`licence: non-commercial` is set on the pack: GFW data is free for
non-commercial use and commercial use needs their permission.

## Data sources

- <https://gateway.api.globalfishingwatch.org/v3/vessels/search>
- <https://gateway.api.globalfishingwatch.org/v3/events>
- <https://gateway.api.globalfishingwatch.org/v3/4wings/report> (POST; the
  region geometry goes in the body, the resolution/grouping in the query
  string)

**A 401 from this API proves nothing about the path.** An unauthenticated
request to any path — including one that does not exist, verified against
`/v3/zzz-not-a-path` on 2026-09-17 — answers `401 {"error":"invalid token"}`.
That is why the shapes shipped on 2026-09-17 were unverifiable, and why the
first probe on a real token returned a 422.

**The two paging schemes are different, and mixing them is the 422.**
`/v3/vessels/search` pages by CURSOR: the response carries `since`, you pass it
back as `since`, and sending `offset` is rejected `422 Unprocessable Entity`.
`/v3/events` pages the ordinary way — `offset` and `limit` are both required,
and the response carries `nextOffset`. Do not unify them.

Other shape facts, each from the v3 docs and then proved live (fleet #2245):

- Multi-value parameters use indexed square brackets: `datasets[0]=...`,
  `vessels[0]=...`, `filters[0]=...`.
- `/v3/vessels/search` needs at least 3 characters in `query`; `limit` maxes at
  50. **A `since` cursor carries its own page size** — pass `since` with a
  smaller `limit` and you still get the original page's worth back, so do not
  read `returned` as proof the limit was honoured (measured live: limit 2 plus a
  cursor from a limit-5 call returned 5).
- Every repeated parameter on this endpoint takes INDEXED brackets:
  `datasets[0]`, `includes[0]`. The bare `includes[]` form is a 422. Identity is nested under two parallel arrays — `selfReportedInfo` (what
  the vessel broadcast) and `registryInfo` (what a registry holds) — which can
  disagree. The pack lifts the common fields and keeps both arrays.
- `/v3/events` takes `start-date` / `end-date` on GET (hyphenated) but
  `startDate` / `endDate` in a POST body (camelCase). This pack uses GET.
- `/v3/4wings/report` is a POST: the grid parameters go in the query string
  (`spatial-resolution`, `temporal-resolution`, `group-by`, `date-range` as
  `YYYY-MM-DD,YYYY-MM-DD`, `format=JSON`) and the AREA goes in the body — either
  a named region, `{"region":{"dataset":"public-eez-areas","id":8371}}`, or a
  custom polygon under a top-level `"geojson"` key. `temporal-resolution` is one
  of HOURLY, DAILY, MONTHLY, YEARLY, ENTIRE. Its `entries` are arrays of grouped
  rows rather than rows, so the pack flattens them.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "global-fishing-watch": {
      "url": "https://gateway.pipeworx.io/global-fishing-watch/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/global-fishing-watch/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/gfwfish_vessels_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"ARCTIC LOON","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/gfwfish_vessels_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "global-fishing-watch": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-global-fishing-watch"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-global-fishing-watch
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Global Fishing Watch data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
