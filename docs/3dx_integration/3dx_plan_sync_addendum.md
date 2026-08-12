# Inspection plan and result sync — addendum

Extension to the 3DX catalog integration plan. Covers bidirectional sync of viewpoint
inspection plans and post-inspection result upload, creating full traceability from
CAD revision to inspection outcome inside the PLM record.

---

## The traceability chain

Every inspection produces a three-link chain inside ENOVIA:

```
Engineering Item (CAD)
  └── Inspection Plan (Document)         ← viewpoint JSON
        └── Inspection Result (Document)  ← images, point clouds, anomaly JSON
```

Each link is a specification relationship on the EngItem. The Plan document is
both an output of the viewpoint generation pipeline and an input to the
inspection execution pipeline. Results reference the Plan they were executed
against, so the chain is: which CAD revision → which plan → what was found.

---

## Inspection plan envelope

The existing results JSON from ViewpointGeneration is the payload. For 3DX
round-tripping, wrap it in a thin envelope that adds PLM-relevant metadata
without changing the existing schema.

### File naming convention

```
PLAN_{part_number}_{revision}_{timestamp}.json
```

Example: `PLAN_BRK-1042_A.3_20260811T143022Z.json`

### Envelope schema

```json
{
  "envelope_version": "1.0",
  "type": "inspection_plan",

  "plm_context": {
    "eng_item_id": "A3F7E2...",
    "part_number": "BRK-1042",
    "revision": "A.3",
    "cestamp": "8B2C4D...",
    "collab_space": "Common Space",
    "plan_doc_id": null,
    "generated_at": "2026-08-11T14:30:22Z",
    "generated_by": "colin.acton",
    "cell_id": "alpha",
    "software_version": "ViewpointGeneration@abc1234"
  },

  "pipeline_config": {
    "segmentation_algorithm": "partfield",
    "partfield": {
      "num_parts": 12,
      "use_agglo": true,
      "option": 0,
      "with_knn": false
    },
    "fov_clustering": {
      "fov_diameter": 0.03,
      "dof": 0.02,
      "point_density": 10.0,
      "lambda_weight": 1.0,
      "beta_weight": 1.0,
      "point_weight": 1.0,
      "normal_weight": 1.0
    },
    "viewpoint_projection": {
      "focal_distance": 0.3,
      "hemisphere_points": 10000
    },
    "selected_traversal_algorithm": "LKH"
  },

  "summary": {
    "num_regions": 8,
    "num_clusters": 42,
    "num_viewpoints": 42,
    "mesh_file": "BRK-1042_A.3.stp",
    "mesh_units": "m",
    "mesh_dimensions": "(LxWxH): 0.14 x 0.09 x 0.10 m",
    "surface_area_m2": 0.03,
    "point_cloud_size": 10000
  },

  "plan": {
    // ... the existing ViewpointGeneration JSON verbatim ...
    // (the contents of the "meshes" array and all nested structure)
  }
}
```

The `plan` field contains the existing results JSON exactly as `save_results()`
produces it today. No changes to the core library are needed — the envelope
is assembled by the catalog module at upload time and stripped at download time.

### Why an envelope instead of modifying the existing schema

The current JSON is consumed by multiple downstream nodes (viewpoint_traversal,
gui, task_planning). Adding PLM fields to the root would break those consumers
or require coordinated changes across the repo. The envelope keeps the existing
`meshes` array untouched inside `plan`, and the catalog module handles
wrap/unwrap at the 3DX boundary.

---

## Plan validity and CAD revision binding

An inspection plan is valid only for the CAD revision it was generated against.
The `plm_context.cestamp` field records which specific revision state the plan
targets. When a part is selected in the picker:

```
1. Load local plan (if any) from catalog/plans/{eng_item_id}/
2. Compare plan's cestamp against the part's current cestamp in catalog.db
3. If match  → plan is current, load into pipeline
4. If mismatch → plan is stale:
     - Show warning in picker UI: "Plan was generated for rev A.2,
       current is A.3 — re-plan recommended"
     - Operator can choose to re-plan or inspect with stale plan
     - If re-plan → new plan replaces old, upload to 3DX
5. If no plan exists → run viewpoint generation from scratch
```

