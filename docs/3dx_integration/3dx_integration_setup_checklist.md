# Setup checklist — what to provide the agent

## Files to place in the repo before starting

### 1. Design documents

Copy these three files into a `docs/` directory at the repo root:

```
ViewpointGeneration/
└── docs/
    ├── 3dx_catalog_integration_plan.md
    ├── 3dx_plan_sync_addendum.md
    └── 3dx_step_ingest_addendum.md
```

### 2. Agent prompt

Copy `3dx_integration_agent_prompt.md` into the repo root as the working
instructions. You can either:

- Append its contents to the existing `CLAUDE.md`, or
- Pass it as the initial prompt when starting the Claude Code session, or
- Place it as `docs/AGENT_INSTRUCTIONS.md` and tell the agent to read it first

### 3. Environment variables

The `inspection-docker` repo already has a `.env` file with ROS configuration.
3DX credentials are added to this same file (see section 6c below).

The container paths for the catalog are:

```bash
# These are the paths INSIDE the container (not on the host)
CATALOG_DB_PATH=/workspaces/shared_ws/catalog/catalog.db
CATALOG_STEP_DIR=/workspaces/shared_ws/catalog/steps
CATALOG_THUMB_DIR=/workspaces/shared_ws/catalog/thumbnails
CATALOG_PLAN_DIR=/workspaces/shared_ws/catalog/plans
CATALOG_RESULT_DIR=/workspaces/shared_ws/catalog/results
```

**Finding your SecurityContext string:** This is the trickiest configuration
value. The SecurityContext header is a triplet in the format
`Role.Organization.CollabSpace` that determines what data your API calls
can access and what operations they can perform. Getting it wrong results
in 403 errors or empty search results.

**Understanding the components:**

The SecurityContext has three parts separated by dots:

- **Role** — your access level. On One Click tenants (most cloud/EDU
  deployments), these are the 7 VPLM roles:

  | Display name   | Internal name (use this)     |
  |----------------|------------------------------|
  | Reader         | `VPLMViewer`                 |
  | Contributor    | `VPLMExperimenter`           |
  | Author         | `VPLMCreator`                |
  | Leader         | `VPLMProjectLeader`          |
  | Owner          | `VPLMProjectAdministrator`   |
  | Administrator  | `VPLMAdmin`                  |
  | Public Reader  | `VPLMSecuredCrossAccess`     |

  Use the **internal name** in the header, not the display name.
  For creating documents and attaching relationships, you need at
  minimum `VPLMCreator`; `VPLMProjectLeader` is safer. Note that
  `VPLMProjectAdministrator` cannot be used with certain API calls
  per the SAP integration documentation.

  On CSE (Customer Specific Environment) tenants, roles are
  application-specific (e.g. `Design Engineer`, `Project User`).
  Check with your admin which mode your tenant uses — mixing
  One Click and CSE roles on the same user is unsupported.

- **Organization** — your company/org name as defined in P&O.
  This is the organization business object name, not necessarily
  your company's legal name. On EDU tenants it's often the
  university name or a short identifier.

- **CollabSpace** — the Collaborative Space containing the data
  you want to access. Objects in 3DX belong to exactly one
  primary Collaborative Space. Your API calls will only see
  objects in the space specified in the SecurityContext header.
  Common names: `Common Space`, `Default`, or project-specific
  names.

**How to find your exact values:**

*Method 1 — From the 3DX UI (recommended):*

1. Log in to your 3DEXPERIENCE dashboard
2. Click your avatar/user icon in the top-right corner
3. Look for "Security Context" or "Credentials" in the dropdown.
   The active context is shown as `Role.Organization.CollabSpace`
4. If you have multiple security contexts, they're all listed here.
   Pick the one whose Collaborative Space contains your inspection
   parts

*Method 2 — From browser DevTools:*

1. Log in to 3DX and open a 3DSpace application (e.g. Engineering
   BOM, Content Editor)
2. Open browser DevTools → Network tab
3. Filter for "SecurityContext" or look at any request to
   `/resources/v1/modeler/`
4. The `SecurityContext` header value in those requests is your
   exact string

*Method 3 — Programmatically via the API:*

After CAS authentication, call:

```
GET {3DSpace_URL}/resources/v1/application/e6w/api/v1/e6wCurrentUser
```

This returns the current user's available security contexts as a
list of `Role.Organization.CollabSpace` triplets. The agent's
`client.py` should implement this as a `get_security_contexts()`
method so the user can discover their available contexts without
manual lookup.

*Method 4 — From EKL (if you have CATIA access):*

```
let ctx (String)
ctx = GetSystemInfo("securitycontext")
// Returns e.g. "ctx::VPLMProjectLeader.UW.Common Space"
```

**Example values:**

```
VPLMProjectLeader.UW.Common Space
VPLMCreator.My Company.Engineering Space
VPLMProjectLeader.ACME Corp.Default
```

