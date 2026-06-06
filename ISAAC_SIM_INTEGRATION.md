# Isaac Sim 5.0 Integration Plan

Integrate NVIDIA Isaac Sim 5.0 into the inspection-docker stack as a simulation
backend for the inspection cell (UR5e + turntable), driven over the ROS 2 bridge.

**Status:** planning · **Target Isaac Sim:** 5.0.0 · **ROS distro:** Jazzy (Ubuntu 24.04)

---

## 1. Goal & scope

Run Isaac Sim as a high-fidelity physics + rendering backend that the *existing*
Jazzy stack drives exactly like the real cell — MoveIt planning, `moveit_servo`
jogging, and the ViewpointGeneration pipeline all unchanged. Isaac replaces the
robot/sensors; it does **not** replace `controller_manager`, MoveIt, or servo.

Out of scope (for now): Isaac Lab / RL training, multi-robot, cloud streaming.

### Integration architecture (decided)

```
  ┌─────────────────────────────┐         DDS (FastRTPS,            ┌──────────────────────────┐
  │  inspection-docker (Jazzy)  │         ROS_DOMAIN_ID=2)          │  isaac-sim container     │
  │  Python 3.12                │ <───────────────────────────────>│  bundled Jazzy, Py 3.11  │
  │                             │                                   │                          │
  │  controller_manager         │  /isaac_joint_commands  ───────►  │  OmniGraph ROS2 bridge   │
  │   └ topic_based_ros2_control│  /isaac_joint_states    ◄───────  │   ├ Articulation (UR+TT) │
  │  MoveIt / servo / RViz      │  /clock                 ◄───────  │   ├ sim RealSense (RGB-D)│
  │  ViewpointGeneration        │  /camera/* (depth,rgb,info) ◄──   │   └ PhysX + RTX render   │
  └─────────────────────────────┘                                   └──────────────────────────┘
```

- Isaac uses its **bundled Jazzy** libs (do NOT source system Jazzy inside the
  Isaac container — it is Python 3.11 only; our stack is 3.12). DDS bridges them.
- RMW on both sides is `rmw_fastrtps_cpp` (already set in `.env`). Same
  `ROS_DOMAIN_ID=2`, `network_mode: host`.
- The robot moves in Isaac because `controller_manager` (our side) runs a
  `topic_based_ros2_control/TopicBasedSystem` plugin that publishes joint
  commands and subscribes to joint states — Isaac's bridge mirrors those topics.

---

## 2. Prerequisites / facts (verified 2026-06-05)

- GPU: RTX 4000 Ada (RT cores ✓), 20 GB VRAM, driver 580.126.18 — meets Isaac 5.0 reqs.
- Docker GPU passthrough already works via compose `deploy.resources` + nvidia-container-toolkit.
- Isaac Sim 5.0 supports ROS 2 Jazzy natively and ships bundled Jazzy libs (Py 3.11).
- `inspection_cell.ros2_control.xacro` already switches backends via xacro params
  (`sim_gazebo` / `sim_ignition` / `use_fake_hardware` / real UR) — Isaac slots in
  as one more branch.
- Two separate `<ros2_control>` systems: `UR5eSystem` and `TurntableSystem`.
  Both need an Isaac branch.

**Open items to confirm before Phase 2:**
- [ ] `ros-jazzy-topic-based-ros2-control` available via apt (else build from source).
- [ ] Isaac Sim 5.0 image pull access (`nvcr.io/nvidia/isaac-sim:5.0.0`) — NGC API key.
- [ ] Headless + WebRTC streaming vs. X11 (recommend WebRTC; X11 GUI fwd is painful).

---

## 3. Phased plan

### Phase 0 — Decide & verify (½ day)
1. Confirm the three open items above.
2. Confirm NGC login works and the image pulls.
3. Decide topic naming convention (`/isaac_joint_states`, `/isaac_joint_commands`).

**Exit:** image pulls; `topic_based_ros2_control` install path known.

### Phase 1 — Isaac container stands up & streams (½–1 day)
1. Add an `isaac-sim` service to `docker-compose.yaml` (new profile `isaac`):
   - image `nvcr.io/nvidia/isaac-sim:5.0.0`, `network_mode: host`, `ipc: host`,
     same `NVIDIA_*` env as `linux-gpu`, GPU `deploy.resources` block.
   - Mount cache volumes (`~/docker/isaac-sim/cache/*`) to avoid shader recompiles.
   - Mount `./models` and a new `./isaac` (USD scenes) read/write.
   - **Do not** mount/source the ROS overlay into this container.
   - Run headless with WebRTC livestream enabled.
2. Launch Isaac headless, connect via WebRTC client, load a default stage.

**Exit:** Isaac runs in-container on the GPU; you can view it via WebRTC.

### Phase 2 — ROS 2 bridge handshake (½–1 day)
1. Enable the `isaacsim.ros2.bridge` extension; confirm it loads bundled Jazzy.
2. In a trivial stage, add an OmniGraph that publishes `/clock` and a test topic.
3. From the Jazzy container, `ros2 topic list` / `echo` — confirm cross-container
   DDS discovery on domain 2 with FastRTPS.

**Exit:** topics published by Isaac are visible & echoable from the Jazzy stack.