The stale-plan warning is important because geometry changes between revisions
may invalidate viewpoints (collision, coverage gaps). But in practice many
revisions are non-geometric (metadata, BOM changes), so forcing a re-plan on
every cestamp change would be wasteful. The operator makes the call.

---

## Download flow: 3DX → cell

When a part is selected and no local plan exists (or the local plan is stale),
the catalog checks 3DX for an existing plan.

### API sequence

```
1. Search for Documents attached to the EngItem
   GET /resources/v1/modeler/dseng/dseng:EngItem/{id}
       ?$mask=dskern:Mask.SpecificationRelation
   → returns related documents

2. Filter for documents matching the naming convention
   Title starts with "PLAN_" and type = "Inspection Plan"
   (or a custom 3DX type if configured)

3. If found:
   a. Get the latest plan document (by revision or timestamp)
   b. FCS checkout → download the JSON file
   c. Unwrap envelope → extract "plan" payload
   d. Write to catalog/plans/{eng_item_id}/{plan_doc_id}.json
   e. Validate plan cestamp against current part cestamp
   f. Load into ViewpointGeneration pipeline (or flag as stale)

4. If not found:
   → No existing plan, operator runs viewpoint generation
```

### `client.py` additions

```python
def list_related_documents(self, eng_item_id: str,
                           title_prefix: str = None) -> list[dict]:
    """List Documents attached to an EngItem via specification relation."""
    # GET {space}/resources/v1/modeler/dseng/dseng:EngItem/{id}
    #     ?$mask=dskern:Mask.SpecificationRelation
    # Filter results by title_prefix if provided

def download_document_file(self, doc_id: str, dest: Path) -> Path:
    """Download the primary file from a Document via FCS checkout."""
    # 1. GET document file list
    # 2. Get FCS checkout ticket for the file
    # 3. Stream binary to dest
```

---

## Upload flow: cell → 3DX

After viewpoint generation completes (or after the operator confirms the plan),
the catalog uploads the envelope JSON to 3DX and links it to the EngItem.

### API sequence

```
1. Wrap the results JSON in the envelope
   - Populate plm_context from catalog.db
   - Extract summary stats from the plan
   - Write envelope to catalog/plans/{eng_item_id}/PLAN_...json

2. Check if a plan Document already exists for this EngItem
   - If yes and same cestamp → update (new revision of the Document)
   - If yes but different cestamp → create new Document (new plan for new CAD rev)
   - If no → create new Document

3. Create or revise the Document
   POST /resources/v1/modeler/dsdoc/... (or 3DSpace document API)
   → get doc_id

4. FCS checkin cycle
   a. Request checkin ticket (1 file)
   b. Upload PLAN_*.json to FCS
   c. Create proxy, validate checkin

5. Attach Document to EngItem (if new)
   POST dseng relationship (specification connection)

6. Update catalog.db
   - plans.plan_doc_id = doc_id
   - plans.uploaded_at = now
   - plans.upload_status = 'synced'
```

### `client.py` additions

```python
def upload_inspection_plan(self, eng_item_id: str,
                           plan_path: Path,
                           title: str,
                           collab_space: str) -> str:
    """Upload an inspection plan JSON and attach to EngItem.
    Returns the created Document ID."""
    # Orchestrates: create doc → FCS checkin → attach relationship

def revise_document(self, doc_id: str) -> str:
    """Create a new revision of an existing Document.
    Returns the new revision's Document ID."""
```

---

## Result upload flow

Post-inspection, the result bundle (images, point clouds, anomaly JSON) is
uploaded as a separate Document linked to both the EngItem and the Plan.

### Result bundle structure

```
catalog/results/{eng_item_id}/{run_id}/
├── result_manifest.json       # metadata + anomaly summary
├── images/
│   ├── cluster_00_ps.png      # photometric stereo composite
│   ├── cluster_00_normal.png  # normal map
│   ├── cluster_01_ps.png
│   └── ...
├── point_clouds/
│   ├── region_00.ply
│   └── ...
└── anomaly_report.json        # per-cluster anomaly scores + locations
```

### Result manifest schema