**Spaces in names:** Collaborative Space and Organization names can
contain spaces. The entire triplet is passed as a single header value.
Some tenants may require URL-encoding of spaces as `%20` in the header;
others accept literal spaces. If you get 403 errors, try both encodings.

**Finding your tenant URLs:** Log in to your 3DEXPERIENCE dashboard. The
passport URL is the domain you authenticate against (visible in the browser
URL during login). The space URL is the 3DSpace application URL (check the
3DSpace widget URL in the dashboard).

### 4. Test STEP file

Place at least one STEP file in the data directory so Phase 1.5 can test
without needing a live 3DX connection:

```
data/
└── test_parts/
    └── bracket.stp    # any STEP AP203/AP214/AP242 file
```

A simple part from your existing SolidWorks work will do — export one of
the macro-PS rig components or a test coupon as STEP.

### 5. 3DX bookmark setup

Before Phase 1 can sync, create a bookmark folder in 3DX:

1. Open the Bookmark Editor in the 3DDashboard
2. Create a new folder called "Inspection Parts" (or whatever you set
   in `DX_BOOKMARK_SCOPE`)
3. Drag a few Engineering Items into the folder
4. Ensure those items have STEP derived outputs (check under Derived
   Outputs in the item's properties — if missing, ask Chris about
   configuring the derived output rules for the tenant)

### 6. Docker compose and dependency updates (in `inspection-docker`)

The `inspection-docker` repo manages the Docker image and container
orchestration. You need to make two kinds of changes there:

#### a. Add the catalog volume mount

Edit `docker-compose.yaml` in `inspection-docker`. Add the catalog volume
to the `x-common-volumes` anchor:

```yaml
x-common-volumes: &common-volumes
  - /tmp/.X11-unix:/tmp/.X11-unix:rw
  - /tmp/.docker.xauth:/tmp/.docker.xauth:rw
  - ./docker/entrypoint.sh:/entrypoint.sh:ro
  - ./src:/workspaces/shared_ws/src:rw
  - ./data:/data:rw
  - ./models:/models:rw
  - ./config:/config:rw
  - ./catalog:/workspaces/shared_ws/catalog:rw    # ADD THIS
  - /dev:/dev
  - /tmp/runtime-${USERNAME:-macs}:/tmp/runtime-${USERNAME:-macs}:rw
```

Add 3DX environment variables to `x-common-env`:

```yaml
x-common-env: &common-env
  # ... existing vars ...
  # 3DX integration (loaded from .env)
  DX_PASSPORT_URL: ${DX_PASSPORT_URL:-}
  DX_SPACE_URL: ${DX_SPACE_URL:-}
  DX_TENANT: ${DX_TENANT:-}
  DX_USERNAME: ${DX_USERNAME:-}
  DX_PASSWORD: ${DX_PASSWORD:-}
  DX_SECURITY_CONTEXT: ${DX_SECURITY_CONTEXT:-}
  DX_BOOKMARK_SCOPE: ${DX_BOOKMARK_SCOPE:-}
  CATALOG_SYNC_INTERVAL: ${CATALOG_SYNC_INTERVAL:-300}
  PICKER_PORT: ${PICKER_PORT:-5050}
```

Create the `catalog/` directory on the host:

```bash
cd inspection-docker
mkdir -p catalog/{steps,thumbnails,plans,results}
```

#### b. Add new Python dependencies

Edit `docker/requirements.txt` in `inspection-docker` to add the new packages.
This file is already pip-installed at image build time by the Dockerfile.

Add at the end of the file:

```
# 3DX catalog integration
cadquery-ocp>=7.7.2     # Phase 1.5 — PythonOCC STEP loading
flask>=3.0              # Phase 3 — Part picker UI
stomp.py>=8.0           # Phase 5 — JMS event listener (can be deferred)
```

Then rebuild the image:

```bash
./install.sh
```

If `cadquery-ocp` fails during the Docker build (wheel availability varies),
add it as a separate `RUN` line in `docker/Dockerfile.jazzy` instead:

```dockerfile
# After the requirements.txt install block:
RUN conda install -c conda-forge cadquery-ocp -y || \
    pip install cadquery-ocp --break-system-packages
```

For development before rebuilding the image, install interactively:

```bash
./connect.sh
pip install cadquery-ocp flask --break-system-packages
```

#### c. Add 3DX credentials to `.env`

The existing `.env` in `inspection-docker` contains ROS config. Add the
3DX variables alongside the existing ones:

