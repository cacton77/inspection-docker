# 3DEXPERIENCE Integration — Claude Code Agent Prompt

You are implementing a 3DEXPERIENCE platform integration into the
`cacton77/ViewpointGeneration` ROS 2 package. This connects a robotic
inspection cell to Dassault Systèmes' ENOVIA PLM system, enabling
synchronized part catalogs, STEP CAD file ingest, bidirectional inspection
plan exchange, and result upload.

**Working directory:** You are running from the `inspection-docker` repo root,
NOT from inside `ViewpointGeneration`. The ViewpointGeneration ROS 2 packages
live at `src/ViewpointGeneration/` relative to your working directory. All
file paths in this document are relative to the `inspection-docker` root
unless otherwise noted.

## Project context

This is a PhD research project at the University of Washington's MACS Lab.
The inspection cell uses a UR5e robot with structured light and photometric
stereo cameras to perform automated surface inspection of manufactured parts.
The ViewpointGeneration package computes camera viewpoints from CAD models to
achieve full-surface inspection coverage.

The integration connects this cell to 3DEXPERIENCE (Dassault's cloud PLM
platform) so that:

1. The operator sees a catalog of available parts synced from a 3DX bookmark
2. Selecting a part downloads its STEP file and any existing inspection plan
3. STEP files load natively into the viewpoint generation pipeline
4. After inspection, results upload back to 3DX linked to the original CAD

## Design documents

Three design documents define the architecture. Read all three before
starting any implementation. They are located at:

- `docs/3dx_catalog_integration_plan.md` — foundation, catalog sync, picker UI
- `docs/3dx_plan_sync_addendum.md` — inspection plan and result round-trip
- `docs/3dx_step_ingest_addendum.md` — PythonOCC STEP loading and B-rep segmentation

These documents contain SQLite schemas, Python class skeletons, API
sequences, directory structures, and ROS 2 interface definitions. Treat them
as the architectural spec — implement to match their contracts and naming.

## Existing codebase conventions — follow these

### Python style

- The codebase uses standard Python (no type stub files, no mypy).
- Dataclass configs with a `to_dict()` method that returns a dict of
  `{field_name: {value, type, description, control, range}}` for GUI/ROS
  parameter binding. Follow this pattern for any new config classes.
- Algorithm modules (`RegionGrowing`, `PartFieldSegmentation`, `FOVClustering`,
  `ViewpointProjection`) all follow the same shape: a config dataclass, a class
  with a `config` attribute, and a primary method (`segment()`, `fov_clustering()`,
  `generate_viewpoint()`). New modules (`BRepSegmentation`, `CatalogSync`) should
  follow this pattern.
- Error handling uses `(bool, str)` return tuples in `ViewpointGeneration` methods
  (`success, message`). Follow this for new public methods.
- Docstrings are present on all public methods — maintain this.

### ROS 2 conventions

- The package is `ament_python` (not `ament_cmake`).
- Interfaces live in the companion `viewpoint_generation_interfaces` package
  (ament_cmake, uses `rosidl_generate_interfaces`).
- New `.srv` and `.msg` files must be added to the `rosidl_generate_interfaces`
  call in `src/ViewpointGeneration/viewpoint_generation_interfaces/CMakeLists.txt`.
- Services use `std_srvs/srv/Trigger` when no custom request fields are needed.
  Use custom `.srv` files when request or response fields are required.
- Parameters are declared with `ParameterDescriptor` including `description`,
  `floating_point_range` or `integer_range`, and `additional_constraints`
  (used for GUI control type). The `_auto_declare_parameters` helper in
  `viewpoint_generation_node.py` auto-declares from `config.to_dict()` — new
  config classes that follow the `to_dict()` pattern will work with it.
- Node names are lowercase with underscores.
- Service names are namespaced: `/viewpoint_generation/service_name`.
- The existing node is NOT a lifecycle node. The catalog node CAN be a
  lifecycle node if it makes the sync daemon cleaner, but it must interoperate
  with the existing non-lifecycle nodes.

### File organization