```json
{
  "envelope_version": "1.0",
  "type": "inspection_result",

  "plm_context": {
    "eng_item_id": "A3F7E2...",
    "part_number": "BRK-1042",
    "revision": "A.3",
    "cestamp": "8B2C4D...",
    "plan_doc_id": "D9E1F0...",
    "result_doc_id": null
  },

  "run_context": {
    "run_id": "run_20260811_151022",
    "cell_id": "alpha",
    "started_at": "2026-08-11T15:10:22Z",
    "completed_at": "2026-08-11T15:24:18Z",
    "operator": "colin.acton"
  },

  "summary": {
    "viewpoints_executed": 42,
    "viewpoints_skipped": 0,
    "regions_inspected": 8,
    "anomalies_detected": 3,
    "max_anomaly_score": 0.87,
    "overall_result": "FAIL",
    "total_images": 84,
    "total_point_cloud_files": 8
  },

  "anomalies": [
    {
      "id": "anom_001",
      "region_index": 2,
      "cluster_index": 5,
      "score": 0.87,
      "type": "surface_defect",
      "location_on_surface": [0.042, -0.018, 0.091],
      "bounding_box_mm": [3.2, 1.8],
      "image_file": "images/cluster_05_ps.png",
      "description": "Linear surface scratch, ~3mm length"
    }
  ],

  "files": [
    {"path": "images/cluster_00_ps.png", "type": "image", "size_bytes": 245000},
    {"path": "point_clouds/region_00.ply", "type": "point_cloud", "size_bytes": 1200000}
  ]
}
```

### Upload sequence

```
1. Assemble result bundle in catalog/results/{eng_item_id}/{run_id}/

2. Create a Document in 3DX
   Title: RESULT_{part_number}_{revision}_{run_id}
   Type: "Inspection Result"

3. FCS checkin with multiple files
   - Manifest JSON (primary file)
   - All images
   - All point cloud files
   - Anomaly report JSON

4. Attach Document to EngItem (specification relationship)

5. Optionally: if anomalies detected and severity > threshold
   → create an Issue (dsiss) linked to the EngItem
   → populate with anomaly summary for NCR workflow

6. Update catalog.db
   - inspection_runs.result_doc_id = doc_id
   - inspection_runs.status = 'uploaded'
```

---

## Schema additions

### New table: plans

```sql
CREATE TABLE IF NOT EXISTS plans (
    plan_id         TEXT PRIMARY KEY,    -- local UUID
    eng_item_id     TEXT NOT NULL REFERENCES parts(eng_item_id),
    plan_doc_id     TEXT,                -- 3DX Document ID (null if not uploaded)
    cestamp         TEXT NOT NULL,        -- CAD cestamp this plan targets
    file_path       TEXT NOT NULL,        -- local path to envelope JSON
    num_regions     INTEGER,
    num_clusters    INTEGER,
    num_viewpoints  INTEGER,
    seg_algorithm   TEXT,                -- region_growth | partfield
    traversal_algo  TEXT,                -- greedy | LKH
    generated_at    TEXT NOT NULL,
    uploaded_at     TEXT,
    upload_status   TEXT DEFAULT 'local', -- local | uploading | synced | failed
    is_current      INTEGER DEFAULT 1,   -- 1 = active plan for this part
    source          TEXT DEFAULT 'local'  -- local | remote (downloaded from 3DX)
);
```

### Extended inspection_runs table

```sql
CREATE TABLE IF NOT EXISTS inspection_runs (
    run_id          TEXT PRIMARY KEY,
    eng_item_id     TEXT NOT NULL REFERENCES parts(eng_item_id),
    plan_id         TEXT REFERENCES plans(plan_id),    -- which plan was executed
    started_at      TEXT NOT NULL,
    completed_at    TEXT,
    viewpoints_executed INTEGER,
    viewpoints_skipped  INTEGER DEFAULT 0,
    anomalies_found INTEGER,
    max_anomaly_score REAL,
    overall_result  TEXT,                -- PASS | FAIL | INCOMPLETE
    result_bundle_path TEXT,             -- local path to result bundle dir
    result_doc_id   TEXT,                -- 3DX Document ID after upload
    upload_status   TEXT DEFAULT 'pending', -- pending | uploading | uploaded | failed
    status          TEXT DEFAULT 'running'  -- running | completed | aborted
);
```

---

## Sync daemon additions (`sync.py`)

### Plan sync on part selection

