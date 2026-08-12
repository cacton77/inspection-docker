# 3DEXPERIENCE parts catalog integration

Design plan for adding a synchronized local parts catalog to the ViewpointGeneration
inspection cell, with a graphical part picker UI and an eventual JMS event-driven sync path.

---

## Repo structure changes

New host-mounted volume `./catalog` sits alongside the existing `./data`, `./models`, and
`./src` directories. Everything the catalog subsystem persists lives here so it survives
container rebuilds.

```
ViewpointGeneration/
├── docker-compose.yml          # add ./catalog mount
├── catalog/                    # NEW — host-mounted, gitignored
│   ├── catalog.db              # SQLite metadata index
│   ├── steps/                  # cached STEP files
│   │   └── {eng_item_id}/
│   │       └── {revision}.stp
│   └── thumbnails/             # 3DX thumbnail images
│       └── {eng_item_id}.png
├── data/
├── models/
└── src/
    └── viewpoint_generation/
        ├── ...
        ├── catalog/            # NEW — Python package
        │   ├── __init__.py
        │   ├── config.py       # 3DX connection config (env vars)
        │   ├── schema.py       # SQLite table definitions
        │   ├── client.py       # 3DX REST API session wrapper
        │   ├── sync.py         # sync daemon logic
        │   ├── ros_node.py     # ROS2 CatalogService node
        │   └── jms.py          # future JMS event listener
        └── picker/             # NEW — graphical part picker
            ├── __init__.py
            ├── app.py          # main entry point
            ├── templates/
            └── static/
```

### Docker compose addition

```yaml
services:
  viewpoint_gen:
    volumes:
      - ./src:/ws/src
      - ./data:/ws/data
      - ./models:/ws/models
      - ./catalog:/ws/catalog    # <-- new mount
    environment:
      - DX_PASSPORT_URL=${DX_PASSPORT_URL}
      - DX_SPACE_URL=${DX_SPACE_URL}
      - DX_TENANT=${DX_TENANT}
      - DX_USERNAME=${DX_USERNAME}
      - DX_PASSWORD=${DX_PASSWORD}
      - DX_SECURITY_CONTEXT=${DX_SECURITY_CONTEXT}
      - DX_BOOKMARK_SCOPE=${DX_BOOKMARK_SCOPE}
      - CATALOG_DB_PATH=/ws/catalog/catalog.db
      - CATALOG_STEP_DIR=/ws/catalog/steps
      - CATALOG_THUMB_DIR=/ws/catalog/thumbnails
      - CATALOG_SYNC_INTERVAL_SEC=300
```

Credentials come from a `.env` file (gitignored) on the host. The container sees them as
environment variables, and `config.py` loads them with `os.environ`.

---

## SQLite schema

Single-file database at `./catalog/catalog.db`. Three tables.

### parts — one row per known engineering item

```sql
CREATE TABLE IF NOT EXISTS parts (
    eng_item_id     TEXT PRIMARY KEY,   -- 3DX object ID (hex)
    title           TEXT NOT NULL,
    part_number     TEXT,
    revision        TEXT,               -- e.g. "A.1"
    cestamp         TEXT NOT NULL,       -- optimistic concurrency stamp
    maturity        TEXT,               -- IN_WORK, RELEASED, OBSOLETE ...
    type            TEXT,               -- VPMReference, etc.
    collab_space    TEXT,
    description     TEXT,
    thumbnail_url   TEXT,               -- remote 3DX thumbnail URL
    thumbnail_path  TEXT,               -- local path if cached
    step_available  INTEGER DEFAULT 0,  -- 1 if dsdo reports a STEP derived output
    step_path       TEXT,               -- local path if downloaded
    step_cestamp    TEXT,               -- cestamp at time of STEP download
    sync_status     TEXT DEFAULT 'new', -- new | synced | modified | archived
    first_seen      TEXT NOT NULL,      -- ISO timestamp
    last_synced     TEXT NOT NULL        -- ISO timestamp
);
```

### inspection_runs — links a part to completed inspections

```sql
CREATE TABLE IF NOT EXISTS inspection_runs (
    run_id          TEXT PRIMARY KEY,
    eng_item_id     TEXT NOT NULL REFERENCES parts(eng_item_id),
    started_at      TEXT NOT NULL,
    completed_at    TEXT,
    viewpoints_used INTEGER,
    anomalies_found INTEGER,
    result_doc_id   TEXT,               -- 3DX document ID after upload
    status          TEXT DEFAULT 'pending'
);
```

### sync_log — audit trail for debugging

```sql
CREATE TABLE IF NOT EXISTS sync_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,
    action          TEXT NOT NULL,       -- full_sync | incremental | part_added | ...
    eng_item_id     TEXT,
    detail          TEXT
);
```

---

