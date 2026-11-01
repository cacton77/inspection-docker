# EOAT Controls (Foxglove panels)

Foxglove panels for the inspection cell:

- **EOAT Lighting** and **EOAT Focus** control the macro-ps camera head's LED ring and
  focus-lens stepper on the end-of-arm Pi (magpi). Both send requests to `lens_tuner`
  on magpi rather than driving hardware topics directly.
- **PLM Catalog** is the Foxglove counterpart of plm_bridge's web part picker.
- **Viewpoint Generation** drives the viewpoint-generation pipeline next to a 3D panel,
  the remote alternative to the Open3D GUI.

## EOAT Lighting

The panel publishes JSON requests on `/camera_head/led_ring/request` (`std_msgs/String`).
`lens_tuner` on magpi turns each request into a full ring frame, using the same code as its web
UI's `/api/led` and `/api/spot`. It stays the only publisher of `/camera_head/led_ring/command`;
the panel never sends frames itself.

- **Off**, always visible.
- **Solid**: colour and brightness.
- **Rings**: inner/mid/outer colour, on/off and brightness.
- **Spot**: Gaussian spot x/y/σ (mm) and flux; click the ring preview to place it.
- **Live** sends while you drag (throttled to ~6/s, last value always sent). Untick it to get an
  **Apply** button.

Feedback:

- `/camera_head/led_ring/state` (`ps_interfaces/msg/LedRingState`) drives the ring preview. It's
  what the hardware actually shows, which a joystick override, homing or a capture can change.
- `/camera_head/led_ring/event` (latched JSON) shows the outcome of the last request.

## EOAT Focus

The panel publishes JSON requests on `/camera_head/lens/request` (`std_msgs/String`):
`stop`, `velocity` (hold), `jog` (step-budgeted), `goto` (normalized position) and
`set_min`/`set_max`. `lens_tuner` stays the only publisher of `/camera_head/lens/command`.

- **STOP** cancels any hold, jog or seek.
- **Hold to move**: ◀◀ ◀ ▶ ▶▶ (full / 20% speed). While held, the panel re-sends the
  velocity every 150 ms. `lens_tuner` drops a hold 0.6 s after the last refresh, so a
  closed panel or a dropped connection stops the lens. Releasing the button, or the
  window losing focus, sends a stop right away.
- **Step jog**: ± N steps. `lens_tuner` enforces the budget, capped at 4000.
- **Go to**: seeks to a position in [0, 1]. Needs a calibrated range.
- **Range calibration**: Set MIN (rezeroes) / Set MAX, each with a confirm.

Feedback comes from `/camera_head/lens/state` (`ps_interfaces/msg/LensState`, 20 Hz)
and `/camera_head/lens/event` (latched JSON outcome).

## PLM Catalog

The panel calls plm_bridge's ROS services through the lab bridge:
`/catalog/list_backends`, `list_parts`, `select_part`, `sync_now` and `ensure_plan`.
These are the only services the bridge's `service_whitelist` admits.

- **Browse**: a card grid with search, a maturity filter and archived parts. Cards show
  the geometry state (Ready / Fetch / New / No STP / Archived) and the plan status.
- **Select** fetches the STEP, resolves the plan and publishes `/catalog/part_selected`,
  the same path as the web picker. **Model only** skips the plan.
  **Check plan** runs `ensure_plan`. Double-clicking a card selects it.
- **Sync** / **Full sync** call `sync_now`. Backend connection state comes from
  `list_backends`.
- The **Loaded** strip shows the latched `/catalog/part_selected`.
- **Thumbnails** are not carried over ROS. They load as images from the picker's
  `/thumb/<storage_key>` (default `http://pop-os:5050`, set with ⚙). The key is
  computed the same way as `plm_bridge.core.paths.storage_key()`. When the picker is
  unreachable, the panel works without them.

These stay in the web picker, which has no ROS services for them yet: plan history,
loading an older plan, adopting plan files, uploading plans and run history.

## Viewpoint Generation

Use this panel next to a **3D** panel. The geometry is published by ViewpointGeneration's
`foxglove_viz_node` on `/viewpoint_generation/viz/*` (see that package's README, section
"Foxglove visualization"). In the 3D panel, enable `mesh`, `points`, `viewpoints`, `path`,
`blind_spots`, `selection` and `selection_points`. Optionally also enable `fov` (FOV
cylinders) and `labels`. Set the display frame to `object_frame` or
`viewpoint_generation/model`.

- The summary shows the stage, file, counts, imaging modes (photometric / standard /
  inaccessible) and blind spots, plus any warnings (e.g. a plan made with a different
  tessellation).
- **Segment / FOV cluster / Project / Optimize path** call the
  `/viewpoint_generation/{segment_regions,fov_clustering,viewpoint_projection,optimize_traversal}`
  Trigger services. Each stage is enabled once the previous one exists; a finished stage
  shows ↻ to re-run it.
- **Region / cluster** ◀ ▶, or click a row of the region table, publish
  `{region, cluster}` on `/viewpoint_generation/viz/select`. The viz node outlines the
  region, highlights the cluster's points and viewpoint, and moves the
  `viewpoint_generation/selected_viewpoint` TF frame to the selected camera pose.

## Use

Connect Foxglove (desktop app) to the lab bridge, `ws://<lab host>:8765`, and add the
panels. The bridge (configured in Inspection_System's `inspection_bringup/launch/bringup.launch.py`) is
whitelisted to exactly what these panels need:

- client publishing on `/camera_head/led_ring/request`, `/camera_head/lens/request` and
  `/viewpoint_generation/viz/select`;
- the five `/catalog/*` services and the four viewpoint-generation stage services listed above.

It needs `ps_interfaces` built on the lab to decode the EOAT state topics. See
[`docs/FOXGLOVE.md`](../../docs/FOXGLOVE.md) for the full remote-viewing setup.

## Build / install

Needs Node.js 18+ on the machine running Foxglove.

```sh
cd foxglove/eoat-controls
npm install
npm run local-install   # into ~/.foxglove-studio/extensions (desktop app), then restart Foxglove
npm run package         # .foxe to drag onto the app or share
```

The package name stays `eoat-lighting` (installed as `uwmacs.eoat-lighting`) so existing
installs are upgraded rather than duplicated. Bump `version` in `package.json` with each change.

Ring geometry (16/24/32 px at 52/72/92 mm, index 0 pointing down, counter-clockwise) mirrors
`inspection_eoat/ring_spot.py` and lens_tuner's `ring_clockwise:=false`. If either changes,
update `RINGS` / `RING_CLOCKWISE` in `src/LightingPanel.tsx`.