```python
def ensure_plan(self, eng_item_id: str) -> PlanStatus:
    """Check for a current inspection plan, downloading from 3DX if needed."""

    local_plan = db.get_current_plan(eng_item_id)
    part = db.get_part(eng_item_id)

    if local_plan and local_plan.cestamp == part.cestamp:
        return PlanStatus.CURRENT

    if local_plan and local_plan.cestamp != part.cestamp:
        # Check 3DX for an updated plan
        remote_plan = self._find_remote_plan(eng_item_id, part.cestamp)
        if remote_plan:
            self._download_plan(remote_plan, eng_item_id)
            return PlanStatus.UPDATED_FROM_REMOTE
        return PlanStatus.STALE

    # No local plan at all — check 3DX
    remote_plan = self._find_remote_plan(eng_item_id, part.cestamp)
    if remote_plan:
        self._download_plan(remote_plan, eng_item_id)
        return PlanStatus.DOWNLOADED

    return PlanStatus.NONE


def upload_plan(self, eng_item_id: str, results_json_path: Path) -> str:
    """Wrap results JSON in envelope and upload to 3DX."""
    part = db.get_part(eng_item_id)
    envelope = self._build_envelope(part, results_json_path)
    envelope_path = self._write_envelope(envelope, eng_item_id)
    doc_id = client.upload_inspection_plan(
        eng_item_id, envelope_path,
        title=f"PLAN_{part.part_number}_{part.revision}",
        collab_space=part.collab_space
    )
    db.upsert_plan(eng_item_id, envelope_path, doc_id, part.cestamp)
    return doc_id


def upload_results(self, run_id: str) -> str:
    """Upload an inspection result bundle to 3DX."""
    run = db.get_run(run_id)
    part = db.get_part(run.eng_item_id)
    doc_id = client.upload_result_bundle(
        eng_item_id=run.eng_item_id,
        bundle_path=Path(run.result_bundle_path),
        title=f"RESULT_{part.part_number}_{part.revision}_{run.run_id}",
        collab_space=part.collab_space
    )
    db.update_run(run_id, result_doc_id=doc_id, upload_status='uploaded')

    if run.anomalies_found and run.max_anomaly_score > config.ncr_threshold:
        client.create_issue(
            eng_item_id=run.eng_item_id,
            title=f"Inspection anomaly: {part.part_number} {part.revision}",
            description=self._format_anomaly_summary(run)
        )

    return doc_id
```

---

## ROS2 service additions

### New service definitions

```
# EnsurePlan.srv
string eng_item_id
---
string status          # CURRENT | DOWNLOADED | UPDATED_FROM_REMOTE | STALE | NONE
string plan_file_path  # local path to the plan JSON (plan payload, not envelope)
string message

# UploadPlan.srv
string eng_item_id
string results_json_path   # path to the ViewpointGeneration results JSON
---
bool success
string plan_doc_id
string message

# UploadResults.srv
string run_id
---
bool success
string result_doc_id
string message
```

### Updated SelectPart flow

```
SelectPart(eng_item_id)
  1. fetch_step()           → ensure STEP is local
  2. ensure_plan()          → check for existing plan
  3. If plan exists and current:
       → load plan JSON into ViewpointGeneration (skip pipeline)
       → publish /catalog/part_selected with plan_status=CURRENT
  4. If plan is stale:
       → publish /catalog/part_selected with plan_status=STALE
       → UI shows warning, operator decides
  5. If no plan:
       → publish /catalog/part_selected with plan_status=NONE
       → viewpoint generation pipeline runs from scratch
  6. After pipeline completes (new plan generated):
       → auto-call upload_plan()
       → plan is now in 3DX for future use by any cell
```

---

## Part picker UI additions

### Plan status indicators on part cards

```
┌─────────┐
│ [thumb] │
│         │
│ Bracket │
│ A.3 REL │
│ ● Ready │   ← STEP cache status (unchanged)
│ ◈ Plan  │   ← NEW: plan status line
└─────────┘
```

| Indicator    | Meaning                                          |
|--------------|--------------------------------------------------|
| ◈ Plan       | Current plan exists (local or remote), cestamp OK |
| ◈ Stale plan | Plan exists but for older CAD revision           |
| ○ No plan    | No inspection plan — will generate on selection   |
| ↑ Uploading  | Plan or results currently syncing to 3DX         |

### Expanded part detail panel

