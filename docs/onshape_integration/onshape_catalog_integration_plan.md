# Onshape catalog integration — research and plan

How the inspection cell could pull parts from **Onshape** the same way it pulls
them from 3DEXPERIENCE today, feeding the **same** `catalog.db`, picker UI and
ROS 2 services.

Status: **research only, nothing built or called live yet.** Endpoint paths
were taken from the public docs (<https://onshape-public.github.io/docs/>) and
from Onshape's own OpenAPI spec (`GET https://cad.onshape.com/api/openapi`,
public, ~2 MB). That spec is the Onshape counterpart of `ws3dx-dotnet` and the
first place to check before guessing an endpoint. Anything marked **verify**
needs a live call before code depends on it. `TENANT_API_FINDINGS.md` shows
how often documented and actual behaviour differed on 3DX.

---

## 1. TL;DR

- **Feasible, and easier than 3DX in most places.** Auth is a static API key
  pair (no CAS redirects, CSRF or security context). STEP export is a
  documented first-class call. Real per-part thumbnails exist. A plan can be
  stored *inside the part's own document*, which closes the gap 3DX never did
  (Document ↔ part linkage).
- **The constraint that matters is the annual API call quota**, not the
  API's capability. The lab is on the **Educator plan: 2,500 successful calls
  per year for the whole company** (≈ 7/day), shared by every key and every
  researcher. The 3DX sync design (full sync on startup and every 300 s) would
  use that up in a day. The Onshape backend has to be
  event-driven (webhooks, which don't count toward the quota) or poll
  rarely and cheaply. See §6.
- **Integration shape:** add a second backend behind the existing
  `CatalogSync`. The catalog, picker, ROS interfaces, plan envelope, STEP
  loader and B-rep segmentation stay as they are. One catalog can hold parts
  from both systems at once, with a `source` column to tell them apart.

---

## 2. Concept mapping: 3DX → Onshape

| 3DX concept (as used today) | Onshape equivalent | Notes |
|---|---|---|
| Tenant + passport + space URLs | One base URL: `https://cad.onshape.com/api/v{N}` (enterprise: `https://{company}.onshape.com/api`) | Version goes in the path; pin per endpoint. |
| CAS login + CSRF + `SecurityContext` | API key pair, HMAC-signed per request | §3 |
| EngItem (`VPMReference`) | **Part** = (document `did`, element `eid`, part `partId`, optional `configuration`) | Not one opaque id; the catalog key has to be built from these (§5). |
| `cestamp` | **Version id** (immutable) or **microversion id** (changes on every edit) | §4, the key design choice. |
| Maturity (`IN_WORK` / `RELEASED`) | Part `state` + **revision** (release management) | Release management needs a company/EDU-enterprise plan (**verify** for UW's plan). |
| Bookmark "Inspection Parts" | **Folder**, listed with `GET /globaltreenodes/folder/{folderId}` (undocumented; see §13) | A folder is the closest match to a curated bookmark. `GET /documents?parentId=` ignores `parentId`. |
| `[ds6w:project]` search predicate | `GET /documents?q=…&filter=…&owner=…` | `filter`: 0 mine, 1 created, 2 shared, 4 public, 6 by owner, 7 by company, 9 by team. |
| `dsdo` derived output (STEP) | Async export: `POST /partstudios/d/{did}/{wv}/{wvid}/e/{eid}/translations` → poll → download | §7. Generated on demand, not stored by a converter. |
| FCS ticket upload/download | Normal multipart / `octet-stream` on the API host (307 redirects on some sync exports) | No ticket dance. |
| Thumbnails (absent on our tenant) | `GET /thumbnails/d/{did}/{wv}/{wvid}/e/{eid}/s/{WxH}`, `parts?withThumbnails=true`, `…/partid/{pid}/shadedviews` | Real images; local rendering becomes a fallback. |
| Document + check-in + (failed) link | **Blob element** in the part's document: `POST /blobelements/d/{did}/w/{wid}` | Lives in the part's document, so linkage comes for free. §8 |
| `dsiss` Issue (NCR) | **Comment** on the document/part, with attachment: `POST /comments`, `POST /comments/{cid}/attachment` | Or `onshape.task.*` tasks (**verify** API). |
| JMS + EIF broker | **Webhooks**: `POST /webhooks` to a public HTTPS URL | No broker product needed, but the endpoint must be publicly reachable (§6). |

---

## 3. Authentication

For a headless cell, use **API keys with request signing**. OAuth2 is only
needed for App Store apps or for acting as individual operators.

- Create keys under *My Account → Developer → API keys* (personal, max 2
  active) or *Company/Classroom/Enterprise settings → Developer* (no cap).
  **Keys only work on the stack they were made on** (cad vs. an enterprise
  domain).
- Each request carries:
  - `Date`: RFC 1123, within 5 min of server time. The container clock must be
    NTP-synced.
  - `On-Nonce`: ≥16 alphanumeric chars, unique per request.
  - `Authorization: On {accessKey}:HmacSHA256:{base64(hmac_sha256(secret, S))}`
    where `S = lower("{METHOD}\n{nonce}\n{date}\n{content-type}\n{path}\n{query}\n")`.
- **307 redirects** (sync exports, some downloads) must be **re-signed for the
  new host/path/query**. `requests` will follow them with a stale signature,
  so set `allow_redirects=False` and handle the 307 yourself, as 3DX needed for
  login.
- `Authorization: Basic base64(access:secret)` also works and is fine for a
  first spike, but the docs call it local-testing-only.

Like the 3DX client's `_looks_like_login_redirect`, expect auth failures to
surface oddly. **Verify** what a bad signature or skewed clock returns.

---

## 4. Change detection and revision binding (the key design choice)

In 3DX, one `cestamp` decides whether the catalog row is stale, whether the
cached STEP is stale and whether the plan is stale. Onshape offers three
candidates:

| Stamp | Mutable? | Changes when | Fit |
|---|---|---|---|
| Workspace **microversion** | n/a (moves) | *any* edit anywhere in the document, including adding a blob tab | Too noisy. Writing a plan into the doc would itself invalidate the plan. |
| Part `microversionId` (in the parts list response) | – | Probably only when that part changes (**verify**) | Good for tracking work-in-progress geometry. |
| **Version id** (`v/{vid}`) / **revision** | immutable | someone creates a version / releases | **Recommended.** Reproducible STEP, and a plan bound to an id that can't drift. |

**Decided: saved versions.** The catalog reads from the **latest version** of each
document (or the latest *released revision* where release management is
available), never from the live workspace. Then:

- `cestamp` column ← **mass-property fingerprint** of the part (hash of rounded
  volume, centroid, inertia) at the latest version. Measured in Phase 0: the
  part's `microversionId` is the *document* microversion and changes for every
  part on every version; mass properties change only for the edited part. The
  Part Studio's element microversion is the prefilter (unchanged → skip the
  mass-properties call). See `ONSHAPE_API_FINDINGS.md`. `versionId` is still
  recorded in `source_ref` and in each plan's PLM context.
- `revision` column ← revision name if released, else version name (e.g. `V7`)
- `maturity` column ← part `state` (`IN_PROGRESS`, `PENDING`, `RELEASED`, `OBSOLETE`)

This is the Onshape equivalent of `DX_MATURITY_FILTER=RELEASED`. Researchers
choose what the cell sees by creating a version, which is already a normal
Onshape habit. Released revisions are not used. An optional
`ONSHAPE_TRACK=workspace` mode could follow the live workspace for development,
with the noisy-stamp caveat.

Writing plans into the document (§8) happens in the **workspace**, so it never
changes an existing version id. Plans therefore stay valid until an engineer
deliberately versions new geometry.

---

## 5. Integration with the existing catalog

### 5.1 Backend abstraction

`CatalogSync` currently calls these `DXClient` methods (from
`catalog/sync.py`):

```
find_bookmark  list_bookmark_items  is_eng_item  get_eng_item  search_eng_items
find_step_output  download_derived_output  get_thumbnail
upload_inspection_plan  list_related_documents  download_document_file
upload_result_bundle  create_issue  get_security_contexts  ensure_login
```

Most of these are 3DX vocabulary for generic operations. Proposal: put a small
backend interface between `CatalogSync` and the client, and make `DXClient`
the first implementation:

```python
class CatalogBackend:            # catalog/backend.py
    source: str                  # '3dx' | 'onshape'
    def ensure_login(self): ...
    def list_scope_items(self, config) -> tuple[list[dict], int]   # normalized rows, scanned
    def get_item(self, item_id) -> dict | None
    def has_step(self, item_id) -> bool
    def fetch_step(self, item_id, dest: Path) -> Path
    def get_thumbnail(self, item_id) -> bytes | None
    def upload_plan(self, item_id, plan_path, title) -> str        # remote plan id
    def find_remote_plans(self, item_id, title_prefix) -> list[dict]
    def download_plan(self, plan_ref, dest) -> Path
    def upload_results(self, item_id, bundle_path, title) -> str
    def raise_issue(self, item_id, title, description, severity) -> str | None
    def changes_since(self, cursor) -> tuple[list[str], cursor]    # incremental
```

`_resolve_bookmark` / `_fetch_bookmark_items` / `_scope_query` move into
`DXBackend.list_scope_items`. `CatalogSync` keeps the reconciliation loop,
cestamp diffing, caching, plan envelope and run bookkeeping unchanged.
`DXAuthError`/`DXAPIError` become `CatalogAuthError`/`CatalogAPIError`, with
the DX names kept as aliases. This refactor is worth doing on its own. It is
the only part that touches working 3DX code, so do it first, behind the
existing tests, before any Onshape code exists.

### 5.2 Identity

`parts.eng_item_id` stays the primary key and stays opaque to everything
above the backend, but becomes namespaced:

```
3DX:      <hex id>                                   (unchanged, no migration)
Onshape:  os:{did}:{eid}:{configKey}:{partId}      (configKey = 'default' or short hash, §5.5)
```

`partId`s are deterministic but short (e.g. `JHD`) and only unique within
an element and configuration, so every segment is required. Part IDs change
between configurations, so `configKey` comes before `partId` (§5.5).

### 5.3 Schema additions (additive migration in `schema.py`)

```sql
ALTER TABLE parts ADD COLUMN source      TEXT DEFAULT '3dx';  -- '3dx' | 'onshape'
ALTER TABLE parts ADD COLUMN source_ref  TEXT;  -- JSON: {did, eid, pid, wvm, wvmid, configuration, href}
ALTER TABLE parts ADD COLUMN web_url     TEXT;  -- "open in CAD" link for the picker detail panel
```

Existing column reuse: `collab_space` ← document/folder name, `type` ←
`PARTSTUDIO`/`ASSEMBLY`, `part_number` ← Onshape part number (may be empty),
`title` ← part name. `plans.plan_doc_id` / `inspection_runs.result_doc_id`
hold `os:{did}:{blobEid}` refs.

### 5.4 Running both at once

`ros_node.py` builds a list of backends from env (3DX if `DX_*` is set,
Onshape if `ONSHAPE_*` is set) and gives `CatalogSync` a `{source: backend}`
map. Sync runs each backend's scope and reconciles rows **per source** (a
3DX outage must not archive the Onshape rows, and vice versa). Each row
dispatches to `backends[row.source]`. The picker gets a source badge and a
source filter. `ListParts.srv`/`PartSummary.msg` gain a `source` field (the
only interface change).

