# Physical-bringup changes — TF placement, virtual joint, and real-time control

_Date: 2026-07-20_

This note documents a set of interrelated changes made while bringing the
inspection cell up on physical hardware. They fall into four themes:

1. TSDF pose node samples its reference cloud from the mesh (no separate point cloud).
2. Part placement is decoupled from mesh geometry and carried by TF.
3. The `root_to_object` MoveIt virtual joint was removed.
4. Real-time control + CPU/memory contention mitigations, plus prep for a
   dedicated real-time control host.

Each section lists the problem, what changed, the files touched, and usage/notes.

---

## 1. TSDF reference cloud sampled from the mesh

**Problem.** The viewpoint generation node was changed to no longer sample a
whole-part point cloud (segmentation now runs on the mesh). `tsdf_pose_node` used
to load that point cloud (`model.point_cloud.file`) as its ICP/FPFH reference, so
registration lost its reference and never ran.

**Change.** `tsdf_pose_node` now tracks only `model.mesh.*` from
viewpoint_generation and samples its reference cloud directly from the CAD mesh it
already loads (Poisson-disk, matching how the whole-part cloud was generated
upstream).

- New parameter `reference_sample_points` (default `50000`).
- `_load_mesh()` calls the new `_sample_reference_from_mesh()`; `_load_reference()`
  and the `model.point_cloud.*` polling were removed.

**Files**
- `src/Inspection_Control/inspection_control/inspection_control/nodes/tsdf_pose_node.py`
- `src/Inspection_Control/inspection_control/config/tsdf_pose.yaml`

---

## 2. Part placement decoupled from mesh geometry (TF-based)

**Problem.** The live `tsdf_pose` estimate was fed into `model.pose.*` params and
**baked into the mesh vertices** (`set_model_pose` → `_rebuild_mesh`), which also
reset `results_file = None` on every message. Because `tsdf_pose` publishes
continuously, this saved a fresh timestamped `/tmp/<...>.json` ~1 Hz; the GUI and
`task_planning` reloaded on every change → constant results-file churn.

**Design.** The mesh origin is never moved. Mesh, regions, and viewpoints are
generated and stored in the **mesh-origin frame** (`model_frame`). The live pose is
**placement only**, carried by TF: `tsdf_pose` broadcasts `object_frame → model_frame`
(turntable-correct). Three consumers apply that placement — the planning-scene
collision object pose, the GUI display, and the occlusion raycasting scene — but it
is never baked into geometry or written to a results file.

**Key changes**
- **Core (`viewpoint_generation.py`)**: removed `set_model_pose`,
  `_retransform_results`, `model_pose`, `DEFAULT_MODEL_POSE`. `_rebuild_mesh` keeps
  the mesh in its origin frame and resets results only on a mesh identity (file/units)
  change. Added `set_placement(T_object_from_model)` + `_rebuild_raycasting_scene()`:
  the ground-plane occluder is transformed by `inverse(placement)` into the origin
  frame so occlusion reflects the part's current pose while viewpoints stay
  origin-frame.
- **VG node (`viewpoint_generation_node.py`)**: removed all `model.pose.*`
  params/helpers/callbacks. `_filtered_pose_cb` only stores the placement and calls
  `set_placement` (no results writes). `update_planning_scene` attaches the
  origin-frame collision mesh at the live placement pose.
- **tsdf_pose node**: `_publish_pose` now publishes in `fusion_frame` and broadcasts
  **`object_frame → model_frame`** (was `world → model_frame`).
- **GUI**: `gui_node.ROSThread` gained a `tf2_ros` listener + `get_model_placement()`
  (looks up `object_frame → model_frame`); `gui.update_scene` applies it each tick via
  the new `Visualizer.apply_model_placement` (maps the metres/origin-frame transform
  into the visualizer's mm + −90° display frame, per-geometry
  `set_geometry_transform`). The visualizer no longer bakes a pose into the reloaded
  mesh.
- **Downstream**: viewpoint goals in `task_planning_node` and `viewpoint_traversal_node`
  are stamped `model_frame` so MoveIt resolves them via TF.