```
inspection-docker/                       # ← YOU ARE HERE (working directory)
├── docker/
│   ├── Dockerfile.jazzy                 # Docker image definition
│   ├── requirements.txt                 # Python deps installed at build time
│   └── entrypoint.sh
├── docker-compose.yaml
├── .env                                 # ROS config + 3DX credentials
├── install.sh / connect.sh
├── catalog/                             # NEW — host-mounted, gitignored
│   ├── catalog.db
│   ├── steps/
│   ├── thumbnails/
│   ├── plans/
│   └── results/
├── data/                                # Mesh files, point clouds
├── docs/                                # Design documents
├── models/                              # PartField checkpoint
├── config/                              # DDS and RViz configs
└── src/
    └── ViewpointGeneration/             # ← ROS 2 packages live here
        ├── viewpoint_generation/        # ROS 2 Python package
        │   ├── viewpoint_generation/    # Core Python library
        │   │   ├── viewpoint_generation.py
        │   │   ├── region_growth.py
        │   │   ├── partfield_segmentation.py
        │   │   ├── fov_clustering.py
        │   │   ├── viewpoint_projection.py
        │   │   ├── mesh_utils.py
        │   │   ├── occlusion_search.py
        │   │   ├── catalog/             # NEW
        │   │   └── picker/              # NEW
        │   ├── nodes/
        │   ├── launch/
        │   ├── config/
        │   ├── setup.py
        │   └── package.xml
        ├── viewpoint_generation_interfaces/
        │   ├── srv/
        │   ├── msg/
        │   ├── action/
        │   ├── CMakeLists.txt
        │   └── package.xml
        ├── CLAUDE.md
        └── README.md
```

New catalog and picker code goes in
`src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/catalog/`
and `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/picker/`.
New interface definitions go in
`src/ViewpointGeneration/viewpoint_generation_interfaces/srv/` and
`src/ViewpointGeneration/viewpoint_generation_interfaces/msg/`.

Docker infrastructure files (docker-compose.yaml, docker/requirements.txt,
.env) are at the inspection-docker root — your working directory.

The `catalog/` host directory is also at the inspection-docker root,
alongside `data/`, `models/`, and `src/`.

### Docker context

The system runs in Docker containers managed by THIS repo (`inspection-docker`).
Since you are running from the inspection-docker root, you can directly edit:

- `docker/Dockerfile.jazzy` — Docker image definition
- `docker/requirements.txt` — Python deps (pip-installed at build time)
- `docker-compose.yaml` — container orchestration
- `.env` — environment variables

The Dockerfile is built from `osrf/ros:jazzy-desktop-full` with
CUDA 12.8 + PyTorch 2.7. Host-mounted volumes use these container paths:

| Host path (in inspection-docker) | Container path                    | Purpose                     |
|----------------------------------|-----------------------------------|-----------------------------|
| `./src`                          | `/workspaces/shared_ws/src`       | ROS 2 workspace source      |
| `./data`                         | `/data`                           | Mesh files, point clouds    |
| `./models`                       | `/models`                         | PartField checkpoint        |
| `./catalog` (NEW)                | `/workspaces/shared_ws/catalog`   | SQLite DB, STEP cache, etc. |
| `./config`                       | `/config`                         | DDS and RViz configs        |

**Important:** The design documents reference paths like `/ws/catalog` and
`/ws/data` — these are shorthand. The actual paths inside the container use
the `/workspaces/shared_ws/` prefix for workspace-relative paths and `/data`
for the data directory. When implementing, use the actual container paths.

The working directory inside the container is `/workspaces/shared_ws`.

The container runs as a non-root user (`ros_user`), uses `network_mode: host`,
and the entrypoint sources ROS 2 → `base_ws` → `shared_ws` workspaces in order.

### Dependencies

The `requirements.txt` in ViewpointGeneration is vestigial — all packages are
actually installed by `docker/requirements.txt` in THIS repo (inspection-docker),
via `pip install --break-system-packages -r /tmp/requirements.txt` with
`--extra-index-url https://download.pytorch.org/whl/cu128`.

Since you are running from inspection-docker, you can directly add new
dependencies to `docker/requirements.txt`. After editing, rebuild the image
with `./install.sh`.

New dependencies for this integration:

```
cadquery-ocp>=7.7.2     # OpenCascade bindings for STEP loading (Phase 1.5)
flask>=3.0              # Picker UI web server (Phase 3)
stomp.py>=8.0           # STOMP client for JMS listener (Phase 5)
```

Since you are running from inspection-docker, you can directly add new
dependencies to `docker/requirements.txt`. After adding dependencies,
note the change in the commit message. The image rebuild (`./install.sh`)
is done manually by the operator.

During development and testing, you can install packages interactively
inside the running container:

