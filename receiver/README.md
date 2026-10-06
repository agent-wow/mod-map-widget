# Map widget receiver

Standalone Bun service with plain browser JavaScript and no frontend build. Start with `bun run start`.
See [module installation and OBS controls](../README.md).

## Startup settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAP_WIDGET_HOST` | `127.0.0.1` | Listener address |
| `MAP_WIDGET_PORT` | `3003` | Listener port |
| `MAP_WIDGET_BEARER_TOKEN` | empty | Optional POST ingestion token |
| `MAP_WIDGET_STATE_BYTES` | `268435456` | In-memory state/catalogue byte budget |
| `MAP_WIDGET_CACHE` | `./data/maps.sqlite` | Persistent image/manifest cache, relative to working directory |
| `MAP_WIDGET_CACHE_BYTES` | `268435456` | Maximum cached image content bytes |
| `MAP_WIDGET_ARTWORK_MODE` | `hosted` | `hosted` or cached-only `offline` |
| `MAP_WIDGET_DEMO_ENDPOINT` | `http://127.0.0.1:3003/maps` | Synthetic demo destination only |

Byte budgets accept integers from 8 MiB through 1 GiB. Binding beyond loopback exposes the GET routes;
use your network/reverse proxy access controls. TLS termination belongs at the reverse proxy.
The module's bearer token is sent only to its configured ingestion endpoint.

## Interfaces

| Method and route | Behavior |
| --- | --- |
| `POST /maps` | Schema-1 character panel/presence batch |
| `POST /catalogs` | Schema-1 atomic catalogue chunks |
| `GET /api/characters?source=realm-1` | Character discovery, optionally filtered by `character` |
| `GET /api/map?source=realm-1&character=Alice` | Current selected state, or `null` while waiting |
| `GET /api/map/stream?source=realm-1&guid=...` | SSE snapshots, presence and panel changes |
| `GET /api/catalog?source=...&process=...&revision=...` | Exact source/process/revision catalogue |
| `GET /api/terrain?map=0` | Selected original-client terrain metadata |
| `GET /assets/world/12.jpg` | Validated, cached Wrath parchment |
| `GET /assets/terrain/<map>/<hash>/<zoom>/<y>/<x>.png` | Validated, cached terrain tile |
| `GET /widget?source=realm-1&character=Alice&view=both` | Transparent OBS browser widget |

Character state/stream routes require a source and exactly one `character` or `guid`. An optional
`panel=motion`, `markers`, `quests`, or `all` narrows those APIs. Names pin to GUIDs, and collisions
return 409. There is no unfiltered character fallback. Ingestion authentication does not apply to GETs.

The definitive types/validators are in [src/schema.ts](src/schema.ts), with complete synthetic payloads
in [examples/fixtures.ts](examples/fixtures.ts). An envelope has `schema_version: 1`, `source_id`,
`process_id`, and `updates`. Each update has `guid`, `name`, `panel`, `sequence`, `age_ms`,
`catalog_revision`, and `data`. Sequences are positive uint64 **decimal strings**, never JSON numbers.
Presence data contains `presence` (`online`, `offline`, `unavailable`) and, when online, the three
panel `revisions`. Catalogue envelopes contain `revision`, `chunk_index`, `chunk_count`, and `entries`;
entry kinds are `areas`, `continents`, `floors`, and `transforms`.
Position `facing` values are finite radians and need not be normalized to 0–2π: core spline movement
can produce negative headings, and single-precision full turns can round slightly above 2π.

Ordering is per source/process/character/panel. A fresh new process retires the old process; delayed
old-process packets cannot reactivate it. Capture age is added to receiver elapsed time, so retries
do not make old samples fresh. Presence revisions distinguish unchanged content from missed updates.
A panel newer than the advertised revision is already usable; only older revisions are pending.
State and SSE headers include the advertised `revisions`, allowing the browser to reconcile independently
delivered motion and presence events. The widget retains its last confirmed position through delivery
gaps for up to five seconds; fresh heartbeats advertising a missing position do not extend this grace.
Missing catalogue revisions return 409 and trigger sender replay. Catalogue chunks publish atomically.
Character state is intentionally in memory; receiver restarts rebuild it from capture refreshes.

POSTs require uncompressed UTF-8 `application/json`; optional authentication uses
`Authorization: Bearer <token>`. Limits: 8 MiB/request, 100 updates/batch, 2 MiB/panel, four concurrent
uploads, three-second body deadline, 64 catalogue chunks and 5,000 entries/chunk. Relevant responses:
204 accepted, 400 malformed request, 401 unauthorized, 409 missing catalogue/ambiguous name,
413 oversized body, 415 unsupported content, 422 invalid schema, 503 capacity/retry. Invalid batches
do not partially update state. At most 128 SSE clients are accepted, each with a bounded 4 MiB buffer.

SSE sends `snapshot` on generation changes, then `presence` and individual `panel` events. New connections
get current state; there is no unbounded event history and no requirement for `Last-Event-ID`. Slow clients
coalesce changes and disconnect after sustained backpressure. Browsers reconnect with a bounded delay,
retry catalogue loading and retain their selected character GUID. Stop with SIGINT or SIGTERM.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun test
```

These checks use synthetic data, temporary loopback listeners, injected clocks and temporary caches.
They require neither a game server nor provider availability. For visual testing, run a separate
receiver and `bun run demo`, then inspect all three OBS dimensions from the module README. Exercise
manual floors/browsing, follow restoration, minimap border zoom controls, tracking and quest selection, stale
state after stopping the demo, and `Offline`, `Dungeon`, `Unknown` and long-label fixtures.
Use `MAP_WIDGET_DEMO_SPLIT_UPDATES=1 bun run demo` to alternate panel-first and presence-first delivery
with a 50 ms gap. Continuous movement should not dim the maps or flash a waiting-for-position message.
