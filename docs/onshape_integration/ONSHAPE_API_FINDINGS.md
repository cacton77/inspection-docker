# Onshape API — what actually works

Empirical findings from the Phase 0 spike (`onshape_rest_api_tour.ipynb`) against
`cad.onshape.com`, API `v17`, on the lab's **EDU Educator** plan, 2026-10-16. The
plan (`onshape_catalog_integration_plan.md`) describes the intended design. This file
records where the real API differs, so the next person doesn't re-derive it.

Everything below was confirmed by live calls. Cost of the whole spike: **26 billable
calls** of the company's 2,500/year, plus about 20 free 4xx probes. Raw responses are cached in
`catalog/onshape_spike/responses/` (gitignored) and replay for free.

Test setup: folder `Inspection Parts` → document `Test` (`169fd432…`) → Part Studio
`Test Studio` (`e7fef6c2…`) with `Part 1` (`JHD`, a box) and `Part 2` (`JID`, a
cylinder), versions `Start`, `V1`, `V2` (only Part 1 changed: volume doubled), `V3`.

---

## Authentication — works, with one trap

API keys with HMAC request signing work as documented (`Date`, `On-Nonce`,
`Authorization: On {key}:HmacSHA256:{sig}` over the lowercased
method/nonce/date/content-type/path/query string, trailing newline included).

| Call | Response | Meaning |
|---|---|---|
| `GET /users/sessioninfo`, valid key | `200` + user, `oauth2Scopes`, `planGroup: "EDU Educator"` | the auth check to use |
| `GET /users/sessioninfo`, invalid key | **`204 No Content`** | **trap:** "2xx" with no body means *not* authenticated |
| `GET /users/current`, valid key | `403 {"message":"Access denied."}` | not usable with API keys; not in the OpenAPI spec |
| any endpoint, invalid key / wrong secret / clock off by 1 h | `401 {"message":"Unauthenticated API request"}` | indistinguishable from each other |

- Judge auth by a 200 with a body, never by "2xx".
- A 403 (vs. 401) means the signature was accepted and the endpoint or scope refused.
- Wrong secret and clock skew give the same 401, so on a 401 the client should log the
  local clock offset (compare the response `Date` header) to tell them apart.
- `oauth2Scopes` is a bitmask (`4119` for a key with every scope except purchase); its
  bit meanings aren't documented.

## Company — exists on Educator

`GET /companies?activeOnly=true` → one company, `<company name>`
(`<companyId>`), even though `sessioninfo.company` is `null`. So
`companyId`-scoped webhooks are available. `GET /webhooks?company=…` → `200`, 0
registered.

## Scoping by folder — the documented route doesn't work

| Call | Result |
|---|---|
| `GET /documents?q=Inspection Parts` | `200`, **0 items**: search never returns folders |
| `GET /documents?parentId=<folder>` (with or without `filter=0`) | `200`, **`parentId` silently ignored**: all the user's documents, 20/page |
| `GET /documents?limit=50` | free `400 "must be less than or equal to 20"` |
| **`GET /globaltreenodes/folder/<folder>`** | `200`, **exactly the folder's contents**, 1 call |

- Configure the folder by id. It's the `nodeId` in the folder's URL
  (`…/documents?nodeId=<id>&resourceType=folder`).
- `globaltreenodes/folder` is **not in the OpenAPI spec**. Its items are the same
  `document-summary` objects as `/documents` (`id`, `name`, `modifiedAt`,
  `defaultWorkspace`, `parentId`, `resourceType`). Use it, but keep a fallback:
  page `/documents` and keep items whose own `parentId` equals the folder (every item
  carries it). That costs 1 call per 20 documents the user owns.
- `next` paging links come back **without the API version** (`/api/documents?…`).
  Re-insert it, or later pages are served by the default (oldest) version.
- Not yet tested: whether `globaltreenodes/folder` lists sub-folders (the test folder has
  none).

## Change detection — part microversion is document-wide; mass properties work

The plan bound plans to a per-part stamp, assumed to be the part's `microversionId`.
**That assumption was wrong.** Measured across V1 → V2 (only Part 1 edited) → V3:

| Candidate | V1→V2 changed | V2→V3 changed | Verdict |
|---|---|---|---|
| part `microversionId` (parts list) | both | both | **= the document microversion** at that version, byte-identical to the version's `microversion`. Useless per-part. |
| part `metadataMicroversion`, part `id` | both | both | same story |
| element `microversionId` (elements list) | Part Studio only | Part Studio only | per tab: the Assembly stayed `35bb…` throughout. Good **prefilter**, not per-part. |
| **mass properties** (volume, centroid, inertia) | **Part 1 only** | **none** | **the per-part stamp** |

- `GET /partstudios/d/{did}/v/{vid}/e/{eid}/massproperties?partId=JHD&partId=JID&massAsGroup=false`
  returns every requested part in **one call**. Values are `[value, min, max]`
  triples. `mass` is `0` when no material is assigned, so fingerprint on volume,
  centroid and inertia only.
- The element stamp also changed V2→V3, although no part geometry did. Whatever was
  edited for V3 touched the Part Studio element, so the element stamp catches
  non-geometry edits too. That's why it's only a prefilter.

