# 3DEXPERIENCE tenant API — what actually works

Empirical findings from implementing the catalog integration against tenant
`R1132100093385` (UW EDU, passport in `eu1`, 3DSpace in `usw2`), verified
2026-08-12. The design documents describe the intended architecture; this
records where the tenant's real API surface differs, so the next person does
not re-derive it.

Everything below was confirmed by live calls, not inferred from documentation.

---

## Authentication — works as designed

The CAS flow in `catalog/client.py:login()` is verified end to end:

1. `GET {passport}/login?action=get_auth_params` → `{"response":"login","lt":"LT-…"}`
2. `POST {passport}/login` with `lt`, `username`, `password` → sets
   `CASTGC_*` cookies on the passport domain. **A wrong password also returns
   HTTP 200** (it re-renders the login form), so the CASTGC cookie — not the
   status code — is the success signal.
3. `GET {space}/resources/v1/application/CSRF?tenant=…` → 302 to the passport
   → 302 back to the space with `?ticket=ST-…` → space `JSESSIONID` set, and
   the CSRF token returned.

**The split-region topology is a non-issue in practice.** `requests.Session`
follows the CAS redirect chain automatically, and the final hop is what mints
the space-domain session. Manually copying cookies between the `eu1` and `usw2`
hosts is neither necessary nor sufficient — the space will not issue a session
without a service ticket.

The `SecurityContext` header is sent **unencoded, including the `ctx::`
prefix**: `ctx::VPLMProjectLeader.Company Name.Colin Acton Space`. Spaces in
the organization and collaborative-space names are fine in the header.

> The organization on this tenant is literally named `Company Name`. It looks
> like an unfilled placeholder in the setup checklist, but it is the real value.

---

## Endpoint availability

| Capability | Endpoint | Status |
|---|---|---|
| CSRF token | `GET /resources/v1/application/CSRF` | works |
| Security contexts | `GET /resources/modeler/pno/person?current=true&select=preferredcredentials` (and `select=collabspaces`) | works |
| Security contexts | `GET /resources/v1/application/e6w/api/v1/e6wCurrentUser` | **404** — the checklist's method 3 does not exist here |
| EngItem search | `GET /resources/v1/modeler/dseng/dseng:EngItem/search` | works |
| EngItem fetch | `GET /resources/v1/modeler/dseng/dseng:EngItem/{id}` | works |
| Object detail / files | `GET /resources/v1/modeler/documents/{id}` and `/files` | works |
| Document creation | `POST /resources/v1/modeler/documents` | works |
| FCS check-in ticket | `PUT /resources/v1/modeler/documents/{id}/files/CheckinTicket` | works (**PUT only**) |
| FCS upload | `POST {ticketURL}` multipart | works |
| Check-in completion | `POST /resources/v1/modeler/documents/{id}/files` | works (**POST only**) |
| FCS download ticket | `PUT /resources/v1/modeler/documents/{id}/files/DownloadTicket` | works (**PUT only**) |
| Bookmark list | `GET /resources/v1/modeler/dsbks/dsbks:Bookmark/search` | works |
| **Object preview / thumbnail** | every documented route | **404 — only per-type icons exist** |
| **Representations (3D Shape)** | `dsrepr:`, `dsgeo:`, `dseng:EngRepInstance` | **404 / empty** |
| Library / class list | `GET /resources/v1/modeler/dslib/dslib:Library/search` (and `dslib:Class`) | works |
| **Bookmark contents** | `GET /resources/v1/modeler/dsbks/dsbks:Bookmark/{id}?$mask=dsbks:BksMask.Items` | **works** — see below |
| Bookmark sub-folders | same, `$mask=dsbks:BksMask.Bookmarks` | works |
| **Library / class members** | every documented route | **404 — not available** |
| **Derived outputs (dsdo)** | `POST /resources/v1/modeler/dsdo/dsdo:DerivedOutputs/Locate` | **works** — STEP downloads |
| Derived output download | `POST .../dsdo:DerivedOutputs/{doId}/dsdo:DerivedOutputFiles/{fileId}/DownloadTicket` | works |
| CAD part / authoring file | `GET /resources/v1/modeler/dsxcad/dsxcad:Part/{id}` (`dsmvxcad:xCADPartMask.*`) | works |
| **Document↔EngItem relationship** | every documented route | **404 — not available** |
| Issue creation (dsiss) | `POST /resources/v1/modeler/dsiss/dsiss:Issue` | untested (no anomaly run yet) |