```bash
pip install cadquery-ocp --break-system-packages
pip install flask --break-system-packages
```

All pip installs inside the Docker container must use `--break-system-packages`.

If `cadquery-ocp` fails to install via pip (wheel availability varies),
fall back to conda:

```bash
conda install -c conda-forge cadquery-ocp
```

### CLAUDE.md

The existing `CLAUDE.md` requires README updates when changing modules,
interfaces, parameters, dependencies, launch files, or the JSON output format.
This integration touches all of these — update the README at the end of each
phase, not at the end of the whole project.

## Implementation phases — execute in order

### Phase 1 — Foundation

**Goal:** CAS authentication works, catalog syncs metadata from a 3DX bookmark,
SQLite database populates correctly.

**Deliver:**

- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/catalog/__init__.py`
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/catalog/config.py`
  - `DXConfig` dataclass loading from env vars
  - `SyncConfig` dataclass (interval, maturity filter, bookmark scope)
  - `CatalogPaths` dataclass (db_path, step_dir, thumb_dir, plan_dir, result_dir)
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/catalog/schema.py`
  - SQLite table creation for `parts`, `plans`, `inspection_runs`, `sync_log`
  - Migration support (check table existence before CREATE)
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/catalog/client.py`
  - `DXClient` class with `requests.Session`
  - `login()` — CAS authentication flow (get LT → POST credentials → get CSRF)
  - `get_security_contexts()` — discover available security contexts for the
    authenticated user via the `e6wCurrentUser` endpoint
  - `search_eng_items()` — dseng search with mask and filter parameters
  - `get_eng_item()` — single item fetch
  - `list_derived_outputs()` — dsdo query for STEP availability
  - `get_thumbnail()` — fetch item thumbnail
  - Session expiry detection and auto-re-login
  - **SecurityContext header handling:** The header value MUST include the
    `ctx::` prefix: `ctx::VPLMProjectLeader.Company Name.Colin Acton Space`.
    When used in URL query parameters, this must be URL-encoded
    (`ctx%3A%3AVPLMProjectLeader.Company%20Name.Colin%20Acton%20Space`).
    When used as an HTTP header value, use the unencoded form.
    The env var `DX_SECURITY_CONTEXT` stores the full prefixed string.
  - **Tenant ID handling:** Cloud 3DX deployments require a `tenant` query
    parameter on most API calls (e.g. `?tenant=R1132100093385`). The env var
    `DX_TENANT` stores this value. Append it to all 3DSpace API requests.
  - **Split-region topology:** This tenant's IAM (passport) is in `eu1`
    while the data services (3DSpace) are in `usw2` — different subdomains:
    `r1132100093385-eu1-academia.iam.3dexperience.3ds.com` for login vs.
    `r1132100093385-usw2-academia-space.3dexperience.3ds.com` for API calls.
    The CAS login authenticates against the passport domain and returns
    session cookies. These cookies must then be sent to the space domain.
    `requests.Session` does NOT forward cookies across different domains
    by default. You must either: (a) manually copy the session cookies from
    the passport response and set them on requests to the space domain,
    or (b) follow the CAS service-ticket redirect flow, which has the
    passport redirect back to the space domain with a service ticket that
    establishes a space-domain session cookie. The redirect flow (option b)
    is the correct CAS approach — the `login()` method should POST to
    the passport with `service={space_url}` as a parameter, then follow
    the redirect to the space domain to obtain the space session cookie.
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/catalog/sync.py`
  - `CatalogSync` class
  - `run_full_sync()` — enumerate remote items, cestamp diff, update DB
  - `run_incremental_sync()` — lightweight check
  - `fetch_step()` — lazy STEP download via FCS checkout
  - Directory creation on first run
- `.env.example` at inspection-docker root with all `DX_*` and `CATALOG_*` env var placeholders
- `.gitignore` additions: add `catalog/` to inspection-docker's `.gitignore`
- CLI entry point: `python -m viewpoint_generation.catalog.sync --full`

**Test:** Run `--full` sync against the UW EDU 3DX tenant. Verify `catalog.db`
contains rows with correct titles, part numbers, cestamps. Verify thumbnails
download to `catalog/thumbnails/`.

### Phase 1.5 — PythonOCC STEP ingest

**Goal:** STEP files load into the existing pipeline and produce identical
downstream behavior to STL files. B-rep segmentation works as a third algorithm.

**Deliver:**

- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/step_loader.py`
  - `TessellationConfig` dataclass
  - `BRepFace` dataclass
  - `StepLoadResult` dataclass
  - `load_step()` function — STEP read → tessellate → Open3D mesh + B-rep mapping
  - `_classify_surface()` — OCC surface type to string
  - `_build_brep_adjacency()` — face adjacency from shared edges
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/brep_segmentation.py`
  - `BRepSegmentationConfig` with `to_dict()` following existing pattern
  - `BRepSegmentation` class with `segment(mesh, step_data)` method
  - Small-face merging and same-type merging
- Modifications to `viewpoint_generation.py`:
  - Add `step_data` attribute
  - Format dispatch in `_load_scaled_mesh()` for `.stp`/`.step` extensions
  - `_load_step_mesh()` method
  - Register `'brep'` in `set_segmentation_algorithm()`
  - Add `'brep'` dispatch in `_segment_surface()`
  - Instantiate `BRepSegmentation` and `BRepSegmentationConfig`
  - Add `surface_type` and `brep_face_ids` to results JSON when available
- Modifications to `viewpoint_generation_node.py`:
  - Auto-declare `BRepSegmentationConfig` parameters under `regions.brep.` prefix
  - Add `'brep'` to valid values for `regions.algorithm` parameter
- Add `cadquery-ocp>=7.7.2` to `docker/requirements.txt`
- `src/ViewpointGeneration/viewpoint_generation/package.xml` and
  `src/ViewpointGeneration/README.md` updates

**Test:** Load a STEP file (use a test part from the data directory or download
one from the catalog). Verify:

- Mesh loads without error, has correct vertex/triangle counts
- `step_data.brep_faces` has the expected number of B-rep faces
- `region_growth` segmentation works on the tessellated mesh
- `brep` segmentation produces regions matching B-rep face count
- `fov_clustering` and `project_viewpoints` complete successfully
- Results JSON contains `surface_type` annotations

**Critical detail:** The `merge_close_vertices(1e-8)` call after tessellation
is essential. Without it, `RegionGrowing`'s edge-based face adjacency detection
fails at B-rep face boundaries because adjacent faces have coincident but
non-shared vertices. Verify adjacency works across B-rep face boundaries.

### Phase 2 — ROS 2 integration

**Goal:** Catalog is accessible as a ROS 2 node with service interfaces.
Selecting a part triggers STEP download and pipeline loading.

**Deliver:**

- New interface definitions in `src/ViewpointGeneration/viewpoint_generation_interfaces/`:
  - `srv/ListParts.srv`
  - `srv/SelectPart.srv`
  - `srv/SyncNow.srv`
  - `srv/EnsurePlan.srv`
  - `msg/PartSummary.msg`
  - `msg/PartSelected.msg`
  - `msg/SyncResult.msg`
  - Update `CMakeLists.txt` to include new interfaces
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/catalog/ros_node.py`
  - `CatalogNode` extending `rclpy.node.Node`
  - Service handlers for ListParts, SelectPart, SyncNow, EnsurePlan
  - Publisher for `/catalog/part_selected` and `/catalog/sync_complete`
  - Background sync thread (timer-based)
  - Parameter declarations for sync interval, bookmark scope, etc.
