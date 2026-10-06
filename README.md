# mod-map-widget

Live, fully revealed minimap and world-map overlays for OBS, with WotLK-style frames. Includes an
independent AzerothCore C++ module, a Bun receiver, and transparent browser widgets. No core patch,
SQL installation, client addon, sibling module, or frontend build is required.

## Installation

Place this directory at `modules/mod-map-widget`. AzerothCore discovers its scripts, configuration,
and module tests through the normal module configure/build/install workflow. Copy the installed
`mod_map_widget.conf.dist` to `mod_map_widget.conf` and set:

```ini
MapWidget.Enable = 1
MapWidget.Endpoint = "http://127.0.0.1:3003/maps"
MapWidget.SourceId = "realm-1"
MapWidget.Characters = "Alice"
```

Restart worldserver to apply settings. The endpoint must end in `/maps`; metadata goes to the sibling
`/catalogs` route. An empty endpoint disables capture and delivery. Give each concurrently running
worldserver its own source ID. An empty character allowlist captures all online characters.

Use Bun 1.4.2 or newer on the receiving machine. From `receiver/`:

```sh
bun run start
```

Runtime packages do not need to be installed. The receiver defaults to `127.0.0.1:3003` and can run
without AzerothCore or MySQL. See [receiver setup and interfaces](receiver/README.md).
For remote ingestion use HTTPS through a reverse proxy, a matching ingestion bearer token on both
ends, and the receiver's `MAP_WIDGET_HOST` setting. The module verifies TLS certificates and supports
a custom CA file. GET routes are unauthenticated: keep the receiver on a trusted network or protect
them at the proxy. Never put the ingestion token in an OBS URL.

External modules are ignored by the parent AzerothCore repository. Preserve this complete directory
in a separate module repository or deployment archive.

## OBS sources

Add a Browser source with the following URL, substituting the source and character:

```text
http://127.0.0.1:3003/widget?source=realm-1&character=Alice&view=minimap
```

| View | URL value | Suggested width × height |
| --- | --- | --- |
| Minimap | `view=minimap` | 320 × 350 |
| World map | `view=map` | 1000 × 640 |
| Both | `view=both` | 1340 × 640 |

Use `guid=<URL-encoded full GUID>` instead of `character=Alice` for explicit selection. Names are
case-insensitive and pin to a GUID after resolution. Ambiguous names require an explicit GUID.
`GET /api/characters?source=realm-1` lists available characters and GUIDs.

Use OBS **Interact** to operate the controls. The minimap stays north-up, with zoom buttons on its
lower-right border, a facing arrow, location label, coordinates, tooltips, and tracking filters. The world map
has continent/zone/instance selection, manual floors, zoom buttons or mouse wheel, and drag-to-pan.
Browsing suspends following until **Follow player** is pressed. The tracking menu sits in the world-map
toolbar or below the minimap and opens over the artwork, without reserving a footer row. It
selects quests independently of the client's quest-watch list. Settings affect only the
current browser widget; they never send gameplay commands. Reloading resets presentation settings.

Player, party/raid, corpse, services, mailboxes, questgiver, tracked creature/resource, guard-direction,
and quest objective/completion markers are supported. Completed quests use `?` markers. World maps
include quest-POI polygons; minimaps show nearby objective centroids. The server's quest-POI data must
contain geometry for a quest to appear. Overlay filters cannot reveal objects the server did not capture.

Five seconds without fresh presence freezes and dims the display. Logout and transfer clear live
markers while allowing artwork browsing. Movement interpolates over 100 ms; map, instance, phase,
floor, and large position changes snap immediately. Positions on moving transports use world coordinates.

Frames use the same translucent charcoal panels, thin gold borders, and Trebuchet text as the character
and unit widgets. Optional OBS custom CSS:

```css
:root {
  --mini-size: 240px;
  --map-width: 1000px;
  --map-height: 620px;
  --font: "Trebuchet MS", Arial, sans-serif;
  --gold: #ddc188;
  --panel: linear-gradient(120deg, #292929eb, #111111e6 70%);
  --frame: var(--panel);
  --frame-border: #a9956a;
  --ink: #eee;
  --muted: #aaa;
}
```

Increase the OBS source dimensions when increasing the CSS dimensions.