Masks are per-service, and the naming is not uniform. `dseng` accepts only
`dskern:Mask.Default` (`Mask.Details`, `Mask.All`, `Mask.SpecificationRelation`
all return `400 Mask does not exist`), while `dsbks` uses its own `BksMask.*`
family. A rejected mask name proves nothing about the capability — see
"Scoping the catalog".

---

## Three traps worth knowing

### 1. HTTP 200 does not mean the write happened

Sending the file check-in as `PUT` returns `200` with `"data":[]` and silently
does nothing. The same payload as `POST` returns the created file object. The
client therefore judges success on the returned object, never on the status
code. Assume any new write endpoint has this failure mode until proven
otherwise.

### 2. The FCS job ticket must be posted as a named form field

The check-in ticket response carries three fields:

```json
{"ticketURL": "https://usw2-academia-dfcs.3dexperience.3ds.com/fcs/servlet/fcs/checkin",
 "ticketparamname": "__fcs__jobTicket",
 "ticket": "QEBlbnZlbG9wM0BmY3NrZXlf…"}
```

The upload must include `ticket` as a form field **named by
`ticketparamname`**, alongside the file part. Posting only the file is accepted
at the HTTP level and stores nothing — the document ends up with zero files.
Read the field name from the ticket rather than hard-coding it.

### 3. `totalItems` is the page size, not the result-set size

`dseng:EngItem/search` answers `$top=200` with `"totalItems": 200`. It reports
what it just returned, so it is useless as a paging bound. Page until a short
page arrives instead. (An earlier version of the sync used `skip >= totalItems`
and silently indexed only the first page.)

---

## Scoping the catalog — solved

The plan scopes the catalog by a 3DX bookmark ("Inspection Parts"), and **that
works exactly as designed**. Earlier revisions of this document claimed
bookmark contents were unreachable; that was wrong, and the reason is worth
recording because it cost a lot of probing.

**The mask family for bookmarks is `dsbks:BksMask.*`, not `dsbks:Mask.*`.**

```
GET /resources/v1/modeler/dsbks/dsbks:Bookmark/{id}
    ?$mask=dsbks:BksMask.Items&$top=1000&$skip=0
```

`dsbks:Mask.Items` — the spelling every other service's masks would suggest —
is rejected with `400 Mask does not exist`, which reads exactly like "this
service has no such capability". It does; the constant is just named
differently. Valid masks: `BksMask.Items`, `BksMask.Bookmarks` (sub-folders),
`BksMask.Parent`, `BksMask.Linkable`. There is no `BksMask.Default` or
`BksMask.Detail`.