- New node executable in `nodes/catalog_node.py`
- `setup.py` update: add `catalog_node` entry point
- Launch file update or new launch file for catalog node
- Wire `ViewpointGenerationNode` to subscribe to `/catalog/part_selected`
  and auto-load the STEP file + plan when a part is selected

**Test:** Launch both nodes. Call `ListParts` service, verify response.
Call `SelectPart`, verify STEP downloads and `ViewpointGeneration` loads it.

### Phase 3 — Part picker UI

**Goal:** A graphical web UI served from inside the container shows part
thumbnails in a card grid. Clicking a card triggers the full SelectPart flow.

**Deliver:**

- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/picker/app.py` — Flask routes
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/picker/templates/index.html`
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/picker/static/style.css`
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/picker/static/picker.js`
- API routes as specified in the plan:
  - `GET /` — render part grid
  - `GET /api/parts` — JSON part list
  - `POST /api/select` — trigger SelectPart
  - `POST /api/sync` — trigger SyncNow
  - `GET /api/status` — sync status
  - `GET /thumb/<id>` — serve cached thumbnail
  - `GET /api/parts/<id>/plan` — plan status
  - `GET /api/parts/<id>/runs` — inspection history
- Card states: Ready, Fetch, New, No STP, Stale
- Plan status indicator on cards
- Expandable detail panel on click
- Search and maturity filter
- Docker port exposure (5050) — update `docker-compose.yaml` if needed
- Add `flask>=3.0` to `docker/requirements.txt`

