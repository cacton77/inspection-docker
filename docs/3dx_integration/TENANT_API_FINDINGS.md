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
| **Bookmark contents** | every documented route | **404 — not available** |
| **Library / class members** | every documented route | **404 — not available** |
| **Derived outputs (dsdo)** | every documented route | **404 — not available** |
| **Document↔EngItem relationship** | every documented route | **404 — not available** |
| Issue creation (dsiss) | `POST /resources/v1/modeler/dsiss/dsiss:Issue` | untested (no anomaly run yet) |

Only `dskern:Mask.Default` exists. `Mask.Details`, `Mask.All`,
`Mask.SpecificationRelation`, and every `dsbks:Mask.*` return
`400 Mask does not exist`.

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

## Scoping the catalog is the open design question

The plan scopes the catalog by a 3DX bookmark ("Inspection Parts"). **The
bookmark exists and is visible, but its contents cannot be enumerated through
any endpoint this tenant exposes** — every relationship, mask, expand, and
`documents` route returns 404 or empty children. Nor is there server-side
filtering: `$filter`, `$where`, and `collabspace:"…"` predicates are all
ignored or return nothing.

### Evidence that this is an API gap, not an empty bookmark

Worth stating precisely, because the two look identical from the outside:

- The **"Robotic Arm" bookmark demonstrably has a child** — the folder
  "Linkset" (`BMF_8187288486`, type `Workspace Vault`) is visible as its own
  object in the same collaborative space, and `dsbks:Bookmark/search` returns
  it. Asking the platform for that bookmark's children nevertheless returns
  `children: []`, under every variant tried (`$include=children`,
  `$include=all`, `$expand`, `$depth`, `$fields`). A container whose child is
  independently visible while its child list reads empty is an API that does
  not publish membership.
- The bookmark type model is `Workspace` = "Bookmark Root Folder" (`BMR_`
  prefix) and `Workspace Vault` = "Bookmark Folder" (`BMF_`). Both are
  addressable only as `dsbks:Bookmark/{id}`, and both return just `{id, name}`
  — no other resource-type spelling
  (`dsbks:BookmarkFolder`, `dsbks:BookmarkRootFolder`, `dsbks:Workspace`,
  `dsbks:WorkspaceVault`, `Workspace`) resolves.
- No sub-resource exists: `dsbks:Content`, `:Contents`, `:Member(s)`,
  `:Item(s)`, `:Child(ren)`, `:SubBookmark`, `:Reference`, `:SubscribedItem`,
  `:BookmarkedItem`, `:Folder`, and the plain `children`/`items`/`contents`/
  `expand`/`tree` forms all 404. No POST expand endpoint exists.
- `OPTIONS` returns 200 with no `Allow` header, so the service advertises
  nothing, and there is no service-discovery route under `/resources`.

**The same limitation applies to every container type on this tenant**, which
is what makes it look structural rather than bookmark-specific: `dslib:Library`
and `dslib:Class` are searchable and return their own attributes, but neither
publishes its members either. Combined with the missing Document↔EngItem
relationship, the pattern is: **objects are readable, relationships are not.**

### The one avenue left

The 3DDashboard's own Bookmark widget clearly can list a bookmark's contents,
so *some* endpoint serves it — most likely a non-`/resources/v1/modeler` route
used by the web UI. It can be captured in two minutes:

1. Open the "Inspection Parts" bookmark in the 3DDashboard.
2. DevTools → Network, filter XHR, and click into the bookmark.
3. Look for the request that returns the item list, and copy its URL, method,
   request body, and response.

With that captured, bookmark-scoped sync becomes implementable;
`search_eng_items()` already takes an arbitrary query, and `sync_single_item()`
already reconciles one id at a time, so only the enumeration step is missing.

The only server-side scoping is the free-text `$searchStr`. What works:

| Scope | Result |
|-------|--------|
| `*` | everything visible, across all collaborative spaces (>1000 items) |
| `owner:CAN28` | everything owned by the user — all in `Colin Acton Space`, still >1000 items |
| `"Colin Acton Space"` | free-text match, all in that space |
| `Test` | 5 items, 1 of them the staged inspection part |
| bookmark name or id | 0 items |

Collaborative-space filtering is therefore applied **client-side**
(`DX_COLLAB_SPACE`), and `CATALOG_MAX_ITEMS` (default 1000) bounds the scan.

**This needs a decision.** A catalog of 1000 training-cell components is not a
useful part picker. The realistic options:

1. **A naming convention** — prefix inspection parts (`INSP_…`) and set
   `DX_BOOKMARK_SCOPE` to that prefix. Most robust with the available API.
2. **A dedicated collaborative space** for inspection parts, with
   `DX_COLLAB_SPACE` set to it.
3. **Ask the tenant admin (Chris)** whether the `dsdo`, bookmark-content, and
   relationship services can be enabled — that would let the integration work
   exactly as designed.

`--sync-item {id}` adds a specific part regardless of scope, which is the
practical workaround meanwhile.

---

## Consequences for the implementation

- **No derived outputs** means `fetch_step()` cannot download STEP files from
  the tenant. It falls back to adopting a STEP placed by hand at
  `catalog/steps/{eng_item_id}/{revision}.stp`, and says so explicitly when
  none is there. Everything downstream is unaffected.
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

Two test documents were created on the tenant during this work and are **not
linked to any engineering item**; delete them if unwanted:

- `FBDA80B4761319006A7D04C600002C0A` — carries a throwaway `plan.json`
- `BB6518585DD907006A7D059F00003656` — carries a real plan envelope