## 3DX REST client (`client.py`)

A `requests.Session`-based wrapper that encapsulates the CAS authentication dance and
CSRF token management. All other modules use it rather than making raw HTTP calls.

```
class DXClient:
    """Authenticated session against a 3DEXPERIENCE tenant."""

    __init__(config: DXConfig)
        # Reads passport URL, space URL, credentials, security context

    login() -> None
        # 1. GET  {passport}/login?action=get_auth_params
        # 2. POST {passport}/login  (username, password, lt)
        #    → session cookies: CASTGC, JSESSIONID
        # 3. GET  {space}/resources/v1/application/CSRF
        #    → store ENO_CSRF_TOKEN for write operations

    search_eng_items(query: str, mask: str) -> list[dict]
        # GET {space}/resources/v1/modeler/dseng/dseng:EngItem
        # ?$searchStr={query}&$mask={mask}
        # Headers: SecurityContext, ENO_CSRF_TOKEN

    get_eng_item(item_id: str, mask: str) -> dict
        # GET {space}/resources/v1/modeler/dseng/dseng:EngItem/{item_id}

    list_derived_outputs(item_id: str) -> list[dict]
        # GET {space}/resources/v1/modeler/dsdo/dsdo:DerivedOutput
        # filtered by parent eng item

    get_fcs_checkout_ticket(file_id: str) -> dict
        # GET {space}/resources/v1/modeler/.../files/{file_id}/checkout

    download_file(fcs_url: str, ticket: str, dest: Path) -> Path
        # GET {fcs_url}?ticket={ticket}
        # Stream binary to dest path

    get_thumbnail(item_id: str) -> bytes | None
        # GET the 3DX thumbnail image for an eng item

    create_document(title: str, collab_space: str) -> str
        # POST to 3DSpace document creation endpoint

    fcs_checkin(doc_id: str, files: list[Path]) -> str
        # Full FCS checkin cycle: ticket → upload → proxy → validate

    attach_document_to_item(doc_id: str, item_id: str) -> None
        # POST dseng relationship
```

---

## Sync daemon (`sync.py`)

Runs as a standalone thread or a ROS2 lifecycle node. The core loop:

```
class CatalogSync:

    __init__(client: DXClient, db_path: Path, config: SyncConfig)

    run_full_sync() -> SyncResult
        """Called on startup and on manual trigger."""
        1. client.login() if session expired
        2. remote_items = client.search_eng_items(
               query=config.bookmark_scope,
               mask="dskern:Mask.Default"
           )
        3. local_items  = db.get_all_parts()
        4. For each remote item:
             local = local_items.get(item.id)
             if local is None:
                 → INSERT with sync_status='new'
                 → fetch thumbnail
                 → check dsdo for STEP availability
             elif local.cestamp != item.cestamp:
                 → UPDATE metadata, set sync_status='modified'
                 → invalidate cached STEP (delete file, clear step_path)
                 → re-check dsdo for STEP availability
                 → re-fetch thumbnail if changed
             else:
                 → touch last_synced, leave sync_status='synced'
        5. For local items not in remote set:
             → set sync_status='archived'
        6. Log to sync_log table
        7. Return SyncResult(added, modified, unchanged, archived)

    run_incremental_sync() -> SyncResult
        """Lightweight check — only queries items modified since last sync."""
        # Uses $modifiedAfter filter on dseng search if available
        # Falls back to full_sync if not supported

    fetch_step(eng_item_id: str) -> Path
        """Lazy download — called when operator selects a part."""
        1. Check if step_path exists and step_cestamp == current cestamp
             → return cached path
        2. Query dsdo for STEP derived output file ID
        3. Get FCS checkout ticket
        4. Stream download to catalog/steps/{id}/{rev}.stp
        5. Update DB: step_path, step_cestamp
        6. Return local path

    prefetch_all_steps() -> None
        """Optional background task for pre-caching during idle."""
        For each part with step_available=1 and step_path IS NULL:
            fetch_step(part.eng_item_id)
```

### Sync schedule

```
┌─────────────────────────────────────────────────────┐
│  Startup           → run_full_sync()                │
│  Every N min       → run_incremental_sync()         │
│  UI refresh button → run_full_sync()                │
│  JMS event (v2)    → handle_event() → targeted sync │
└─────────────────────────────────────────────────────┘
```

---

## ROS2 catalog service node (`ros_node.py`)

Exposes the catalog to the rest of the inspection cell via standard ROS2 service and
topic interfaces.

### Service definitions (`.srv` files)

```
# ListParts.srv
string filter          # optional search string
string maturity_filter  # optional: RELEASED, IN_WORK, etc.
---
PartSummary[] parts
int32 total_count

# SelectPart.srv
string eng_item_id
---
bool success
string step_file_path   # absolute path inside container
string error_message

# SyncNow.srv
---
SyncResult result
```