```bash
# Existing vars (don't modify)
CONTAINER_NAME=inspection-docker
ROS_DOMAIN_ID=9
ROS_DISTRO=jazzy
# ...

# 3DEXPERIENCE integration (add these)
DX_PASSPORT_URL=https://r1132100093385-eu1-academia.iam.3dexperience.3ds.com
DX_SPACE_URL=https://r1132100093385-usw2-academia-space.3dexperience.3ds.com/enovia
DX_TENANT=R1132100093385
DX_USERNAME=colin.acton
DX_PASSWORD=<your-password>
DX_SECURITY_CONTEXT=ctx::VPLMProjectLeader.Company Name.Colin Acton Space
CATALOG_SYNC_INTERVAL=300
PICKER_PORT=5050
```

**Split-region topology:** This tenant's IAM (passport) is in `eu1`
while the data services (3DSpace) are in `usw2`. This is normal for
EDU tenants. The CAS login flow authenticates against the `eu1`
passport, and the resulting session cookies are then used against the
`usw2` space. The Python `requests.Session` handles cross-domain
cookies automatically as long as both domains are under
`.3dexperience.3ds.com`.

**The `ctx::` prefix:** The SecurityContext value must include the
`ctx::` prefix — the full string is `ctx::Role.Org.CollabSpace`.
When URL-encoded (as in query parameters), this becomes
`ctx%3A%3AVPLMProjectLeader.Company%20Name.Colin%20Acton%20Space`.
When passed as an HTTP header value, use the unencoded form.

**The tenant ID:** The `DX_TENANT` value is the platform tenant
identifier (e.g. `R1132100093385`), not a human-readable name.
You can find it in the URL of any 3DX request via browser DevTools
(look for `tenant=` in query parameters). Cloud 3DX deployments
require this parameter on most API calls.

**Note:** The `.env` file is already committed in `inspection-docker`
(for the ROS config). The 3DX password should NOT be committed. Consider
splitting into `.env` (committed, non-secret) and `.env.local` (gitignored,
secrets) and referencing both in docker-compose via `env_file:`.

## Starting the agent session

### Recommended launch command

```bash
claude --model claude-opus-4-6 \
  --instructions docs/AGENT_INSTRUCTIONS.md
```

Or if appending to CLAUDE.md, just launch normally from the repo root.

### Initial prompt

If not using `--instructions`, start with:

```
Read the design documents in docs/ (3dx_catalog_integration_plan.md,
3dx_plan_sync_addendum.md, 3dx_step_ingest_addendum.md) and the agent
instructions in docs/AGENT_INSTRUCTIONS.md. Then begin Phase 1.
```

### Phase-by-phase progression

After each phase completes, review the work, test it, then tell the agent:

```
Phase 1 looks good. Proceed to Phase 1.5.
```

If you need corrections:

```
In catalog/client.py, the CSRF token endpoint is returning 403. The
SecurityContext header format might be wrong — check whether it needs
URL encoding. Fix and retry.
```

### What to watch for during each phase

**Phase 1:** The CAS authentication is the most likely point of failure.
The exact login flow varies between 3DX tenants (cloud vs. on-premise,
SAML vs. CAS). If the agent can't get auth working from the design doc
description alone, you may need to capture the login flow in browser
DevTools (Network tab) and paste the request/response sequence to the agent.

**Phase 1.5:** The `cadquery-ocp` package is large (~200 MB). Docker image
build time will increase. If the pip install fails in the container, try
`conda install -c conda-forge cadquery-ocp` instead. The OCC API changed
between versions — if import errors occur, the agent should check whether
the installed version uses `OCP.*` or `OCC.*` namespaces.

**Phase 2:** After adding new `.srv`/`.msg` files, the ROS 2 workspace
needs a full rebuild (`colcon build`). The interfaces package must build
before the Python package that imports the generated types.

**Phase 3:** The Flask app runs inside the Docker container. Make sure
port 5050 is forwarded in docker-compose. The picker UI needs to communicate
with the ROS 2 catalog node — the simplest bridge is direct Python function
calls (Flask app imports the catalog sync module directly), not ROS service
calls from Flask (which would require rclpy initialization in the Flask
process).

**Phase 4:** The FCS upload flow is the hardest part to get right.
If the agent gets stuck, the 3DSwym community's Postman Primer collection
has working examples. You may need to download it and provide the relevant
Postman request/response pairs to the agent.

**Phase 5:** Requires EIF or broker infrastructure you likely don't have
yet. The agent should implement the listener code and test with a mock
STOMP server (e.g., `stompest` or `stomp.py` with a local ActiveMQ Docker
container). Production testing happens later when Chris helps configure
the EIF connector.

## Postman collection (optional but helpful)

If you can obtain the 3DSwym "3DEXPERIENCE Postman Primer" collection:

1. Download the Postman collection JSON and environment JSON
2. Place them in `docs/postman/`
3. Tell the agent: "There are Postman collection files in docs/postman/
   that show working 3DX API request/response examples. Reference them
   for exact endpoint paths and header requirements."

This significantly de-risks Phase 1 and Phase 4.