This was found in Dassault's own public C# SDK
([3ds-cpe-emed/ws3dx-dotnet](https://github.com/3ds-cpe-emed/ws3dx-dotnet),
`ws3dx.dsbks/core/service/BookmarkService.cs`), which documents the endpoints
and mask names in source comments. **That repository is the best available
reference for this platform's REST surface** — it covers dseng, dsmfg, dsdo,
dsiss, dsprcs, dsxcad and more, and is worth consulting before probing
anything by hand. The official documentation portal needs a 3DEXPERIENCE ID
(a separate identity from the tenant passport, so the cell's credentials do
not open it).

Notes on the response:

- Members arrive as `items.member[].referencedObject` with `identifier`,
  `type`, and `relativePath`. Bookmarks hold anything the operator dragged in
  — this tenant's contain `VPMReference`, `Document`, `Electrical3DSystem`,
  `Requirement Group`, `System Scope` — so members must be filtered to
  engineering items before being treated as parts.
- The `totalItems` inside `items` is a **genuine** total, unlike the search
  endpoint's, so it can be trusted to drive `$top`/`$skip` paging. `$top` caps
  at 1000.
- Sub-bookmarks (`Workspace Vault`, `BMF_` prefix) are separate objects listed
  by `BksMask.Bookmarks`; `list_bookmark_items()` recurses into them with a
  cycle guard.
- `POST /dsbks:Bookmark/locate` exists and is documented as "fetches the
  bookmarks where the input items are classified" — the reverse lookup — but
  every payload shape tried returned `400 Payload is not valid.` Not needed
  for scoping, but it is the route to check if per-item bookmark membership is
  ever wanted.

Measured effect: `DX_BOOKMARK_SCOPE="Inspection Parts"` produces a catalog of
exactly the curated part in **2.7 s**, against 5.5 minutes and 1000 rows of
training-cell noise for the previous `owner:CAN28` scope.

Server-side search filtering also exists — an earlier revision said it did not,
which was also wrong. See the tag-predicate section below.

### Why the earlier "not available" conclusion was wrong

Recorded as a caution, since the failure mode is convincing. Probing by hand
produced: every `dsbks:Mask.*` spelling rejected as "Mask does not exist", every
sub-resource (`dsbks:Content`, `:Members`, `:Items`, `children`, `expand`, …)
404, `documents/{bookmark}` reporting `children: []` under every `$include`
variant, and `OPTIONS` advertising nothing. That is indistinguishable from a
service that does not implement membership — but the capability was there the
whole time under a mask name no amount of guessing was going to reach.

The lesson: **consult the SDK or documentation before concluding a 3DX
capability is absent.** Enumerating plausible names is not evidence, because
this platform answers a wrong-but-well-formed mask with a 400 and a
wrong-but-well-formed path with a 404, exactly as it would if the feature did
not exist.

The same caution applies to the capabilities still listed as unavailable here
(`dsdo` derived outputs, Document↔EngItem relationships, per-object
thumbnails): they were probed the same way, so they may equally be reachable
under names not yet tried. `ws3dx-dotnet` has `ws3dx.dsdo` and `ws3dx.dsiss`
projects that would settle the first two.

## Derived outputs (STEP download) — solved

Same story as bookmarks: the resource is `dsdo:DerivedOutput**s**` (plural),
there is no GET collection, and the masks live under a *third* prefix.

```
POST /resources/v1/modeler/dsdo/dsdo:DerivedOutputs/Locate
     ?$mask=dsmvdo:DerivedOutputsMask.AllDetails
{"referencedObject": [{"id": "<engitem id>", "type": "VPMReference",
                       "source": "<space url>",
                       "relativePath": "/resources/v1/modeler/dseng/dseng:EngItem/<id>"}]}
```

`id` **and** `type` are both required (omitting `type` gives
`400 ReferencedObject must have ID and Type`). Items with no conversion answer
`400/500 "Error in Get Derived Output Info"` rather than an empty result, so
that is treated as "none".

The response carries `derivedOutputs.derivedOutputfiles[]` with `id`, `format`
(`STEP_AP214`), `filename`, `filesize`, `downloadable`, and
`streamAttributes.title` (the human filename). Download is two steps:

```
POST .../dsdo:DerivedOutputs/{doId}/dsdo:DerivedOutputFiles/{urlencoded fileId}/DownloadTicket
  -> {"data": {"dataelements": {"ticketURL": ..., "ticket": ..., "filename": ...}}}
GET  {ticketURL}?__fcs__jobTicket={ticket}
```

**The job ticket must be passed as a real query parameter, not concatenated
into the URL.** It is base64 and contains `+` and `/`; unencoded, FCS answers
`Failed to decrypt; FCS Bad ticket`. Note the asymmetry with check-in, where
the ticket is posted as a *form field* named by `ticketparamname`.

Verified: the staged part's `STEP_AP214` output (converter `sldprtToSTEP_AP214`)
downloads as 18,045 bytes of valid `ISO-10303-21`, loads through the STEP
pipeline (8 B-rep faces), and its thumbnail renders automatically.

## Document↔EngItem relationship — still unresolved

Uploaded plan Documents still cannot be linked to their engineering item.
`ws3dx-dotnet` has no Document service to crib from, and `dseng` publishes no
document relation under any of its masks (`dskern:Mask.Default`,
`dsmveng:EngItemMask.Common`, `.Details`; `.Config` returns a 501 server
exception). `dseng:EngItem/{id}/dseng:EnterpriseReference` exists but is a part
number, not a link.

Two routes remain, neither taken:

1. **Attach the plan as a derived output** of the part. The machinery exists
   (`POST /dsdo/CheckinTicket`, then `POST /dsdo/dsdo:DerivedOutputs` with
   `{referencedObject, derivedoutputfiles: [{receipt, filename, format,
   checksum}]}`) and would make plans discoverable through the same `Locate`
   call the STEP fetch already uses. **Not done deliberately**: derived outputs
   are converter-managed (`isSync`, `synchroStamp`, `converterName`), so
   writing bespoke files into that collection risks interfering with the CAD
   conversion pipeline on a system of record. Worth asking Dassault or Chris
   before adopting.
2. A Document/relationship service outside this SDK's coverage.

Meanwhile the plan Document uploads correctly and its id is recorded locally
(`plans.plan_doc_id`), so a cell re-finds its own plans; only cross-cell
discovery is missing.

## Thumbnails — confirmed absent, local rendering is right

`dsxcad:Part/{id}` (masks `dsmvxcad:xCADPartMask.Default/.Basic/.Details`,
`dsmvxcad:VisualizationFile.Details`) reports both files the platform holds for
a part: `dsxcad:AuthoringFile` (here `Test.SLDPRT`, the original SolidWorks
part, downloadable via `dsxcad:Part/{id}/dsxcad:AuthoringFile/DownloadTicket`)
and `dsxcad:VisualizationFile` (`Visu_*.cgr`).

Neither is an image: CGR is CATIA's tessellated geometry format, which nothing
in this pipeline reads and which adds nothing over the STEP already fetched.
There is still no per-object preview image on this tenant, so rendering
thumbnails locally from the STEP remains the correct approach.

### Tag predicates: `[tag]:value` (this is the useful part)

The search backend accepts Exalead-style tag predicates, but **only in bracket
form**. `ds6w:label:Test` is answered with HTTP 500 ("The Search service
returned an error"); `[ds6w:label]:Test` works. That syntax detail is why the
first pass through this concluded there was no structured search at all.

Tags confirmed live on this tenant:

| Predicate | Meaning | Result |
|---|---|---|
| `[ds6w:project]:"Colin Acton Space"` | **collaborative space** | 3000+ items, 100% in that space |
| `[ds6w:label]:Test` | object title | exact-ish title match |
| `[ds6w:type]:VPMReference` | object type | works across spaces |

Predicates AND together, and combine with free text:
`[ds6w:project]:"Colin Acton Space" AND Test` returns exactly the one staged
inspection part. Unrecognized or unpopulated tags (`[ds6w:who]`, `[ds6w:when]`,
`[ds6wg:bookmark]`, `[ds6w:collabspace]`, …) return HTTP 200 with zero results
rather than an error, so "0 results" never proves a tag is invalid.

`[ds6w:project]` is what `CatalogSync._scope_query()` now uses whenever
`DX_COLLAB_SPACE` is set: space filtering happens on the server, so the
`CATALOG_MAX_ITEMS` scan budget is spent entirely on in-scope items instead of
being burned on other spaces' content and discarded locally. Measured: a
300-item scan under `DX_BOOKMARK_SCOPE=*` now yields 300 in-scope items, where
previously it would have yielded roughly 19. A fallback drops the predicate and
filters client-side if it ever returns nothing on the first page, so tenants
without the tag still work.

**No bookmark tag exists.** Every bookmark/workspace/subscription spelling
returns 0, and bookmark membership is not an attribute of the item either:
`$select`/`select`/`$include` are ignored by `dseng` (identical response for
`bookmarks`, `workspaces`, `subscriptions`, `all`), and the `documents` view's
`relateddata` only ever carries `ownerInfo`, `reservedInfo`, `originatorInfo`,
`files`, and (with `$include=all`) `sovaccess`.

### Free-text scoping

Beyond the tag predicates, plain `$searchStr` works:

| Scope | Result |
|-------|--------|
| `*` | everything visible, across all collaborative spaces (>1000 items) |
| `owner:CAN28` | everything owned by the user — all in `Colin Acton Space`, still >1000 items |
| `"Colin Acton Space"` | free-text match, all in that space |
| `Test` | 5 items, 1 of them the staged inspection part |
| bookmark name or id | 0 items |

`DX_COLLAB_SPACE` is applied server-side via `[ds6w:project]` (with a
client-side re-check as a safety net), and `CATALOG_MAX_ITEMS` (default 1000)
bounds the scan.

**This needs a decision.** A catalog of 1000 training-cell components is not a
useful part picker. The realistic options:

1. **A naming convention** — prefix inspection parts (`INSP_…`) and set
   `DX_BOOKMARK_SCOPE` to that prefix. Most robust with the available API, and
   now exact: it ANDs with `[ds6w:project]` into a single server-side query.
2. **A dedicated collaborative space** for inspection parts, with
   `DX_COLLAB_SPACE` set to it.
3. **Ask the tenant admin (Chris)** whether the `dsdo`, bookmark-content, and
   relationship services can be enabled — that would let the integration work
   exactly as designed.

`--sync-item {id}` adds a specific part regardless of scope, which is the
practical workaround meanwhile.

---

## Consequences for the implementation

- **Derived outputs work**, so `fetch_step()` downloads STEP directly from
  3DX. The hand-placed fallback at `catalog/steps/{eng_item_id}/{revision}.stp`
  is retained for parts with no published conversion.
- **No document↔item relationship** means an uploaded plan lands in 3DX as a
  proper Document with its file, but is not linked to the engineering item.
  The link is recorded locally (`plans.plan_doc_id`), so the same cell
  re-downloads its own plans; cross-cell discovery via
  `list_related_documents()` will find nothing until the relationship API is
  available.
- **No per-object preview images at all.** `documents/{id}` exposes only
  `image` and `typeicon`, both pointing at `/snresources/images/icons/…` —
  per-*type* artwork, byte-identical for every Physical Product. This is not a
  matter of the items lacking geometry: `HAAS NC Machine` and the other CAD
  assemblies report `files: []` too, because on a `VPMReference` the geometry
  lives on a separate representation object, and every route to those
  (`dsrepr:`, `dsgeo:`, `dseng:EngRepInstance`, `dseng:Mask.Representation`)
  is 404 or empty here. No thumbnail service, no federated-search host
  (`…-fs.3dexperience.3ds.com` does not resolve), and no `ds6w:thumbnail` in
  any mask.

  Generic icons are therefore **not cached** — a grid of 1000 identical icons
  is worse than nothing. Instead the catalog renders a preview locally from the
  cached STEP (`catalog/thumbnails.py`), so the parts that can actually be
  inspected get real artwork and the rest fall back to the picker's
  placeholder. Rendering is a plain painter's-algorithm rasterization through
  matplotlib's Agg backend — no GL/EGL context, so it works headless.

---

## Verified end to end

- Full catalog sync: 1000 items indexed with correct titles, part numbers,
  revisions, cestamps, maturity, and collaborative space; re-running reports
  every item unchanged (cestamp diffing works).
- Plan upload: Document created with title
  `PLAN_prd-R1132100093385-00221681_A.1`, envelope JSON checked in via FCS,
  downloaded back, and unwrapped with its 8 regions and cestamp intact.

**Plan file format changed after this test.** Uploaded plans no longer wrap the
results JSON under `plan`; PLM context now sits in top-level keys beside
`meshes` (see the ViewpointGeneration README, "JSON Results Format"). The old
envelope is still readable, so the two documents below still load. Titles now
carry the pipeline stage as well (`PLAN_<part>_<rev>_ORDERED`), and only the
terminal `ordered` stage is uploaded by default — see
`auto_upload_plan_stages`. Every generated plan is recorded in the local
catalog regardless of whether it is uploaded.

Two test documents were created on the tenant during this work and are **not
linked to any engineering item**; delete them if unwanted:

- `FBDA80B4761319006A7D04C600002C0A` — carries a throwaway `plan.json`
- `BB6518585DD907006A7D059F00003656` — carries a real plan envelope