**Test:** Open `http://localhost:5050` in browser. Verify parts appear with
thumbnails. Click a part, verify the full pipeline triggers. Verify sync
button refreshes the catalog.

### Phase 4 — Plan and result sync

**Goal:** Inspection plans round-trip between the cell and 3DX. Post-inspection
results upload with full traceability.

**Deliver:**

- Envelope wrap/unwrap in `catalog/sync.py`:
  - `_build_envelope()` — wrap results JSON with PLM context
  - `_unwrap_envelope()` — extract plan payload
- `client.py` additions:
  - `list_related_documents()` — find documents attached to EngItem
  - `download_document_file()` — FCS checkout for document files
  - `upload_inspection_plan()` — create Document + FCS checkin + attach
  - `upload_result_bundle()` — multi-file FCS checkin
  - `revise_document()` — create new Document revision
  - `create_issue()` — dsiss Issue creation for NCR workflow
- `sync.py` additions:
  - `ensure_plan()` — check local → check remote → download if found
  - `upload_plan()` — wrap + upload + attach
  - `upload_results()` — bundle + upload + optional auto-NCR
- New service definitions:
  - `srv/UploadPlan.srv`
  - `srv/UploadResults.srv`
- Updated `SelectPart` flow: fetch STEP → ensure plan → load or generate
- Post-inspection hook in catalog node
- Picker UI additions: upload status, inspection history table

**Test:** Generate a plan, verify it uploads to 3DX with correct document
title and EngItem relationship. Delete local plan, re-select part, verify
it downloads from 3DX. Run a mock inspection, verify result bundle uploads.

### Phase 5 — JMS event-driven sync

**Goal:** Replace polling with event-driven sync when a JMS broker is available.
Fall back to polling when it's not.

**Deliver:**

- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/catalog/jms.py`
  - `JMSEventListener` class
  - STOMP or AMQP connection to bridge broker
  - Event handlers for engitem.modified, maturity.changed,
    bookmark.content.added, derivedoutput.created
  - Reconnection logic
- `config.py` update: `DX_JMS_BROKER_URL` env var (optional)
- `ros_node.py` update: start JMS listener thread if broker URL configured,
  otherwise fall back to timer-based polling
- WebSocket push from picker UI for real-time catalog updates

**Test:** This phase requires EIF/broker infrastructure. Implement the
listener and test with a mock STOMP broker. Document the EIF configuration
needed for production use.

## General instructions

- Work one phase at a time. Complete and test each phase before moving to the next.
- After each phase, update `src/ViewpointGeneration/README.md` per the CLAUDE.md requirement.
- After each phase, update `src/ViewpointGeneration/CLAUDE.md` if new maintenance rules apply.
- This integration touches two repos from one working directory. Before
  starting any work, create and check out feature branches in both repos:

  ```bash
  cd src/ViewpointGeneration && git checkout -b feature-3dx-integration && cd ../..
  git checkout -b feature-3dx-integration
  ```

  All work happens on these branches. Commit changes to both repos with
  appropriate prefixes:
  - ViewpointGeneration changes: `feat(catalog): Phase 1 — sync daemon, CAS auth`
  - inspection-docker changes: `feat(docker): add catalog volume mount and 3DX env vars`
  Push both branches periodically so work is not lost.
- Do not modify existing module behavior unless the design documents
  explicitly specify a modification (e.g., `_load_scaled_mesh()` format
  dispatch). The downstream pipeline must continue working for STL/OBJ files.
- When the design documents specify a class skeleton or method signature,
  implement it with that exact name and signature. Other code may reference
  it by name.
- Use `logging` (Python stdlib) for catalog module logging, not `print()`.
  The ROS node should use `self.get_logger()` as the existing node does.
- All new files should have module-level docstrings.
- SQLite operations should use context managers (`with sqlite3.connect(...)`)
  and parameterized queries (never string interpolation for SQL).
- The FCS upload/download flow is the least well-documented part of the 3DX
  API. Expect to iterate on it. The design documents describe the logical
  sequence; exact endpoint paths may need adjustment based on the tenant's
  API version. Use Postman to validate endpoints before coding if possible.