### 5.5 Configured Part Studios (deferred)

**Decided: out of scope for now.** The lab doesn't use configured Part
Studios. v1 reads every Part Studio at its default configuration
(`configKey = default`) and sends no `configuration` parameter. The key keeps
its `configKey` segment so pinned configurations can be added later without
re-keying the catalog. The notes below are kept for that.

A Part Studio can have **one configuration** made of several inputs: list
(e.g. size `S/M/L`), checkbox, numeric variable (e.g. `Length = 75 mm`), or
text. Each combination of values is a different geometry from the same
feature tree. A bracket family in three lengths and two hole patterns is one
Part Studio and six parts.

How the API treats them:

- Every geometry call takes a `configuration` string: query param on GETs
  (`?configuration=List_abc%3D_500_mm`), body field on exports. It uses the
  input's internal **parameter id** and the option's internal **id**, not the
  names shown in the UI (`List_izOjbm5HCRXEld=_500_mm`, not `Length=500 mm`).
  `POST /elements/d/{did}/e/{eid}/configurationencodings` turns a
  `{parameterId, parameterValue}` list into the right string.
  `GET …/e/{eid}/configuration` lists the inputs and options.
- **Changing the configuration changes the part ID.** The same physical part
  has a different `partId` in each configuration, so identity must be
  *(element, configuration)* first, then the part ID *for that configuration*.