**Files**
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/viewpoint_generation.py`
- `src/ViewpointGeneration/viewpoint_generation/nodes/viewpoint_generation_node.py`
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/visualizer.py`
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/gui_node.py`
- `src/ViewpointGeneration/viewpoint_generation/nodes/gui.py`
- `src/ViewpointGeneration/viewpoint_generation/nodes/task_planning_node.py`
- `src/ViewpointGeneration/viewpoint_generation/nodes/viewpoint_traversal_node.py`
- `src/Inspection_Control/inspection_control/inspection_control/nodes/tsdf_pose_node.py`
- `src/ViewpointGeneration/viewpoint_generation/package.xml` (added `tf2_ros`)
- `src/ViewpointGeneration/README.md`

**Known limitation / follow-up.** The VRP/IK path (`vrp_solver.precompute_ik`,
`optimize_traversal`) consumes viewpoint dicts as frameless `Pose`s fed to
`set_from_ik`, which assumes the planning frame. It does **not** yet compose the live
placement, so optimize/IK effectively treats the placement as identity. Correct
handling needs the placement composed into each viewpoint pose (and dropping
placement-dependent `joint_trajectory`). Also, `model_frame` only exists while
`tsdf_pose` is broadcasting; with tsdf off, MoveIt goals stamped `model_frame` can't
resolve (GUI falls back to identity, which is fine). A static identity
`object_frame → model_frame` fallback would cover tsdf-off operation.

---

## 3. Removed the `root_to_object` MoveIt virtual joint

**Problem.** A "Phase B spike" had added a floating virtual joint
`root_to_object` (`parent_frame="root"`, `child_link="object_frame"`) to funnel the
old parameter-based pose method. Nothing ever published `root → object_frame`, so
MoveIt's `CurrentStateMonitor` never completed the robot state
(`Missing root_to_object`), which stalled `move_group` and `servo`.

**Change.** Removed the virtual joint (and its comment) from both SRDF files.
`object_frame` is the MoveIt URDF's root link, so with no virtual joint MoveIt uses
it as the fixed model/planning frame and completes state from `/joint_states` alone.
`root` was an abstract, non-URDF frame with no other consumers (RViz fixed frame is
already `object_frame`; servo uses the `ur5e` group about the ee frame).

**Files**
- `src/Inspection_Cell/inspection_cell_moveit_config/config/inspection_cell.srdf`
- `src/Inspection_Cell/inspection_cell_moveit_config/config/inspection_cell.srdf.xacro`

---

## 4. Real-time control + CPU/memory contention mitigations

**Problem.** Once MoveIt state completed (section 3), `move_group`/`servo` became
active and the box saturated: all 24 cores at ~100%, load ~40, RAM 12.9/15.1 GB with
~7 GB swap. The hog was a ~12-process torch + sklearn/loky worker pool from
`viewpoint_generation` (PartField segmentation + KMeans FOV clustering). That starved
the 100 Hz `ros2_control` loop (`Update time` 14–44 ms vs a 10 ms budget), which drops
the UR e-Series reverse interface and reconnects in a loop.

### 4a. Real-time scheduling for the control loop

`ros2_control_node` now takes controller_manager RT parameters (parameterized launch
args, safe defaults; degrade to a warning without `CAP_SYS_NICE`/`CAP_IPC_LOCK` — the
container is `privileged`):

- `control_lock_memory` (default `true`) → `mlockall()`; prevents page-fault/swap
  stalls (the direct cause of the multi-ms overruns).
- `control_thread_priority` (default `80`) → `SCHED_FIFO` on the update loop.
- `control_cpu_affinity` (default `-1` = unpinned) → pin to a core (use an `isolcpus`
  core on a dedicated RT host).

**File**: `src/Inspection_Cell/inspection_cell_description/launch/inspection_cell_control.launch.py`

### 4b. Cap the perception compute

`viewpoint_generation.launch.py` gained `compute_threads` (default `6`), applied to
the node via `OMP_/MKL_/OPENBLAS_/NUMEXPR_NUM_THREADS` and `LOKY_MAX_CPU_COUNT`, so the
segmentation/clustering job leaves cores + RAM for the control loop.

**File**: `src/ViewpointGeneration/viewpoint_generation/launch/viewpoint_generation.launch.py`

### 4c. Prep for a dedicated real-time control host

The control layer (`inspection_cell_control.launch.py`) is standalone and can run on a
separate PREEMPT_RT machine. A `launch_control` toggle (default `true`) was added so
the workstation can run MoveIt + perception **without** starting a local
`ros2_control` when control lives on the RT box.

**Files**
- `src/Inspection_Cell/inspection_cell_moveit_config/launch/inspection_cell.launch.py`
  (`launch_control` gates the control include)
- `src/ViewpointGeneration/viewpoint_generation/launch/bringup.launch.py`
  (forwards `launch_control` and `compute_threads`)
- `src/ViewpointGeneration/README.md`

### Usage

Shared box (defaults apply the RT + swap-lock fixes; cap perception):

```bash
ros2 launch viewpoint_generation bringup.launch.py cell:=beta object:=my_part compute_threads:=4
```

Dedicated RT host — on the RT box:

```bash
ros2 launch inspection_cell_description inspection_cell_control.launch.py \
    cell:=beta launch_rviz:=false control_cpu_affinity:=2 control_thread_priority:=90