### Phase 3 — Cell USD asset (1–3 days)
1. Convert the cell description to USD:
   - URDF → USD via Isaac's URDF importer, starting from
     `inspection_cell_<cell>.urdf.xacro` (expand xacro to plain URDF first).
   - Bring in meshes from `assets/` / `models/`. Fix joint axes, limits, materials.
2. Add an articulation controller + joint-state publisher OmniGraph:
   - subscribe `/isaac_joint_commands` (position), publish `/isaac_joint_states`
     for all 7 joints (6 UR + `turntable_disc_joint`).
3. Set realistic joint drive gains/limits to match the real UR + turntable.

**Exit:** in Isaac, commanding `/isaac_joint_commands` moves the robot and
`/isaac_joint_states` reflects it.

### Phase 4 — Wire Isaac as a ros2_control backend (2–4 days, core work)
1. Add an Isaac branch to `inspection_cell.ros2_control.xacro` for BOTH systems:
   - New xacro param `sim_isaac:=false`.
   - `UR5eSystem` / `TurntableSystem` hardware → `topic_based_ros2_control/TopicBasedSystem`
     when `sim_isaac`, with params:
     - `joint_commands_topic: /isaac_joint_commands`
     - `joint_states_topic: /isaac_joint_states`
   - Guard the UR `<sensor>`/`<gpio>` blocks so they're excluded under `sim_isaac`
     (currently excluded only for gazebo/ignition — extend the `xacro:unless`).
2. New launch file `test_isaac.launch.py` (clone of `test_sim.launch.py`):
   - pass `sim_isaac:=true`, start `controller_manager` + `robot_state_publisher`
     + spawners (`joint_state_broadcaster`, `inspection_cell_controller`), RViz.
   - **No** `gazebo_ros2_control` / mock — Isaac provides the physics.
3. Reuse existing `config/ros2_controllers.yaml` unchanged.

**Exit:** `ros2 control list_hardware_interfaces` shows the topic-based system;
`joint_state_broadcaster` + `inspection_cell_controller` activate; commanding the
trajectory controller moves the robot in Isaac and RViz tracks it.

### Phase 5 — MoveIt + servo against Isaac (1–2 days)
1. Point the existing MoveIt config / servo launch at the Isaac-backed controllers.
2. Validate: MoveIt plan+execute reaches goals in Isaac; `moveit_servo` jogging is
   smooth (watch for the CachedKDL seed issue noted in memory — use plain KDL).
3. Sanity-check `/clock` use (`use_sim_time:=true`) end to end so timestamps agree.

**Exit:** plan/execute and servo jog work against Isaac as they do on hardware.

### Phase 6 — Simulated RealSense → ViewpointGeneration (2–5 days, optional/stretch)
1. Add an Isaac RGB-D camera at the EOAT (match `inspection_eoat` extrinsics).
2. Publish `/camera/depth`, `/camera/color`, `camera_info` matching the real
   RealSense topic names/frames consumed by `ViewpointGeneration`.
3. Validate the viewpoint/PartField pipeline runs on synthetic data.

**Exit:** ViewpointGeneration produces viewpoints from Isaac camera output.

---

## 4. Effort summary

| Phase | Effort | Risk |
|------|--------|------|
| 0 Verify | ½ d | low |
| 1 Container + stream | ½–1 d | low |
| 2 Bridge handshake | ½–1 d | low (distro risk removed by Jazzy support) |
| 3 Cell USD asset | 1–3 d | med (URDF→USD fidelity) |
| 4 ros2_control backend | 2–4 d | med (**core work**) |
| 5 MoveIt + servo | 1–2 d | low–med |
| 6 Sim camera (stretch) | 2–5 d | med |

**Minimal "robot moving, MoveIt planning in Isaac" milestone:** Phases 0–5 core,
roughly **1 week** of focused work. Faithful twin incl. sensors: 2–3 weeks.

---

## 5. Key risks & mitigations

- **Py 3.11 vs 3.12:** never source system Jazzy in the Isaac container; bridge
  over DDS only. Any custom pkg needed *inside* Isaac must be built for 3.11.
- **DDS discovery across containers:** both on `network_mode: host`, domain 2,
  FastRTPS — verify early (Phase 2) before investing in assets.
- **URDF→USD fidelity:** joint axes/limits/inertia drift; validate joint motion
  against `mock_components` behavior before trusting dynamics.
- **`topic_based_ros2_control` availability:** if no apt package for Jazzy, build
  from source into the overlay — confirm in Phase 0.
- **GPU contention:** Isaac + PartField/Torch share the 20 GB GPU; watch VRAM.

---

## 6. Files expected to change / be added

- `docker-compose.yaml` — new `isaac-sim` service + `isaac` profile, cache volumes.
- `.env` — optional `COMPOSE_PROFILE` toggle for Isaac.
- `isaac/` (new) — USD scenes, OmniGraph setup scripts, import helpers.
- `src/Inspection_Cell/inspection_cell_description/urdf/inspection_cell.ros2_control.xacro`
  — add `sim_isaac` branch to `UR5eSystem` + `TurntableSystem`; guard sensors/gpio.
- `src/Inspection_Cell/inspection_cell_description/launch/test_isaac.launch.py` (new).
- `docker/overlay_packages.jazzy.txt` — add `ros-jazzy-topic-based-ros2-control`
  (if apt-available).