- Parts list, thumbnails, STEP export and mass properties all take the same
  string, so the read path is the same code with one extra parameter.

What it means for the catalog:

- **Each configuration is its own catalog row**, with its own STEP, thumbnail,
  plan and runs, because it is different geometry. The key becomes
  `os:{did}:{eid}:{configKey}:{partId}`, where `configKey` is a short hash of
  the canonical (sorted) configuration string. The full string, plus
  human-readable names, goes in `source_ref`.
- **Configurations multiply quota cost.** Every row costs its own parts fetch
  (×1), STEP export (~×5) and thumbnail. Two list inputs with 4 and 5 options
  are 20 rows: about 100 calls just to export STEP once. Enumerating
  every combination automatically would be a quota disaster, and numeric
  inputs have infinitely many values anyway.
- **One version change invalidates every configuration** of that Part Studio.
  It is one feature tree, and the per-part microversion check (§8) decides
  which configurations really changed.

Three ways to support them, in order of effort:

1. **Default configuration only.** The Part Studio's default is one row,
   other configurations are invisible. Zero extra work. Fine if nobody
   uses configurations.
2. **Pinned configurations (recommended v1).** A researcher lists the
   configurations the cell should know about, and each becomes a row. Where to
   list them: a small `inspection_configs.json` blob tab in the document
   (readable in the same document fetch, editable in Onshape), or a local
   YAML in `catalog/`. The picker shows them as a family: one card per Part
   Studio with a configuration dropdown.
3. **Pick at selection time.** The picker reads the configuration inputs
   (`GET …/configuration`, 1 call) and lets the operator choose any values,
   including numeric. The row is created on demand and cached by `configKey`.
   This is the most flexible, but every new combination costs a STEP export
   when it is picked.

A research angle worth noting: a configured family is a natural test set for
**plan reuse across variants** (does a plan for the 75 mm bracket transfer to
the 100 mm one?). The schema could record `family_id = os:{did}:{eid}`
on each row so plans and results can be compared across a family later.

### 5.6 What doesn't change

STEP loader, B-rep segmentation, the plan file format (PLM context in
top-level keys beside `meshes`), `PLAN_<part>_<rev>_<STAGE>` naming,
`auto_upload_plan_stages`, stale-plan logic, thumbnail fallback renderer,
`/catalog/part_selected`.

---

## 6. API quota and sync cadence (the main constraint)

From `/docs/auth/limits/`: only 2xx/3xx responses count. Webhook deliveries
and 4xx/5xx don't. Exhaustion returns **402 Payment Required**. Rate limits
return **429**.

| Plan | Annual calls |
|---|---|
| EDU Student, Free, Standard | 2,500 **per user** |
| EDU Educator / Pro / Discovery | 2,500 **per company** |
| EDU Enterprise | 10,000 per enterprise |
| Professional | 5,000 per user |
| Enterprise | 10,000 per full user |

Rough cost of the 3DX-style design on Onshape (N = 20 parts in 10 documents):