### Message definitions (`.msg` files)

```
# PartSummary.msg
string eng_item_id
string title
string part_number
string revision
string maturity
string sync_status       # new | synced | modified | archived
bool   step_cached       # true if STEP is already local
string thumbnail_path
```

### Published topics

```
/catalog/part_selected    → PartSelected.msg (eng_item_id, step_path)
/catalog/sync_complete    → SyncResult.msg   (added, modified, archived)
```

The viewpoint generation node subscribes to `/catalog/part_selected` and automatically
loads the STEP file into the PythonOCC pipeline when a part is selected.

---

## Part picker UI (`picker/`)

A graphical browser served as a local web app. The operator opens it in a browser
(or an embedded webview) and sees a grid of available parts with thumbnails.

### Architecture

Flask backend (runs inside the container, port 5050) serving a lightweight frontend.

```
picker/
├── app.py              # Flask routes
│   GET  /              → render part grid
│   GET  /api/parts     → JSON list (feeds the grid)
│   POST /api/select    → trigger SelectPart + publish ROS2 topic
│   POST /api/sync      → trigger SyncNow
│   GET  /api/status    → sync status, last sync time
│   GET  /thumb/{id}    → serve cached thumbnail
├── templates/
│   └── index.html      # single page app shell
└── static/
    ├── style.css
    └── picker.js        # grid rendering, search, selection
```

### UI layout

```
┌──────────────────────────────────────────────────────────┐
│  INSPECTION PARTS CATALOG           [🔄 Sync] [⚙ Config] │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ 🔍 Search parts...                     Filter: All ▾│ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │ [thumb] │ │ [thumb] │ │ [thumb] │ │ [thumb] │       │
│  │         │ │         │ │         │ │         │       │
│  │ Bracket │ │ Flange  │ │ Housing │ │ Cover   │       │
│  │ A.3 REL │ │ B.1 IW  │ │ A.1 REL │ │ A.2 REL │       │
│  │ ● Ready │ │ ◐ Fetch │ │ ● Ready │ │ ○ New   │       │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
│                                                          │
│  ┌─────────┐ ┌─────────┐                                │
│  │ [thumb] │ │ [thumb] │     Last sync: 2 min ago       │
│  │         │ │         │     Parts: 6 (4 ready)         │
│  │ Valve   │ │ Nozzle  │                                │
│  │ C.1 REL │ │ A.1 IW  │                                │
│  │ ● Ready │ │ ○ No STP│                                │
│  └─────────┘ └─────────┘                                │
│                                                          │
│  ═══════════════════════════════════════════════════════  │
│  Selected: Housing A.1  │ [▶ Begin Inspection]           │
└──────────────────────────────────────────────────────────┘
```

### Card states

| Indicator | Meaning                                          |
|-----------|--------------------------------------------------|
| ● Ready   | STEP cached locally, cestamp current, can inspect |
| ◐ Fetch   | STEP available but not yet downloaded             |
| ○ New     | Just appeared in catalog, needs first sync        |
| ◌ No STP  | No STEP derived output on 3DX                     |
| ⟳ Stale   | Remote cestamp changed, need re-download          |

### Click flow

1. Operator clicks a part card.
2. If STEP not cached → picker calls `POST /api/select` → backend calls
   `CatalogSync.fetch_step()` → progress spinner on the card.
3. Once STEP is local → backend calls `SelectPart` ROS2 service → publishes
   `/catalog/part_selected`.
4. Viewpoint generation node receives the message, loads the STEP, runs B-rep
   segmentation + greedy set-cover.
5. UI updates the bottom bar: "Housing A.1 — 14 viewpoints generated — Ready."
6. Operator clicks "Begin Inspection" → inspection pipeline starts.

---

## JMS event integration (phase 2)

The 3DEXPERIENCE platform publishes events on a JMS message bus when objects are
created, modified, or change maturity state. Instead of polling, the sync daemon
subscribes to the relevant topics and reacts in near real-time.

### Architecture

```
3DX JMS Bus ──► STOMP/AMQP Bridge ──► jms.py listener ──► CatalogSync
```

The 3DX JMS bus is internal to the platform. For cloud tenants, Dassault's Enterprise
Integration Framework (EIF) can relay events to an external message broker (RabbitMQ,
ActiveMQ) via a connector. For on-premise, direct STOMP or OpenWire connections are
possible.

### Event types of interest

```
Topic: ds.enovia.engitem.modified
  → cestamp changed on an EngItem in our scope
  → trigger: incremental sync for that specific item

Topic: ds.enovia.engitem.maturity.changed
  → part moved to Released
  → trigger: add to catalog if now in scope

Topic: ds.enovia.bookmark.content.added
  → new item added to the "Inspection Parts" bookmark
  → trigger: add that item to catalog

Topic: ds.enovia.derivedoutput.created
  → STEP generated for an item we're tracking
  → trigger: set step_available=1, optionally prefetch
```