When a part card is clicked, expand a detail panel below the grid:

```
═══════════════════════════════════════════════════════════════
 Bracket (BRK-1042)  Rev A.3  Released  Synced 2 min ago

 Inspection Plan
 ├── Status: Current (matches cestamp 8B2C4D)
 ├── Generated: 2026-08-10 09:15 by colin.acton on cell alpha
 ├── Segmentation: PartField (12 parts)
 ├── 8 regions → 42 clusters → 42 viewpoints
 ├── Traversal: LKH
 └── 3DX Document: PLAN_BRK-1042_A.3  [View in 3DX ↗]

 Inspection History
 ┌──────────────┬────────┬───────────┬────────┬────────────┐
 │ Run          │ Result │ Anomalies │ Score  │ Uploaded   │
 ├──────────────┼────────┼───────────┼────────┼────────────┤
 │ Aug 10 09:32 │ PASS   │ 0         │ 0.12   │ ✓ Synced   │
 │ Aug 08 14:15 │ FAIL   │ 3         │ 0.87   │ ✓ Synced   │
 │ Aug 05 11:00 │ PASS   │ 1         │ 0.34   │ ✓ Synced   │
 └──────────────┴────────┴───────────┴────────┴────────────┘

 [▶ Begin Inspection]  [⟳ Re-plan]  [↑ Upload Plan]
═══════════════════════════════════════════════════════════════
```

### New API routes for picker

```
GET  /api/parts/{id}/plan        → plan status + summary
POST /api/parts/{id}/plan/upload → trigger plan upload to 3DX
GET  /api/parts/{id}/runs        → inspection history for this part
POST /api/runs/{run_id}/upload   → trigger result upload to 3DX
```

---

## Updated directory structure

```
catalog/                          # host-mounted volume
├── catalog.db                    # SQLite (parts + plans + runs + sync_log)
├── steps/                        # cached STEP files
│   └── {eng_item_id}/
│       └── {revision}.stp
├── thumbnails/                   # 3DX thumbnail images
│   └── {eng_item_id}.png
├── plans/                        # NEW — inspection plan envelopes
│   └── {eng_item_id}/
│       ├── PLAN_BRK-1042_A.3_20260811T143022Z.json   (envelope)
│       └── PLAN_BRK-1042_A.2_20260805T091500Z.json   (older rev)
└── results/                      # NEW — inspection result bundles
    └── {eng_item_id}/
        └── {run_id}/
            ├── result_manifest.json
            ├── images/
            ├── point_clouds/
            └── anomaly_report.json
```

---

## Updated implementation phases

### Phase 1 — Foundation
(unchanged — catalog sync, SQLite, CAS auth)

### Phase 2 — ROS2 integration
- As before, plus:
- [ ] Add `plans` table to schema
- [ ] Implement `ensure_plan()` in sync daemon
- [ ] Add `EnsurePlan.srv` definition
- [ ] Wire into `SelectPart` flow: check plan before loading pipeline

### Phase 3 — Part picker UI
- As before, plus:
- [ ] Plan status indicator on part cards
- [ ] Expandable detail panel with plan summary
- [ ] Inspection history table

### Phase 4 — Inspection result upload
- As before, plus:
- [ ] Implement envelope wrap/unwrap in catalog module
- [ ] Plan upload after viewpoint generation completes
- [ ] Result bundle assembly post-inspection
- [ ] Result upload with FCS multi-file checkin
- [ ] `UploadPlan.srv` and `UploadResults.srv`
- [ ] Auto-create Issue (dsiss) on anomaly threshold breach

### Phase 5 — JMS event-driven sync
- As before, plus:
- [ ] Listen for `derivedoutput.created` → auto-check plan validity
- [ ] Listen for `engitem.modified` → flag stale plans in catalog
- [ ] WebSocket push to picker UI for real-time plan status updates

### Phase 6 — Multi-cell plan sharing (future)
- [ ] Cell registry in catalog (cell_id, capabilities, camera configs)
- [ ] Plan portability check: can cell B execute a plan from cell A?
  - Camera config match (fov_diameter, dof, focal_distance)
  - Workspace reachability (different robots, different mount points)
- [ ] Plan adaptation: re-run TSP traversal for different robot kinematics
  while keeping segmentation and viewpoints from original plan
