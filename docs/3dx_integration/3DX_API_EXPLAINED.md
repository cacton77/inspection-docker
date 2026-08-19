# The 3DX integration, explained

A plain-language walkthrough of how the inspection cell talks to the
3DEXPERIENCE platform: what we were trying to accomplish, the handful of
concepts you need to follow the code, and how each piece actually turned out.

Written for engineers who are comfortable with code but have not spent time
inside REST APIs or PLM systems. No prior 3DX knowledge assumed.

---

## 1. What we were shooting for

3DEXPERIENCE (3DX) is Dassault's cloud PLM platform. For our purposes it is
the **system of record for CAD**: the place where a part's geometry, its part
number, its revision, and its release state officially live. Today, getting a
part into the inspection cell means somebody exports an STL by hand and copies
it onto the machine. Nothing about the resulting inspection is traceable back
to the CAD it came from.

The goal is to close that loop:

```
  3DX (system of record)                    Inspection cell
  ─────────────────────                     ───────────────
  curated list of parts   ──────────────►   operator sees a catalog
  STEP geometry           ──────────────►   viewpoint planning pipeline
                                                     │
  inspection plan         ◄──────────────────────────┘
  inspection results      ◄──────────────   robot runs the plan
```

Concretely, four things:

1. **A part catalog.** The operator sees the parts an engineer curated in 3DX,
   not a directory of loose mesh files.
2. **Automatic CAD fetch.** Picking a part downloads its STEP file. STEP is
   exact CAD geometry (analytic surfaces, edges, faces) rather than a triangle
   soup, which also gives the planner better segmentation to work with.
3. **Plans that go back up.** The generated viewpoint plan is uploaded to 3DX
   and stamped with the exact CAD revision it was planned against, so any cell
   can find and reuse it — and so a plan can be recognized as stale when the
   CAD changes.
4. **Results that go back up.** Images, point clouds, and anomaly reports
   upload as well, giving a full chain: *which CAD revision → which plan →
   what was found*.

Everything else in this document is in service of those four.

---

## 2. The five concepts you need

3DX exposes no database connection and no file share. It exposes a **REST
API**: you make HTTP requests — the same protocol your browser uses — and get
JSON back. Five ideas cover almost everything in our client code.

### Endpoints and verbs

An **endpoint** is a URL naming a thing or an action:

```
GET  https://…-space.3dexperience.3ds.com/enovia/resources/v1/modeler/dseng/dseng:EngItem/search
                                          └─────────── the endpoint ───────────┘
```

The **verb** says what you want done: `GET` to read, `POST` to create or run
something, `PUT` to update. The service names in the path (`dseng`, `dsbks`,
`dsdo`, `dsiss`) are 3DX's internal subsystems — engineering items, bookmarks,
derived outputs, issues. Each behaves a little differently, which matters more
than you would hope.

> **Trap #1: the verb is not negotiable, and the wrong one lies to you.**
> Registering an uploaded file must be a `POST`. Send the identical payload as
> `PUT` and 3DX answers `200 OK` with an empty result — and silently does
> nothing. Our client therefore never trusts a status code for writes; it
> checks that the response actually contains the object it asked for.

### Headers

Every request carries **headers** — metadata alongside the URL. Three matter:

| Header | What it is |
|---|---|
| `SecurityContext` | Which hat you are wearing: `ctx::Role.Organization.CollabSpace`. 3DX shows you only what that role can see in that space. Get it wrong and you get 403s or, worse, plausible-looking empty results. |
| `ENO_CSRF_TOKEN` | An anti-forgery token fetched at login. Required on writes. |
| `tenant=…` (query param) | Which customer tenant on the cloud you mean. Ours is `R1132100093385`. |

Our `DXClient._request()` attaches all three to every call so no other code
has to remember.

### Sessions

You log in once; the server hands back a **session cookie**; subsequent
requests present it like a wristband. Standard stuff — with one wrinkle:

> **Trap #2: an expired session does not return 401.** 3DX redirects you to
> its login page, which returns HTML with status `200`. So a JSON API call
> "succeeds" and hands you a web page. `_looks_like_login_redirect()` sniffs
> for that, re-authenticates, and retries once.