### `jms.py` listener skeleton

```
class JMSEventListener:

    __init__(broker_url: str, catalog_sync: CatalogSync)

    connect() -> None
        # Connect to the bridge broker (STOMP or AMQP)
        # Subscribe to relevant topics with a selector filter
        # for the collaborative space / bookmark scope

    on_message(topic: str, body: dict) -> None
        match topic:
            case "engitem.modified":
                sync.sync_single_item(body["objectId"])
            case "maturity.changed":
                if body["newState"] in config.maturity_filter:
                    sync.sync_single_item(body["objectId"])
            case "bookmark.content.added":
                sync.sync_single_item(body["objectId"])
            case "derivedoutput.created":
                db.set_step_available(body["parentId"], True)

    run() -> None
        # Blocking event loop — runs in its own thread
```

### Fallback

When JMS is not available (cloud tenant without EIF, network restrictions), the
system falls back to polling-based sync automatically. `config.py` checks for
`DX_JMS_BROKER_URL`; if unset, the polling loop runs instead.

---

## Implementation phases

### Phase 1 — Foundation (current sprint)
- [ ] Create `./catalog` directory structure and docker mount
- [ ] Implement `config.py` with env var loading
- [ ] Implement `schema.py` — SQLite table creation and migration
- [ ] Implement `client.py` — CAS auth + CSRF + `dseng` search
- [ ] Implement `sync.py` — full sync loop with cestamp diffing
- [ ] Manual testing via CLI: `python -m catalog.sync --full`
- [ ] Add `.env.example` with placeholder 3DX credentials

### Phase 2 — ROS2 integration
- [ ] Define `.srv` and `.msg` files for CatalogService
- [ ] Implement `ros_node.py` as a lifecycle node
- [ ] Wire `fetch_step()` into `SelectPart` service
- [ ] Publish `/catalog/part_selected` topic
- [ ] Subscribe in viewpoint generation node to auto-load STEP
- [ ] Sync daemon runs as a background thread in the lifecycle node

### Phase 3 — Part picker UI
- [ ] Flask app with API routes
- [ ] Thumbnail fetching and caching
- [ ] Frontend: responsive card grid with search and filter
- [ ] Selection flow: click → fetch → publish → feedback
- [ ] Docker: expose port 5050, add healthcheck
- [ ] Inspection history view (per-part run log)

### Phase 4 — Inspection result upload
- [ ] Implement `create_document()` and `fcs_checkin()` in client.py
- [ ] Implement `attach_document_to_item()` for dseng relationship
- [ ] Post-inspection hook: auto-upload images, point clouds, anomaly JSON
- [ ] Update `inspection_runs` table with `result_doc_id`
- [ ] UI: show upload status on the part card

### Phase 5 — JMS event-driven sync
- [ ] Set up STOMP/AMQP bridge (requires EIF configuration or on-prem access)
- [ ] Implement `jms.py` listener
- [ ] Replace polling loop with event-driven triggers
- [ ] Retain polling as fallback when JMS unavailable
- [ ] Near-real-time catalog updates in the picker UI (WebSocket push)

---

## Configuration reference

All configuration via environment variables (loaded from `.env` on host).

| Variable                  | Example                                       | Required |
|---------------------------|-----------------------------------------------|----------|
| `DX_PASSPORT_URL`         | `https://eu1-ds-iam.3dexperience.3ds.com`     | Yes      |
| `DX_SPACE_URL`            | `https://eu1-space.3dexperience.3ds.com/enovia`| Yes     |
| `DX_TENANT`               | `uw-edu`                                      | Cloud    |
| `DX_USERNAME`             | `colin.acton`                                 | Yes      |
| `DX_PASSWORD`             | (from .env)                                   | Yes      |
| `DX_SECURITY_CONTEXT`     | `VPLMProjectLeader.UW.Common Space`           | Yes      |
| `DX_BOOKMARK_SCOPE`       | `Inspection Parts`                            | Yes      |
| `DX_MATURITY_FILTER`      | `RELEASED,IN_WORK`                            | No       |
| `CATALOG_DB_PATH`         | `/ws/catalog/catalog.db`                      | Yes      |
| `CATALOG_STEP_DIR`        | `/ws/catalog/steps`                           | Yes      |
| `CATALOG_THUMB_DIR`       | `/ws/catalog/thumbnails`                      | Yes      |
| `CATALOG_SYNC_INTERVAL`   | `300` (seconds)                               | No       |
| `DX_JMS_BROKER_URL`       | `stomp://broker:61613`                        | Phase 5  |
| `PICKER_PORT`             | `5050`                                        | No       |