| Activity | Calls | Notes |
|---|---|---|
| List scope folder | 1 | `GET /documents?parentId=…&sortColumn=modifiedAt` |
| Per changed document: versions + parts (+ thumbnails inline) | 2 | `withThumbnails=true` avoids N thumbnail calls |
| STEP fetch | ~3–6 | create translation, 1–4 polls, download |
| Plan upload | 1–2 | blob element create |
| Result upload | 1 + files | |
| Polling every 300 s, 1 call | 105,000/yr | **42× the student quota** |
| Polling once/hour | 8,760/yr | still too much on 2,500 |

**Design consequences:**

1. **Cheap prefilter:** each poll makes **one** call (scope folder listing,
   compare each document's `modifiedAt` against the stored value). Only
   documents that changed get the 2-call detail fetch. Document `modifiedAt`
   moves on any edit, so it is a "maybe changed" hint. The version id decides
   the real `cestamp`.
2. **Default cadence:** manual *Sync* button + at most daily
   (`ONSHAPE_SYNC_INTERVAL_SEC=86400`, separate from 3DX's 300 s). The
   startup sync is **throttled** (`ONSHAPE_STARTUP_MIN_AGE_SEC=43200`): it is
   skipped if the last Onshape sync is newer than that, because the container
   restarts often during development and each restart would otherwise cost a
   sync.
3. **Webhooks** (Phase 5) as the real change feed, since deliveries are
   free. Useful events (full list from the spec's `createWebhook` callbacks):
   `onshape.model.lifecycle.createversion`, `onshape.revision.created`,
   `onshape.workflow.transition`, `onshape.model.lifecycle.metadata`,
   `onshape.document.lifecycle.statechange`, `onshape.model.translation.complete`
   (replaces export polling), `onshape.comment.create`.
   - Register with `companyId` (all company docs) or per `documentId`. Set
     `isTransient=false` or Onshape garbage-collects idle hooks.
     Registration isn't de-duplicated, so `GET /webhooks` first.
   - Onshape sends `webhook.register` immediately and **cancels the hook if
     the endpoint doesn't return 200**, so the receiver must be up first.
   - **The URL must be publicly reachable over HTTPS with a CA-signed cert.**
     The cell is on the lab LAN. See §6.1 for how to get there. This is the
     Onshape counterpart of 3DX's "needs EIF broker" blocker, but much
     cheaper to set up.
4. **Client-side accounting:** count successful calls in `sync_log`, log a
   running total, and back off on 429 / stop on 402, so the cell degrades
   like it does when 3DX is unreachable.

### 6.1 Webhook delivery: tunnel vs. relay

Onshape POSTs to a URL. The cell sits behind UW's network with no public
address, so something public has to receive the POST.

| Option | How it works | Cell offline? | Exposure |
|---|---|---|---|
| **Cloudflare Tunnel** (`cloudflared`) | Daemon on the cell opens an *outbound* connection to Cloudflare. A hostname on a Cloudflare-managed domain routes back down it. Ingress rules can restrict to one path. | Deliveries fail | Public hostname → cell; needs a domain on Cloudflare. "Quick tunnels" (`trycloudflare.com`) get a new random URL each run, which breaks a registered webhook. |
| **Tailscale Funnel** | Tailscale node on the cell; `tailscale funnel` publishes a port at `https://<host>.<tailnet>.ts.net` with a valid cert. | Deliveries fail | Public URL → that port; exposes a whole port, not a path. |
| **ngrok** | Same idea; free tier includes one static domain. | Deliveries fail | Public URL → cell; third-party account. |
| **Cloud relay** (recommended) | Tiny always-on function (Cloudflare Worker + Queue/KV, AWS Lambda + SQS, or GCP Function + Pub/Sub) receives the POST, stores the event. The cell polls the relay (e.g. every 60 s). | **Events queue up** | **Nothing inbound to the lab.** Only outbound HTTPS from the cell. |

**Why the relay is the recommendation:**

- **Onshape drops webhooks whose endpoint stops responding** "for an extended
  period". With a direct tunnel, a cell switched off over a weekend or
  holiday can silently lose its webhook and miss every change until someone
  re-registers. A relay is always up, so registration stays healthy and events
  wait for the cell.
- **Easiest to clear with UW IT.** Outbound-only HTTPS from the lab is
  ordinary traffic. A tunnel is also outbound-only, but it still publishes a
  path *into* a lab machine, which is the thing IT policies tend to ask about.
- **Polling the relay costs no Onshape quota.** Only the follow-up fetch for
  a real change does.
- Free tiers of any of these cover the volume (a few events a day).

Cost of the relay: one more component to deploy and keep credentials for, and
up to one relay-poll interval of latency, which is irrelevant here.

**Decided: relay, on Cloudflare Workers, in Colin's existing Cloudflare account** (the one hosting `colinacton.org`).

#### Hosting the relay

The relay is a few dozen lines of code, but it has to run *somewhere* with a
public HTTPS address, which means an account with a cloud provider. The cell
itself needs no cloud account, only the relay's URL and a token.

| Host | Shape | Cost at this volume | Notes |
|---|---|---|---|
| **Cloudflare Workers** (suggested) | Worker receives the POST and stores events in D1 (SQLite) or KV; a second route returns and clears queued events for the cell | Free tier | Free `*.workers.dev` HTTPS address, so no domain needed. Fewest moving parts; deploy with `wrangler`. |
| AWS | API Gateway or Lambda function URL → SQS | Free tier / cents | More IAM setup. Fits if the lab already has AWS. |
| Google Cloud | Cloud Run / Functions → Pub/Sub or Firestore | Free tier / cents | Fits if the lab already has GCP. |
| Azure | Functions → Storage Queue | Free tier / cents | Fits if UW-provisioned Azure is already in use. |

Expected load: a few webhook deliveries a day plus the cell polling every
60 s (~1,440 requests/day), well inside every free tier. **verify** current
free-tier limits for whichever is chosen.

**Ownership matters more than the provider.** Onshape stores the relay URL
in the webhook registration. If the account dies (a student graduates, a card
expires, a personal account is closed), webhooks stop and the cell silently
falls back to daily polling. Prefer, in order:

1. An account UW or the department already provides for research computing
   (ask UW-IT / department IT what cloud accounts exist for labs).
2. A lab-owned account on a shared lab email, with credentials in the lab's
   password manager and the relay code and deploy script in this repo.
3. A personal free account. Fine for prototyping. Move it before anyone
   else depends on it.

Whichever is used, keep the relay source and deploy script in this repo
(`relay/onshape_webhook_relay/`) so it can be redeployed to a new account in
minutes, and keep the Onshape API key under the same lab-owned identity.

#### Chosen setup: Colin's Cloudflare account

This is option 3 above. It's the fastest path, with the graduation caveat
accepted for now.

- **Separate Worker, same account.** The relay is its own Worker
  (`onshape-webhook-relay`) with its own D1 database. It shares nothing with
  the website and can't affect `colinacton.org`.
- **Address:** start on `onshape-webhook-relay.<account>.workers.dev`. A
  custom hostname such as `onshape-relay.colinacton.org` is optional; it
  looks nicer but ties the lab's webhook to the personal domain. Either way
  the URL is registered with Onshape once and re-registered by the cell's
  self-heal check if it ever changes.
- **Deploy credentials:** deploy with `wrangler` using a Cloudflare API token
  scoped to **Workers Scripts + D1 edit on this account only**, with no DNS
  or zone permissions. A leaked deploy token then can't touch the website.
  The token stays on the deploy machine, not in the cell's `.env`.
- **Secrets** (set with `wrangler secret put`, never committed):
  `HOOK_PATH_SECRET` (random path segment Onshape posts to) and
  `CELL_TOKEN` (bearer token the cell polls with).

**Option: put the relay on `inspection.colinacton.org`.** That subdomain is
already behind a GitHub login, presumably Cloudflare Access with GitHub as the
identity provider (**verify**). Neither caller can do an interactive login, so
each path gets its own Access rule:

| Path | Caller | Access policy |
|---|---|---|
| `/onshape/hooks/{HOOK_PATH_SECRET}` | Onshape | **Bypass** (separate, more specific Access application on this path). The path secret is the only gate, as on `workers.dev`. |
| `/onshape/events` | the cell | **Service Auth** with an Access **service token**. The cell sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. The Worker still checks `CELL_TOKEN` as a second layer. |
| everything else | people | unchanged GitHub login |

**Confirmed:** Cloudflare Access with GitHub login. The subdomain is the
static Quartz site in `cacton77/vault`, built by `.github/workflows/publish.yml`
and pushed by Direct Upload to the Cloudflare Pages project
`vault-inspection`. That workflow's API token is scoped to Pages only.

The relay is **not** added to the vault repo as a Pages Function. It would
redeploy on every notes push, need a D1 binding on the Pages project, and mix
cell infrastructure into a notes site. Instead it is a **separate Worker**
deployed from this repo (`relay/onshape_webhook_relay/`, its own `wrangler.toml`
and its own Workers+D1 token), attached by a **Worker route**
`inspection.colinacton.org/onshape/*`. Pages never sees those paths, so the
site and its workflow are unchanged.

**verify** that the Worker route takes precedence over the Pages custom
domain for `/onshape/*`. If it doesn't, use a sibling hostname
(`inspection-relay.colinacton.org`, a Worker custom domain with its own Access
application): same design, no shared hostname. **verify** that the path-scoped Bypass
application wins over the subdomain-wide one (Access matches the most
specific path), and that the Onshape `webhook.register` ping gets a 200 from
the Worker, not an Access login redirect, before registering the real hook.
Benefit: polling the events can't be reached by anyone without the service
token, enforced by Cloudflare before the Worker runs, and later remote views
of the cell (e.g. the picker over a tunnel) could sit behind the same GitHub
login.

Relay sketch (~100 lines of TypeScript):

```
POST /hooks/onshape/{HOOK_PATH_SECRET}
     → parse JSON; keep only {event, documentId, workspaceId, versionId,
       elementId, timestamp, webhookId}; INSERT into D1 events table
     → always answer 200 fast (Onshape cancels a hook whose register
       ping isn't answered 200)
     → wrong path secret → 404, store nothing

GET  /events?after={id}            Authorization: Bearer {CELL_TOKEN}
     → up to 500 events with id > after, oldest first

Cron (daily) → DELETE events older than 30 days
```

The cell keeps its own `after` cursor in `catalog.db`, so nothing has to be
acknowledged and a lost response just means re-reading the same events.
Debouncing and scope filtering happen on the cell (§6.1 security notes).
Config: `ONSHAPE_WEBHOOK_PUBLIC_URL` = the `/hooks/onshape/<secret>` URL,
`ONSHAPE_RELAY_POLL_URL` = `…/events`, `ONSHAPE_RELAY_TOKEN` = `CELL_TOKEN`.

**Security, whichever route is used:**

- Treat every webhook as a *hint*, never as data. On an event, re-fetch the
  document through the authenticated API, and never act on payload contents.
  A forged POST can then cost at most a few calls, never inject a part.
- Accept only events whose `documentId` is already in the scope folder, and
  debounce per document (one re-fetch per document per N minutes). This bounds
  the quota an attacker or a burst of edits can burn.
- Put a long random secret in the URL path (`/hooks/onshape/<32 random chars>`)
  and drop anything else at the edge. Onshape's help page describes an extra
  authentication layer for webhooks. **verify** what it offers before relying
  on the path secret alone.
- With a direct tunnel, run a separate minimal receiver on its own port.
  Don't expose the Flask picker, which can trigger robot-adjacent actions.

**Self-healing:** on startup and daily, the cell calls `GET /webhooks`
(1 call) and re-registers if its hook is missing, then runs one catch-up
sync. That covers anything missed while the hook was gone.

### 6.2 Budget for the lab's Educator plan (2,500 calls/year, whole company)

The quota is **per company**, so the cell shares it with every researcher's
API keys and authenticated API Explorer sessions. Estimate for ~20 parts in
~10 documents and ~100 inspection runs a year:

| Item | Calls/yr |
|---|---|
| Daily prefilter (1 call) | ~365 |
| Detail fetch for changed documents (~3/week × 2) | ~310 |
| STEP exports (~100 new part versions × ~5) | ~500 |
| Plan uploads (~100 × 1–2) | ~150 |
| Result uploads (~100 runs × ~3) | ~300 |
| **Cell total** | **~1,600** |
| Left for development, other researchers, Explorer | ~900 |

That's workable but tight, so:

- **Webhooks (Phase 5) are worth more here than they were for 3DX.** They
  remove most of the prefilter and detail-fetch lines, and let STEP exports
  wait for `translation.complete` instead of polling.
- **Keep the call counter honest.** `ONSHAPE_CALL_BUDGET=2500` with a
  warning at 80% and a hard stop (local-only mode) at 95%, so a runaway loop
  can't spend the lab's whole year. Onshape doesn't expose remaining quota via
  the API (**verify**), so the local count is the only gauge. It won't see
  other researchers' usage, so the hard stop should leave headroom.
- **Development is cheap if done right.** 4xx/5xx responses are free, but every
  successful call in the Phase 0 spike counts. Save raw responses to disk and
  re-run against those instead of the API.
- **Batch where the API allows:** `GET /parts/d/{did}/v/{vid}` (no element)
  returns every part in the document in one call, with
  `withThumbnails=true`.
- **Results:** upload the manifest plus a small preview by default and keep
  large point clouds in lab storage, so each run costs ~2 calls, not one per
  file.

If the cell outgrows this, EDU Enterprise (10,000/yr) or buying extra calls
are the options.

---

## 7. STEP export

Single part, from an immutable version:

```
POST /api/v{N}/partstudios/d/{did}/v/{vid}/e/{eid}/translations
{
  "formatName": "STEP",                 # must match GET /translations/translationformats
  "partIds": "{pid}",                   # generic endpoint has partIds; /export/step does not
  "stepVersionString": "AP242",         # AP203 | AP214 | AP242
  "unit": "METER",                      # verify field name vs stepUnit; pipeline expects metres
  "storeInDocument": false,             # don't add a tab to the design doc
  "configuration": "{config}"           # if configurable
}
→ { "id": tid, "requestState": "ACTIVE", ... }

GET /api/v{N}/translations/{tid}         # poll with backoff until DONE | FAILED
→ { "requestState": "DONE", "resultExternalDataIds": [fid], "failureReason": ... }

GET /api/v{N}/documents/d/{did}/externaldata/{fid}   # bytes (may be a .zip; verify)
```

- `/partstudios/.../export/step` (`BTBStepExportParams`) is the newer,
  format-specific endpoint, but its schema has **no `partIds`**, so it
  exports the whole Part Studio. Use the generic `/translations` route for
  one part, or export the whole studio and split bodies locally.
- Exports only accept `w` or `v`, not `m`: another reason to bind to versions.
- Output may be zipped (`Part Studio 1.zip` in examples). Unzip before
  `step_loader.load_step()`.
- Cache path stays `catalog/steps/{eng_item_id}/{revision}.stp` (sanitize the
  `os:` key for the filesystem).
- Bonus: `GET /parts/…/partid/{pid}/parasolid` (sync) exists. Parasolid
  is OCC-readable via plugins only, so STEP stays the format.

---

## 8. Plan and result upload: where it gets better than 3DX

### Plans

Store the plan **as a blob element in the part's own document**:

```
POST /api/v{N}/blobelements/d/{did}/w/{wid}        multipart: file=PLAN_<part>_<rev>_ORDERED.json
→ element id (a new tab, visible in the Onshape UI)
POST /api/v{N}/blobelements/d/{did}/w/{wid}/e/{eid} # update in place on re-plan
GET  /api/v{N}/blobelements/d/{did}/{wvm}/{wvmid}/e/{eid}   # download
```

Discovery (`find_remote_plans`) = list document elements, filter `BLOB` tabs
named `PLAN_<part>_…`. One call, works from any cell with access.
**This replaces the missing 3DX Document↔EngItem link.** The plan's
top-level PLM context records `versionId`, so staleness logic is unchanged.

**Decided:** plan and result tabs live in the design documents. The users are
the robotic-inspection researchers themselves, so robot tabs in their
documents are acceptable. The cell's API key needs **write access** to every
document in the scope folder. Share the folder with the key owner as an
editor.

Consequences of storing plans in the design document:
- **The stamp must be per-part, not per-document.** Uploading a plan tab
  edits the workspace, and the next time anyone versions the document the
  version id changes even though the part's geometry didn't. A `cestamp` of
  `versionId` alone would mark every plan stale on the next version.
  **Resolved in Phase 0:** the part `microversionId` is document-wide, so the
  stamp is the mass-property fingerprint (§4). Still to confirm: adding a plan
  tab and versioning leaves every fingerprint unchanged (notebook §9).
- Group the tabs in a tab folder (e.g. `Inspection/`) so they stay out of the
  way of the CAD tabs. **verify** whether blob creation can target a tab folder.
- A records-document fallback (`ONSHAPE_PLAN_STORE=records_doc:{did}`) stays
  in the config for documents the cell can't write to, e.g. public or
  view-only shares.
- An **app element** (`/appelements/…`, JSON-tree structured storage with
  history and diffs) is the native, more elegant store. It's more work and may
  require an OAuth app. **verify** with API keys. Keep it as an option, not v1.
- Optionally write a pointer into a part **custom property**
  (`POST /metadata/d/{did}/w/{wid}/e/{eid}/p/{pid}`, e.g. "Inspection plan:
  PLAN_…"). Custom property definitions need company admin.

### Results

Same blob mechanism (`RESULT_<part>_<rev>_<run_id>.zip`). **Verify blob size
limits** before uploading point clouds. Large bundles may belong in lab
storage with only the manifest + link in Onshape.

### NCR / anomalies

`POST /comments` on the document/element, with
`POST /comments/{cid}/attachment` for the anomaly image. Comments notify
document followers, which is closer to what an NCR should do than an orphaned
3DX Issue.

---

## 9. Thumbnails

Per-element and per-part thumbnails exist (unlike our 3DX tenant):

- `GET /parts/d/{did}/v/{vid}?withThumbnails=true`: thumbnail info inline
  with the parts list, at no extra call
- `GET /thumbnails/d/{did}/v/{vid}/e/{eid}/s/300x300` (PNG, `skipDefaultImage=true`
  to get 404 instead of a placeholder)
- `GET /parts/…/partid/{pid}/shadedviews?viewMatrix=…&outputWidth=…`: arbitrary
  view, base64 PNG

Each image fetch costs quota. Fetch once per `cestamp` and keep
`catalog/thumbnails.py` local rendering as the fallback and for 3DX.

---

## 10. Configuration

```bash
# Onshape backend — enabled when ONSHAPE_ACCESS_KEY is set
ONSHAPE_BASE_URL=https://cad.onshape.com          # or https://{company}.onshape.com
ONSHAPE_API_VERSION=v17                            # spec's 'Current' as of Oct 2026; pin per endpoint if needed
ONSHAPE_ACCESS_KEY=
ONSHAPE_SECRET_KEY=
ONSHAPE_SCOPE_FOLDER="Inspection Parts"            # folder name or id (≈ DX_BOOKMARK_SCOPE)
ONSHAPE_SCOPE_LABEL=                               # alternative scope
ONSHAPE_TRACK=version                              # version (decided) | workspace (dev only)
ONSHAPE_PLAN_STORE=document                        # document | records_doc:{did} | local
ONSHAPE_SYNC_INTERVAL_SEC=86400                    # quota-driven, see §6
ONSHAPE_STARTUP_MIN_AGE_SEC=43200                  # skip startup sync if last sync is newer
ONSHAPE_CALL_BUDGET=2500                           # Educator plan: per company per year
ONSHAPE_BUDGET_WARN_FRAC=0.8                       # log warning
ONSHAPE_BUDGET_STOP_FRAC=0.95                      # switch to local-only mode
ONSHAPE_WEBHOOK_MODE=relay                         # relay | direct | off  (§6.1)
ONSHAPE_WEBHOOK_PUBLIC_URL=                        # URL registered with Onshape (relay or tunnel)
ONSHAPE_RELAY_POLL_URL=                            # relay mode: where the cell fetches queued events
ONSHAPE_RELAY_TOKEN=                               # relay mode: cell's credential for the relay
ONSHAPE_CONFIG_MODE=default                        # default (v1) | pinned | on_demand  (§5.5, deferred)
```

Add the same placeholders to `.env.example`. No new Python deps:
`requests` + `hmac`/`hashlib` from the stdlib cover signing. The official
`onshape-clients` generated Python SDK exists but is heavy, so a ~400-line
`OnshapeClient` matching `DXClient`'s style is preferred.

---

## 11. Phases

| Phase | Work | Exit test |
|---|---|---|
| **0 — Spike** (½ day) | Notebook like `3dx_rest_api_tour.ipynb`: sign a request, list the scope folder, list versions + parts, export one part to STEP, upload/download a blob. Record real responses in `ONSHAPE_API_FINDINGS.md` and save them to disk for offline replay (each successful call costs quota). Budget: ≤150 calls. | STEP from Onshape loads via `load_step()`. Verify items in this doc resolved. |
| **1 — Backend seam** | `CatalogBackend` interface, `DXBackend` wrapping `DXClient`, generic exceptions, `source`/`source_ref`/`web_url` columns. **No behaviour change.** | 3DX full sync, STEP fetch, plan upload still pass. |
| **2 — Onshape read path** | `OnshapeClient` (signing, 307 re-sign, 429/402 handling, call counter), `OnshapeBackend.list_scope_items` / `get_item` / `fetch_step` / `get_thumbnail`. Multi-backend wiring in `ros_node.py`. | Mixed catalog in picker; select an Onshape part → viewpoints generated. |
| **3 — Picker/ROS touches** | `source` in `PartSummary`, badge + filter, "Open in Onshape" link. | |
| **4 — Plans & results** | Blob-element plan store + discovery, result bundles, comment-based NCR. | Second cell (or wiped catalog) re-discovers a plan from Onshape. |
| **5 — Webhooks** | Cloud relay (receive + queue) and a cell-side relay poller (or direct tunnel receiver), register/ping/self-heal via `GET /webhooks`, debounced event → `sync_single_item`. Polling remains the fallback. | New version in Onshape appears in picker without a manual sync. |

---

## 12. Open questions

Resolved:
- ~~Which Onshape plan?~~ **Educator**: 2,500 calls/year shared by the
  whole company (§6 budget).
- ~~Plan/result tabs in design documents?~~ **Yes.** Users are the
  inspection researchers (§8).

Still open:

- ~~Versions or released revisions?~~ **Saved versions** (§4).

- ~~Tunnel or relay?~~ **Relay** (§6.1).
- ~~Configured Part Studios?~~ **Not used.** Default configuration only, deferred (§5.5).

- ~~Relay host?~~ **Colin's Cloudflare account**, separate Worker + D1 (§6.1).

1. Host on `inspection.colinacton.org/onshape/*` behind Cloudflare Access
   (bypass for the hook path, service token for polling), or plain `workers.dev`?
2. Which identity owns the Onshape API key: a researcher's account or a
   shared lab account? Same graduation risk as the relay.

## 13. Verify list

Settled by the notebook `onshape_rest_api_tour.ipynb` (Phase 0). Its findings go in
`ONSHAPE_API_FINDINGS.md`.

Already found while building it (unauthenticated probes, free):
- [x] **`GET /users/sessioninfo` answers an invalid key with `204 No Content`, not
  401.** Judge auth by a 200 with a body, never by "2xx". `/documents`, `/users/current`
  and `/webhooks` answer bad auth with
  `401 {"message":"Unauthenticated API request"}`.
- [x] **`/users/current` answers a valid API key with `403 Access denied`.** It's in
  the docs intro but not in the OpenAPI spec. A 403 (vs. 401) means the signature
  was accepted. `/users/sessioninfo` with a valid key returns the user, the key's
  `oauth2Scopes` and the plan, so it is the auth check after all. The key needs
  OAuth2Read, plus OAuth2Write for plan upload and OAuth2Delete for removing tabs.

Still open:

- [x] **Part `microversionId` is document-wide** (equals the version's microversion).
  Per-part stamp = mass-property fingerprint; element microversion = prefilter.
- [x] STEP: `"unit": "METER"` honoured (`SI_UNIT($,.METRE.)`), `partIds` honoured
  (1 solid), `externaldata` is raw STEP, not a zip. 4 calls per export.
- [x] Wrong secret and 1 h clock skew both give `401 Unauthenticated API request`.
- [x] Loader bugs found on the way (affect 3DX too): OCP 8 import break; STEP
  sized wrong unless loaded as `mm` (OCC works in mm). Fixed 2026-10-16; see
  `ONSHAPE_API_FINDINGS.md`.
- [ ] Blob element size limit
- [ ] App elements usable with API keys?
- [x] **Folder scoping:** `GET /documents?q=<folder name>` never returns folders, so the
  folder is configured by id. `GET /documents?parentId=<id>` (with or without
  `filter=0`) **silently ignores `parentId`**: 200, all of the user's documents.
  Each item carries its own `parentId`, so client-side filtering works at 1 call
  per 20 documents. `GET /globaltreenodes/folder/<id>` (**not in the spec**) lists
  exactly the folder's contents in 1 call, with the same document-summary items.
  Use it, and keep the client-side filter as the fallback.
- [x] `GET /documents` caps `limit` at 20 (`400 must be less than or equal to 20`).
  Paging `next` links omit the API version, so re-insert it.
- [x] Company exists on the Educator plan (`<company name>`), so `companyId`-scoped webhooks
  are possible, even though `sessioninfo.company` is `null`.
- [ ] Does `globaltreenodes/folder` list sub-folders too (test folder has none yet)?
- [ ] Release management and company-scoped webhooks available on the Educator plan
- [ ] Can a blob element be created inside a tab folder?
- [ ] Is remaining quota visible anywhere (API or admin page)?
