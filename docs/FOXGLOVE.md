# Foxglove

[Foxglove](https://foxglove.dev) is the remote front end for the inspection cell: camera feeds,
the robot model, viewpoint-generation results, and panels to drive the EOAT lights, the focus
lens, the part catalog and the planning pipeline. It runs on your own machine and connects to
`foxglove_bridge` on the lab PC, so nothing but the Foxglove desktop app is needed on the
client.

```
Foxglove desktop ──ws://<lab host>:8765──▶ foxglove_bridge (lab container)
                                                 │ ROS 2 (DDS, ROS_DOMAIN_ID from .env)
                                                 ▼
                                lab nodes  +  magpi (end-of-arm Pi) nodes
```

## Connecting

1. Start the cell as usual (`./run.sh`). ViewpointGeneration's `bringup.launch.py` starts the
   bridge on port 8765.
2. In Foxglove, **Open connection → Foxglove WebSocket**, URL `ws://<lab host>:8765`.
   - On the lab LAN, `<lab host>` is the lab PC's hostname or address (`pop-os`).
   - Off campus, join the lab's Tailscale network and use the PC's Tailscale name. magpi is
     not on the tailnet and doesn't need to be: everything it publishes reaches you through the
     lab bridge.
3. Install the panels (below) once per machine.

Both hosts must share a `ROS_DOMAIN_ID` (lab `.env` here, magpi's `.env` in
`inspection-eoat-docker`), or magpi's topics never reach the bridge.

## Bridge configuration

The bridge's parameters are set in ViewpointGeneration's `bringup.launch.py` and are read once
at startup, so restart the bringup (or just the bridge) after changing them.

| Parameter | Value | Why |
|---|---|---|
| `capabilities` | `clientPublish`, `services`, `connectionGraph`, `assets` | `assets` serves meshes referenced by `/robot_description` |
| `client_topic_whitelist` | `/camera_head/led_ring/request`, `/camera_head/lens/request`, `/viewpoint_generation/viz/select` | the only topics clients may publish on |
| `service_whitelist` | `/catalog/{list_backends,list_parts,select_part,sync_now,ensure_plan}`, `/viewpoint_generation/{segment_regions,fov_clustering,viewpoint_projection,optimize_traversal}` | the bridge's default (`.*`) would expose every service, controller switching included |

Add to the whitelists, deliberately, when a new panel needs a topic or service.

## What to look at

### Cameras

| Topic | What | Notes |
|---|---|---|
| `/pi_camera/video/foxglove` | EOAT macro camera, H.264 (`foxglove_msgs/CompressedVideo`), ~1 Mbit/s | **Use this one remotely.** Re-encoded on the lab from magpi's JPEG stream by `foxglove_compressed_video_transport` (installed in `Dockerfile.jazzy`) |
| `/pi_camera/image_raw/compressed` | the same camera as JPEG, ~88 Mbit/s | fine on the lab LAN, far too much over Tailscale |
| `/pi_camera/camera_info` | calibration | |

If `/pi_camera/video/foxglove` goes quiet and `/pi_camera/camera_info` shows an error, the
camera on magpi has stopped delivering frames (a libcamera stall seen on the Pi 5). magpi's
`camera_ros` (the `cacton77/camera_ros` fork) has a watchdog for this, enabled with
`watchdog_timeout` in `inspection_eoat/config/pi_camera_*.yaml`: it restarts the camera, and if
that fails the node exits and launch respawns it. Without the watchdog, restart `camera_node`
on magpi.

### Robot model

Add a **3D** panel, set its display frame to `object_frame` (or `world`), and enable
`/robot_description`. Meshes load through the bridge's `assets` capability.

- Under **Scene**, enable **Ignore COLLADA `<up_axis>`**. The EOAT mesh (`eoat.dae`) is
  authored Y-up. RViz ignores that tag, but Foxglove applies it, which turns the camera head
  sideways.
- Known issue: the Zivid camera and turntable meshes are still mis-oriented in Foxglove (they
  are right in RViz).
- If TF is missing between the arm links (e.g. `object_frame → wrist_3_link`), the
  controllers didn't come up. Check that the `ros2_control` spawners succeeded.

### Viewpoint generation

ViewpointGeneration's `foxglove_viz_node` (started by bringup, launch argument
`foxglove_viz:=true`) publishes the current plan as native Foxglove scene topics, the remote
counterpart of the Open3D GUI. It follows the pipeline's `results.file`, so every stage
redraws as soon as it finishes.