### Masks — the 3DX-specific one

A **mask** says which fields you want back. It is 3DX's version of choosing
columns in a `SELECT`:

```
GET …/dseng:EngItem/{id}?$mask=dskern:Mask.Default
```

Masks are the single biggest source of wasted time on this platform, because
**mask names are not consistent between services** and a wrong name is
indistinguishable from a missing feature:

- `dseng` (engineering items) accepts only `dskern:Mask.Default`.
- `dsbks` (bookmarks) uses its own family: `dsbks:BksMask.Items`.
- `dsdo` (derived outputs) uses a third: `dsmvdo:DerivedOutputsMask.AllDetails`.

> **Trap #3: a wrong mask returns `400 Mask does not exist`** — which reads
> exactly like "this service cannot do that." We concluded twice that a
> capability was missing when the constant was merely spelled differently.
> `dsbks:Mask.Items` fails; `dsbks:BksMask.Items` works and always did.
>
> The fix was to stop guessing and read Dassault's own open-source C# SDK
> ([ws3dx-dotnet](https://github.com/3ds-cpe-emed/ws3dx-dotnet)), which
> documents endpoints and mask names in source comments. That repo is now the
> first place to look before probing anything by hand.

### cestamp

Every 3DX object carries a **`cestamp`** — an opaque string the platform
changes on every modification. It exists for concurrency control, but it is
also the perfect change detector: compare the stored `cestamp` with the remote
one and you know whether anything changed, with no timestamp-comparison or
clock-skew problems. We use it for three decisions:

- Does the catalog row need updating?
- Is the cached STEP file still the right geometry?
- Is a saved inspection plan still valid for this CAD, or is it stale?

---

## 3. How we built it

Four layers, each one hiding the mess below it:

```
   Picker UI (Flask, browser)   ROS 2 nodes
              │                      │
              └──────────┬───────────┘
                         │
                  CatalogSync ──── SQLite catalog.db
                         │          (parts, plans, runs, sync_log)
                     DXClient
                         │
                    3DX REST API
```

- **`DXClient`** (~1100 lines) — the only code that speaks HTTP. Handles login,
  headers, retries, paging, file transfer.
- **`CatalogSync`** (~1500 lines) — reconciles "what 3DX has" against "what we
  have cached," and owns the workflows (fetch a STEP, record a plan, upload
  results).
- **`catalog.db`** — a single SQLite file, host-mounted so it survives
  container rebuilds. The cell reads this, never the network, on the hot path.
- **ROS 2 node + Flask picker** — how the operator and the rest of the cell see
  the catalog. The picker shows a card grid; clicking a part triggers fetch →
  plan → publish on `/catalog/part_selected`.

A deliberate property: **the cell works when 3DX doesn't.** Missing endpoints
degrade to empty results with a warning rather than raising, and everything the
pipeline needs is already on local disk. A network outage costs you new parts,
not the ability to inspect.

Below are the four problems that took real work.

### 3.1 Logging in across two regions

Our tenant's login server is in Europe (`eu1`) and its data services are in
Oregon (`usw2`). 3DX uses **CAS**, a ticket-based single-sign-on scheme, which
means login is a four-step dance rather than one request:

```
1. GET  passport/login?action=get_auth_params      → a one-time login ticket "lt"
2. POST passport/login  (lt + username + password) → sets a CASTGC cookie
3. GET  space/…/CSRF                               → 302 to passport
                                                   → 302 back to space?ticket=ST-…
                                                   → space session cookie is minted here
4. Read the CSRF token from that response.
```

Two things worth knowing:

- **A wrong password still returns `200`.** The passport just re-renders its
  login form. The success signal is the presence of the `CASTGC` cookie, not
  the status code.
- **Step 3 is not optional.** The intuitive fix for split regions — copy the
  cookies from the EU host over to the US host — does not work. The data
  service will not issue a session without a service ticket from the login
  server. Once you follow the redirect chain (which `requests.Session` does on
  its own), the two-region split stops mattering entirely.

### 3.2 Finding the right parts

The tenant is a shared teaching environment: a naive search returns 1000+
training-cell components. A catalog of 1000 irrelevant parts is not a part
picker, so scoping was essential. Two mechanisms, in priority order:

**Bookmarks (the primary path).** An engineer curates a bookmark folder called
"Inspection Parts" in the 3DX UI by dragging parts into it. We enumerate its
contents directly:

```
GET …/dsbks:Bookmark/{id}?$mask=dsbks:BksMask.Items&$top=1000
```

This is the mechanism the `BksMask` naming issue was hiding. It works well:
**2.7 seconds** to build a catalog of exactly the curated parts, versus
**5.5 minutes** and 1000 rows of noise for the previous search-based scope.
Two details: bookmarks hold whatever was dragged in (documents, requirement
groups, electrical systems), so members are filtered to engineering items; and
sub-folders are separate objects we recurse into, with a cycle guard.

**Server-side search predicates (the fallback).** When no bookmark is
configured, the search backend accepts Exalead-style tag predicates — but
**only in bracket form**:

```
[ds6w:project]:"Colin Acton Space" AND INSP      ← works
ds6w:project:"Colin Acton Space"                 ← HTTP 500
```

`[ds6w:project]` is the collaborative space. Pushing that filter to the server
means our scan budget is spent on relevant items instead of fetching and
discarding other spaces' content: a 300-item scan yields 300 in-scope items
where it previously yielded about 19.

> **Trap #4: `totalItems` is the page size, not the result-set size.** Ask
> `dseng` search for 200 items and it reports `totalItems: 200` — it is
> describing what it just handed you. Using it as a paging bound (`skip >=
> totalItems`) silently indexes only the first page, which is exactly the bug
> we shipped first. The loop now pages until a short page arrives. Bookmarks
> are the exception: their `totalItems` is genuine and can be trusted.
>
> Related: an unrecognized search tag returns `200` with zero results rather
> than an error, so "0 results" never proves your query was wrong.

### 3.3 Moving files: the two-step ticket dance

3DX does not stream file bytes through its API host. Files live on a separate
**FCS** (File Collaboration Server), and transfers are brokered:

```
                    ┌── 1. "I want this file" ──►┐
   our client                                   3DSpace API
                    ◄── 2. signed ticket ───────┘
                    │
                    └── 3. ticket + bytes ──────► FCS host
```

Think of 3DSpace as the front desk and FCS as the warehouse: the desk won't
hand you the crate, it gives you a signed slip to take to the warehouse. The
slip is an opaque base64 blob that encodes both authorization and *which
store and object* the bytes belong to. Downloads and uploads both work this
way, and — irritatingly — the slip is submitted differently in each direction:

> **Trap #5: uploads pass the ticket as a named form field; downloads pass it
> as a query parameter.**
>
> - **Upload:** the ticket response includes `ticketparamname` — the *name of
>   the form field* the ticket must be posted under (in practice
>   `__fcs__jobTicket`). Post just the file without it and FCS accepts the
>   request at the HTTP level and stores nothing; the document ends up with
>   zero files. We read the field name from the response rather than
>   hard-coding it.
> - **Download:** the ticket must be a real query parameter so the HTTP library
>   percent-encodes it. It is base64 and contains `+` and `/`; concatenated
>   raw into a URL, FCS answers `Failed to decrypt; FCS Bad ticket`.

**Getting STEP out** turned out to be the `dsdo` "derived outputs" service —
3DX's record of files auto-generated by conversion from the authoring CAD.
The resource is plural (`dsdo:DerivedOutput**s**`), has no GET collection (you
`POST` to `/Locate`), and needs both an `id` and a `type` in the body. Verified
end to end: the staged part's `STEP_AP214` output downloads as 18,045 bytes of
valid `ISO-10303-21` and loads through the pipeline as 8 B-rep faces.

**Getting plans in** is: create a Document → FCS check-in → link it to the part.
The first two steps work; the third does not (see below).

### 3.4 Knowing what changed

Sync is a reconciliation loop rather than a download. For each in-scope remote
item, compare `cestamp` against the stored row:

| Situation | Action |
|---|---|
| Not in local catalog | insert as `new`, check for a STEP, render a preview |
| `cestamp` differs | update metadata, mark `modified`, **delete the cached STEP** (it is now the wrong geometry), flag any plan as stale |
| `cestamp` matches | touch `last_synced`, nothing else |
| Local row no longer visible remotely | mark `archived` (never delete) |

Full sync on startup and on the UI refresh button; a lighter incremental pass
on a timer. Phase 5 would replace polling with 3DX's JMS event bus, so the
catalog reacts to changes in near real time — the listener is written, but it
needs broker infrastructure (Dassault's EIF connector) we don't have yet, so
polling remains the live path.

---

## 4. Where it stands

Confirmed working against tenant `R1132100093385` as of 2026-08-12, by live
calls rather than from documentation:

| Capability | Status |
|---|---|
| CAS login across split regions | ✅ works |
| Catalog sync, cestamp change detection | ✅ 1000 items indexed; re-run correctly reports all unchanged |
| Bookmark-scoped catalog | ✅ 2.7 s for the curated set |
| Server-side space filtering | ✅ via `[ds6w:project]` |
| STEP download from derived outputs | ✅ downloads, loads, plans |
| Document creation + file check-in | ✅ plan uploaded, downloaded back, unwrapped intact |
| **Linking a plan Document to its part** | ❌ unresolved — no working endpoint found |
| **Per-object CAD thumbnails** | ❌ confirmed absent on this tenant |
| Issue creation for NCR workflow | ⚠️ implemented, untested (no anomaly run yet) |
| JMS event-driven sync | ⚠️ implemented, needs broker infrastructure |

Two gaps are worth understanding, because both have workarounds and neither
blocks the cell.

**No document↔part relationship.** An uploaded plan becomes a proper Document
with its file attached, but nothing ties it to the engineering item. Every
documented route 404s, and the SDK we cribbed the rest from has no Document
service to check. We record the document id locally instead
(`plans.plan_doc_id`), so a cell always re-finds its own plans; only
*cross-cell* discovery is missing. There is a plausible second route — attach
the plan as a derived output of the part, which would make it discoverable
through the same `Locate` call the STEP fetch already uses — but derived
outputs are converter-managed, and writing bespoke files into that collection
on a system of record risks interfering with the CAD conversion pipeline.
Worth asking Dassault or the tenant admin before adopting.

**No thumbnails.** This is not a matter of our parts lacking previews: the
tenant publishes no per-object preview images at all. The only images available
are per-*type* icons — byte-identical for every Physical Product — because on
a `VPMReference` the geometry lives on a separate representation object, and
every route to those is 404 or empty here. A grid of 1000 identical icons is
worse than nothing, so we don't cache them; the catalog **renders previews
locally from the cached STEP** instead (painter's-algorithm rasterization
through matplotlib's Agg backend, so it needs no GPU or display). Parts that
can actually be inspected get real artwork; the rest fall back to a
placeholder.

---

## 5. The transferable lesson

This platform fails in a way that mimics absence. A wrong-but-well-formed mask
gets `400 Mask does not exist`. A wrong-but-well-formed path gets `404`. An
unrecognized search tag gets `200` and zero results. A write with the wrong
verb gets `200` and does nothing. None of those responses distinguish "you
asked wrong" from "this doesn't exist" — and we twice wrote off a capability
that was working the whole time under a name we were never going to guess.

So: **enumerating plausible names is not evidence.** Check
[ws3dx-dotnet](https://github.com/3ds-cpe-emed/ws3dx-dotnet) — Dassault's own
public C# SDK, which documents endpoints and mask constants in source comments
— before concluding a 3DX capability is missing. The same caution applies to
the two gaps above: they were probed by hand, so they may yet be reachable
under names not tried.

---

*Source documents: `3dx_catalog_integration_plan.md` (architecture),
`3dx_plan_sync_addendum.md` (plan/result round-trip),
`3dx_step_ingest_addendum.md` (STEP loading and B-rep segmentation),
`TENANT_API_FINDINGS.md` (empirical endpoint findings).
Implementation: `viewpoint_generation/catalog/` on branch
`feature-3dx-integration`.*