## Capture and delivery

All `MapWidget.*` settings are startup-only; see [the configuration template](conf/mod_map_widget.conf.dist).
Movement defaults to 100 ms, with nearby markers and active quests reconciled every second. Capture
runs in `WorldScript::OnUpdate`, after map workers join, with at most 32 character captures per world
update. Busy realms can sample less frequently; a character allowlist keeps the intended streaming
characters within the capture budget.

Objects are inspected only during capture. Visibility, client visibility, spawn state, phase and
instance are checked. Service NPCs must be alive and non-hostile. Creature/resource tracking follows
the player's server tracking fields, including caster-specific stalked creatures. Resource locks and
fishing-hole tracking determine resource markers. The nearby search is bounded to 400 yards and
512 markers; a visible notice reports truncation. Party members must share the map, instance and phase.

Outgoing `SMSG_QUESTGIVER_STATUS`, `SMSG_QUESTGIVER_STATUS_MULTIPLE`, and `SMSG_GOSSIP_POI` are observed
without changing packets or triggering quest/gossip scripts. Packet observations use a cached account
identity and copied values; they never dereference a player from the network thread. Questgiver icons
appear after the ordinary client status packets. The latest guard direction remains until replaced
or a map/instance/phase change. Active quest log entries provide quest status and quest-POI geometry.

The worker receives copied JSON only. A bounded queue coalesces by character and panel; failed deliveries
cannot overwrite newer pending records. Panels are `motion`, `markers`, and `quests`, with separate
decimal-string revisions and presence heartbeats. Changed content and periodic full refreshes are sent;
quest geometry never travels inside motion records. Refreshes occur at the next content sample after
three seconds. HTTP failures retry with bounded exponential backoff, `Retry-After` support and capture
age preservation. Records expire after five seconds. A receiver restart requests catalogue replay with
HTTP 409 and recovers automatically as fresh panels arrive.

## Metadata and artwork

At startup the module reads these extracted WotLK files from worldserver's `DataDir/dbc`:

- `WorldMapArea.dbc`: physical map, area, world-map ID, virtual map and zone bounds.
- `WorldMapContinent.dbc`: continent grid, offsets, scale and world-map association.
- `WorldMapTransforms.dbc`: relocation rectangles and offsets, including the Outland starting zones.
- `DungeonMap.dbc` and `DungeonMapChunk.dbc`: floor bounds and WMO group/height associations.

Core `Zone2MapCoordinates` helpers provide effective zone bounds, including loaded database overrides.
The supplemental tables add fields not retained by the core. Reload DBC changes by restarting worldserver.
Metadata is published as an atomic, versioned, source/process-specific catalogue. Missing tables degrade
the affected projection rather than substituting guessed bounds. Automatic floors use WMO group and
height thresholds; ambiguous or absent matches leave the floor unknown for manual selection.

Game map IDs, area IDs, world-map IDs and provider asset IDs stay separate. Projection explicitly swaps
the server's X/Y axes, applies relocation transforms only to continent views, and uses floor-specific
bounds. Terrain placement uses the provider's cropped ADT origin, tile zoom, and 512-pixel native ADTs.
Continent layout offsets are retained as metadata and are not mistaken for zone or terrain bounds.