```

…and on the workstation:

```bash
ros2 launch viewpoint_generation bringup.launch.py cell:=beta object:=my_part launch_control:=false
```

---

## Rebuild & verify

```bash
colcon build --packages-select \
    inspection_control viewpoint_generation \
    inspection_cell_description inspection_cell_moveit_config
```

- **Results churn gone**: no new `/tmp/<timestamp>.json` per `tsdf_pose` tick (only on
  segment/cluster/project).
- **Placement**: GUI mesh, planning-scene collision object, and viewpoints follow the
  live pose; saved-JSON viewpoint coords stay constant as the pose changes.
- **MoveIt state**: `Missing root_to_object` warning gone; `move_group`/`servo` run.
- **Real-time**: `htop` shows cores no longer uniformly pinned and swap not growing;
  `chrt -p $(pgrep -f ros2_control_node)` shows `SCHED_FIFO`; controller-manager overrun
  warnings stop.

## 5. Developer environment: X11 GUI + headless option

**Problem.** On a fresh host the Open3D GUI (`gui_node`) died with
`Authorization required, but no authorization protocol specified` /
`Failed to open X display`. `docker-compose.yaml` mounts an X auth cookie at
`/tmp/.docker.xauth` and inherits `$DISPLAY`, but nothing created that cookie, so a
machine without a pre-existing `/tmp/.docker.xauth` had no valid X authorization.

**Change.**
- `run.sh` now generates/refreshes `/tmp/.docker.xauth` (wildcard-hostname cookie via
  `xauth`) and runs `xhost +local:root` when `$DISPLAY` is set, before compose `up`. If
  `$DISPLAY` is unset it prints a clear warning pointing at headless mode. (It also
  `touch`es the cookie path so the bind mount can't create a directory there.)
- `bringup.launch.py` now forwards a `headless_mode` argument to
  `viewpoint_generation.launch.py`, so `./run.sh headless_mode:=true` skips the Open3D
  GUI (starting rqt instead) on hosts with no display.

**Files**
- `run.sh`
- `src/ViewpointGeneration/viewpoint_generation/launch/bringup.launch.py`
- `src/ViewpointGeneration/README.md`

**Note.** Only `gui_node` was affected by the X failure; the rest of the stack keeps
running. The `Controller manager service not available` error in a perception-only
launch (`cell:=false`) is expected — no `ros2_control`/`move_group` is running.

---

## 6. Occlusion: pose-independent clustering, environment-aware projection

**Change.** FOV clustering and viewpoint projection now use **separate** occlusion
scenes instead of one shared scene:

- **FOV clustering** → mesh-only `RaycastingScene` (self-occlusion only). Cluster
  feasibility is now pose-independent: it determines which surface a camera could ever
  image, regardless of how the part is placed.
- **Viewpoint projection** → mesh + ground-plane scene, with the ground-plane occluder
  transformed into the part's current placement, so projection respects the actual
  turntable/environment at the current pose.

Open3D's `RaycastingScene` is append-only (no geometry removal), so the ground plane is
toggled by rebuilding the scene with/without it via `_make_raycasting_scene(include_ground=)`.
`_apply_raycasting_scenes()` sets both consumers on mesh load; `set_placement` refreshes
only the projection scene (clustering's is pose-independent).

**Files**
- `src/ViewpointGeneration/viewpoint_generation/viewpoint_generation/viewpoint_generation.py`
- `src/ViewpointGeneration/README.md`

---

## Open items

- Compose the live placement into the VRP/IK path (`vrp_solver.precompute_ik`) — see
  section 2 follow-up.
- Optional static identity `object_frame → model_frame` fallback for tsdf-off operation.
- Full determinism wants a PREEMPT_RT kernel + `isolcpus` (the dedicated-host path).
- The workstation has only 15 GB RAM; size up if PartField/viewpoint-gen is routine so
  it isn't near-swap even with the thread cap.