**Resulting design** (replaces plan §4's per-part microversion):

```
per new version of a document:
  1 call  elements list        → Part Studio element microversions
          unchanged element    → none of its parts changed, stop
  1 call  massproperties       → per-part fingerprint (all parts of that Part Studio)
          cestamp = fingerprint;  changed fingerprint → invalidate STEP + plan
```

Limitation: a geometry edit that preserves volume, centroid and inertia exactly
(e.g. a symmetric feature moved symmetrically) would go unnoticed. That's acceptable for
research use, and closable later by adding the bounding box or a hash of the exported
STEP.

## Parts list

`GET /parts/d/{did}/v/{vid}` (no element) returns all parts of all Part Studios in one
call. Fields seen: `partId`, `name`, `elementId`, `partNumber`, `revision`, `state`,
`microversionId`, `metadataMicroversion`, `partIdentity`, `thumbnailInfo` (with
`withThumbnails=true`), `isHidden`, `isMesh`, `bodyType`, `appearance`, … No
`customProperties`/`material` unless set. `partId`s (`JHD`, `JID`) are stable across
versions.

## Thumbnails — real images, per Part Studio

`GET /thumbnails/d/{did}/v/{vid}/e/{eid}/s/300x300?skipDefaultImage=true` → `200`, a
7.4 KB PNG render. It's of the **whole Part Studio** (both parts in frame), not one part.
For per-part previews use the parts list's `thumbnailInfo` or
`/parts/…/partid/{pid}/shadedviews` (not yet tested), or keep rendering locally from
the STEP.

## STEP export — works as designed

```
POST /partstudios/d/{did}/v/{vid}/e/{eid}/translations
     {"formatName": "STEP", "partIds": "JHD", "stepVersionString": "AP242",
      "unit": "METER", "storeInDocument": false}
GET  /translations/{tid}                       → DONE after 2 polls (~5 s)
GET  /documents/d/{did}/externaldata/{fid}     → raw STEP
```

- `partIds` is honoured: one `MANIFOLD_SOLID_BREP` in the file.
- Result is a **raw `.step`, not a zip** (8.5 KB for the box).
- Schema `AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF`; length unit
  `SI_UNIT($,.METRE.)`, i.e. plain metres, so `"unit": "METER"` is honoured.
- Onshape's bounding box for the part: 0.0431 × 0.0529 × 0.2000 m, matching
  its volume (4.567e-4 m³).
- Cost: 4 calls (create, 2 polls, download). The format list
  (`/translations/translationformats`) is a one-off.

## Loader problems found on the way (not Onshape's)

Loading the exported STEP with `viewpoint_generation.step_loader` in the current
`inspection-docker:jazzy` image surfaced two existing bugs that affect **3DX parts
too**:

1. **`cadquery-ocp` 8.0.1 breaks the loader's imports.** `docker/requirements.txt`
   says `cadquery-ocp>=7.7.2`, so a rebuild pulled OCP 8. In OCP 8,
   `TopTools_IndexedDataMapOfShapeListOfShape` / `TopTools_IndexedMapOfShape` moved to
   `OCP.collections` (`IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher`,
   `IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher`), and `TopoDS.Face_s` became
   `TopoDS.Face`. The other static calls the loader uses kept their `_s`. Pinning
   `<8` is not a clean way out: OCP 7.9.3 has the same import failure, and its
   wheels expect VTK 9.3 while the image has 9.6.2. A two-line compatibility shim in
   `_import_occ()` was tested and works.
2. **STEP files load 1000× too large.** OpenCascade converts every STEP to its working
   unit, **millimetres**, whatever the file declares. `load_step(units=…)` treats
   `units` as the file's unit and scales from it, and the default (and
   `mesh_utils.py`) pass `'m'`, so no scaling happens. Measured: the Onshape box loads
   as 43.1 × 52.9 × 200 (Onshape: 0.043 × 0.053 × 0.2 m); the two cached 3DX parts
   load as 50 × 50 × 50 and 45 × 45 × 110. The earlier 3DX check verified face counts
   (8), not size. Fix: always scale OpenCascade's millimetres to metres for STEP, and
   stop taking a file unit for STEP at all, since the file declares its own.

**Correction to (2):** the catalog path was sized correctly all along, because the
bringup launch defaults `catalog_mesh_units` to `mm`, which happens to be right for every
STEP file. Sizes were wrong whenever anything other than `mm` was passed, including the
loader's own default. Separately, tessellation `linear_deflection` (default `0.0005`,
meant as metres) was applied in OCC's millimetres, i.e. 0.5 µm.

**Both fixed 2026-10-16** in ViewpointGeneration (`feature-3dx-integration`,
uncommitted): `_import_occ()` falls back to the OCP 8 names. `load_step()` pins
`xstep.cad.unit = MM`, always returns metres and ignores `units`, and converts the
deflection from metres. A new `mesh_utils.mesh_file_units()` returns `'m'` for STEP,
and `set_mesh_file()` and the visualizer use it. Verified in the image (OCP 8.0.1):
the Onshape box loads as 0.0431 × 0.0529 × 0.2 m (6 planar faces, 4 neighbours
each, area 0.0430 m²), the 3DX parts as 0.05 m cubes and 0.045 × 0.045 × 0.110 m, and
the results are identical for any `units`. The curved 3DX part tessellates to 2,088
triangles at the intended 0.5 mm tolerance, where the effective 0.5 µm gave 29,396.

## Still open

- Plan-tab writes (§9 of the notebook): blob upload, finding it again, download,
  delete (needs the Delete scope), and whether `locationGroupId` puts it in a tab
  folder. Then confirm that adding the tab and versioning leaves every part's mass
  fingerprint unchanged.
- Sub-folders in `globaltreenodes/folder`.
- Per-part thumbnails (`thumbnailInfo`, `shadedviews`).
- Webhook registration (Phase 5, via the relay).