In the 3D panel enable, under `/viewpoint_generation/viz/`:

| Topic | Shows |
|---|---|
| `mesh` | the part, coloured by region (click a region for its metadata) |
| `points` | sampled points, coloured by cluster (also has `region`/`cluster` fields) |
| `blind_spots` | points no viewpoint can see |
| `viewpoints` | camera frusta, coloured by imaging mode: photometric green, standard yellow, inaccessible red |
| `fov`, `labels` | FOV cylinders and region labels (optional) |
| `path` | traversal order, joint path, unreachable viewpoints |
| `selection`, `selection_points` | the region/cluster picked in the Viewpoint Generation panel |

The plan is drawn in `viewpoint_generation/model`, placed from `/tsdf_pose/pose` as the
planning scene places the part (identity if tsdf_pose isn't running). The selected viewpoint
is also a TF frame, `viewpoint_generation/selected_viewpoint`.

To look at a saved plan instead of the live one:

```bash
./connect.sh ros2 param set /viewpoint_generation_viz results_file /path/to/plan.json
./connect.sh ros2 param set /viewpoint_generation_viz results_file ''   # follow the pipeline again
```

ViewpointGeneration's README ("Foxglove visualization") lists the node's parameters.

## Panels (EOAT Controls extension)

The extension source is in [`foxglove/eoat-controls/`](../foxglove/eoat-controls/). Build and
install it on each machine that runs Foxglove (needs Node.js 18+):

```bash
cd foxglove/eoat-controls
npm install
npm run local-install    # installs into the desktop app; restart Foxglove afterwards
npm run package          # or build a .foxe to drag onto the app / share
```

Then **Add panel** and pick one of:

| Panel | Does | Talks to |
|---|---|---|
| **EOAT Lighting** | LED ring: solid, per-ring and Gaussian-spot modes, with a live ring preview | `lens_tuner` on magpi, via `/camera_head/led_ring/request` |
| **EOAT Focus** | focus lens: hold-to-move, step jog, go-to, range calibration | `lens_tuner` on magpi, via `/camera_head/lens/request` |
| **PLM Catalog** | browse, select and sync parts; thumbnails from the web picker | plm_bridge's `/catalog/*` services |
| **Viewpoint Generation** | plan summary, run each pipeline stage, step through regions and clusters | `/viewpoint_generation/*` services and `foxglove_viz_node` |

A layout that works well: a 3D panel with the viewpoint-generation topics and the robot model,
an Image panel on `/pi_camera/video/foxglove`, and the four panels beside them.

Every panel sends requests to a node that owns the hardware or the pipeline (`lens_tuner`,
plm_bridge, ViewpointGeneration) rather than commanding anything directly, and the hold-to-move
lens controls stop on their own if the connection drops. The panels' details are in the
extension's [README](../foxglove/eoat-controls/README.md).

The EOAT state topics use `ps_interfaces` messages, so `Inspection_EOAT_ROS2_Driver` must be
built in `ros2_ws` (it is in `shared.repos`) for the bridge to decode them.

## Troubleshooting

| Symptom | Check |
|---|---|
| Can't connect | bringup running? `./connect.sh ros2 node list \| grep foxglove_bridge`. Off campus: Tailscale up and signed in (Tailscale SSH can ask you to re-authenticate in the browser) |
| No magpi topics at all | `ROS_DOMAIN_ID` matches on both hosts; magpi's `inspection-eoat-docker` service running |
| No macro camera image | see [Cameras](#cameras) above |
| A panel's buttons do nothing or report a missing service | the topic or service isn't in the bridge whitelist, the bridge was started before the whitelist changed, or the node behind it (`lens_tuner`, plm_bridge, ViewpointGeneration) isn't running |
| Robot meshes missing or rotated | `assets` capability enabled; **Ignore COLLADA `<up_axis>`** set |
| Viewpoint panel says "mesh was tessellated differently" | the plan was made with older STEP tessellation settings than the pipeline's current ones; regenerate it |