World-map artwork uses the verified Wowhead/ZAM Wrath image path:
`https://wow.zamimg.com/images/wow/wrath/maps/enus/original/<area>[-<floor>].jpg`.
Continent artwork uses the provider's distinct IDs: Eastern Kingdoms `-3`, Kalimdor `-6`, Outland `-2`,
and Northrend `-5`. Floor assets are explicitly mapped from the provider's Wrath zone metadata;
Dalaran DBC floors 1/2 correspond to artwork suffixes 0/1. Terrain uses
[Marlamin's map.wow.tools](https://github.com/Marlamin/map.wow.tools) manifest and `tiles.wow.tools`.
For each terrain map the receiver selects the newest available original-client 1.x/2.x/3.x version
no later than build 12340. This can be earlier than 3.3.5a; Classic and later-expansion artwork is excluded.
The receiver requests identifiers only, with an explicit widget User-Agent; it never sends character
names, gameplay payloads, tokens, or arbitrary client-supplied URLs to an artwork provider.

All artwork is proxied through a persistent, 256 MiB image-content LRU cache. Downloads are deduplicated,
limited to four concurrent requests and 32 pending images, and capped at 2 MiB per image with a five-second
deadline. Failures are negatively cached for one minute. The last valid terrain manifest survives
receiver restarts and provider outages. Cached artwork can be used with `MAP_WIDGET_ARTWORK_MODE=offline`.
SQLite bookkeeping and manifest storage are additional to the image-content budget.

Maps are fully revealed. Missing/unprojectable maps explicitly report unavailable; no other expansion
or guessed bounds are substituted. The hosted terrain does not provide reliable indoor WMO layers,
so indoor minimaps report unavailable; supported dungeon parchment floors remain browsable. Custom
client artwork, fog of war, and exact synchronization with the client's map/zoom/watch UI are outside
this version. Hosted providers can change or remove assets.

## Validation and synthetic preview

From `receiver/`:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run start
# In another terminal, against this separate synthetic receiver:
bun run demo
```

Demo characters under `realm-1` are `Alice`, `Offline`, `Dungeon`, `Unknown`, and
`A very long character name for layout checks`. Stop the demo to inspect stale state; use `Dungeon`
for an ICC floor and `Unknown` for unavailable artwork. Do not run it against a receiver ingesting
the same source from a real server. `MAP_WIDGET_DEMO_ENDPOINT` changes its destination.
Set `MAP_WIDGET_DEMO_SPLIT_UPDATES=1` to exercise separately delivered movement and presence updates;
the demo alternates their order to check for flicker while moving.

Receiver tests cover schema validation, ordering, process retirement, auth, capacity, catalogue replay,
SSE reconnection, provider selection, negative caching, deduplication, persistent cache eviction and
projection fixtures for Elwynn, relocated Eversong, Dalaran and ICC. C++ tests cover the WDBC parser,
floor ambiguity, coordinate bounds, phase/instance/tracking filters, copied packet observations,
coalescing, expiry, retry ordering, HTTP deadlines and TLS transport. They register with the existing
module-test machinery: after an explicitly requested core test build, run
`unit_tests --gtest_filter='MapWidget*'`.

Run the repository C++ checker from this module directory:
`python3 ../../apps/codestyle/codestyle-cpp.py`. No SQL files are installed or changed.

## License and attribution

Authored code is GPL-2.0-or-later; see [LICENSE](LICENSE). Capture/delivery/receiver patterns adapt
[agent-wow/mod-char-widget](https://github.com/agent-wow/mod-char-widget) commit `a1e6417`, by hazim-j
(Hazim Jumali), including the revisioned panels and presence approach. Its queue and receiver patterns
derive from [mod-unit-widget](https://github.com/agent-wow/mod-unit-widget) commit `bcc630b`; HTTP/TLS
transport and fixtures derive from [mod-chat-widget](https://github.com/agent-wow/mod-chat-widget)
commit `81b5154`, also by hazim-j. Preserve these credits when redistributing.

The terrain coordinate convention adapts `js/leaflet_wowmap.js` from Marlamin's map.wow.tools commit
`522433d43a45b60e231c295ee773e99ce93b4d8b`, by Martin Benjamins (Marlamin), under the
[retained MIT license](licenses/map.wow.tools.MIT). Supplemental field layouts were checked against
[WoWDBDefs](https://github.com/wowdev/WoWDBDefs/tree/master/definitions) and the local WotLK DBCs.
The vendored nlohmann/json 3.12.0 header retains Niels Lohmann's MIT license in
`vendor/nlohmann/LICENSE.MIT`. Bun, TypeScript, and Bun type definitions retain their own licenses.
Test TLS keys/certificates are public fixtures, not deployment credentials.

Map imagery and World of Warcraft belong to Blizzard Entertainment. Wowhead/ZAM and Marlamin/wow.tools
provide the hosted artwork; their artwork is not relicensed by this module. Provider credits are retained
here rather than occupying space in the OBS overlay. No game artwork is bundled in the source.

Provider asset identifiers were verified against [Wowhead's Wrath maps](https://www.wowhead.com/wotlk/maps),
its `maps.js` continent menu and public `nether.wowhead.com/wotlk/data/zones` floor catalogue.
