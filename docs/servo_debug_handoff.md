# MoveIt Servo Debug Handoff

---
## SESSION 2 UPDATE (2026-06-02) — read this first

A follow-up session reproduced the bug, computed the servo's *own* 6-DOF Jacobian, read
the upstream MoveIt Servo (jazzy) source, and captured a new log
(`data/servo_log_20260602_194650.json`). Net result: **the diagnosis in the original
handoff below is partly superseded.** Summary of what is now known:

### New, hard facts
- **The output is a FIXED command, essentially independent of the commanded twist.**
  Every reproduction produces the *identical* joint-velocity-command direction:
  `j = [~0, ~0, +π, +π, ~0, −π]` → physically **elbow, wrist_1 at +π and wrist_3 at −π**
  (in the group order pan, lift, elbow, w1, w2, w3), with pan/lift/wrist_2 ≈ 0. The robot
  really moves these joints at ±π (confirmed from `joint_states.velocity`). It saturates
  for ~0.2–0.25 s on the first command after an idle period, then `HALT_FOR_SINGULARITY`.
- Because the realized joint motion is the same fixed pattern regardless of the (varying,
  tiny, pure-linear) commanded twist, **this is not twist-tracking at all** — the twist
  arrival merely *triggers* a fixed downstream step.

### What is now RULED OUT (with proof)
1. **Units / dt scaling bug** — upstream `command.cpp` correctly does
   `cartesian_position_delta = command.velocities * publish_period`; output velocity is
   `J⁺·twist`. No 500× units error.
2. **A real singularity** — computed the servo's actual 6-DOF Jacobian
   (`ur_base_link → eoat_camera_link`, UR5e DH) at the reproduced config:
   **σ_min ≈ 0.231, cond ≈ 8** → max IK amplification ≈ 4.3×. The logger's 7-DOF
   `object_frame→camera` Jacobian agrees (σ_min ≈ 0.244). A fixed EOAT tool offset cannot
   create a rank drop. In the new log the status is **`NO_WARNING` during the saturation
   burst** — the Jacobian is genuinely non-singular, yet the output still saturates.
   ⇒ The original handoff's "σ_min ≈ 0.22" reasoning was correct *and* it proves the IK
   cannot be the source.
3. **Stale/zero servo robot state** — set `is_primary_planning_scene_monitor: true`
   (confirmed live: `ros2 param get /servo_node moveit_servo.is_primary_planning_scene_monitor`
   → True). This fixed a *real but separate* latent bug (servo previously computed IK from
   the all-zeros startup scene, where UR5e elbow=0 ∧ wrist_2=0 are exact singularities),
   but **did NOT fix this bug.** The new log shows correct, non-singular state.
4. **The EE-frame twist transform** — with `apply_twist_commands_about_ee_frame: true`,
   `Servo::toPlanningFrame` applies a **rotation only** (no w×r cross term) to the twist.
   A tiny pure-linear `vy` therefore stays tiny and pure-linear into the IK. It cannot
   manufacture the large angular content (~6.5 rad/s) seen in the realized motion.

### Where the bug actually is (narrowed)
The blow-up is **downstream of the IK**, in `Servo::getNextJointState`:
`target_state.velocities = (target_state.positions − current_state.positions) / publish_period`
(then `doSmoothing(target_state)` at the very end). With `publish_period = 0.002`, any
~0.006 rad discrepancy between `target_state.positions` and `current_state.positions`
becomes a ±π velocity. Two concrete candidates remain:

- **(A) Butterworth smoother stale state.** `Servo::resetSmoothing()` exists but is
  **never called inside `servo.cpp`** (only the ROS node layer resets it, on pause/unpause).
  Stale filter state from a long idle period can leak into the first active command.
- **(B) Joint name/order mismatch.** `/joint_states` is published **alphabetically and
  includes the turntable joint**: `[elbow, shoulder_lift, shoulder_pan, turntable_disc,
  wrist_1, wrist_2, wrist_3]`, whereas the `ur5e` group/controller order is
  `[pan, lift, elbow, w1, w2, w3]`. A mis-map between `current_state` and `target_state`
  would produce exactly this kind of fixed, large, *partial* saturation that is
  independent of the commanded twist.

### Decisive A/B test left running
`cell_servo.yaml` now has **`use_smoothing: false`** (diagnostic). Rebuild
(`colcon build --packages-select inspection_cell_moveit_config`), relaunch, reproduce:
- bug **disappears** ⇒ candidate (A), smoother; fix = force smoother reset on idle→active.
- bug **persists** ⇒ candidate (B), the `(target − current)` joint-order path; chase the
  `/joint_states` (alphabetical + turntable) → group-order mapping.

### Config changed this session (in `git`)
- `inspection_cell_moveit_config/config/cell_servo.yaml`:
  `is_primary_planning_scene_monitor: false → true`; `use_smoothing: true → false` (diag).
- `inspection_cell_moveit_config/launch/move_group.launch.py`: servo-start `TimerAction`
  `period 10.0 → 2.0` (the 10 s delay was a band-aid for the now-fixed all-zeros-scene issue).

### Useful runtime checks to re-run
```
ros2 param get /servo_node moveit_servo.command_in_type          # expect speed_units
ros2 service call /servo_node/switch_command_type moveit_msgs/srv/ServoCommandType "{command_type: 1}"  # force TWIST
ros2 control list_controllers -v                                  # controller joint order
ros2 topic echo /joint_states --once | grep -A8 name              # confirm alphabetical + turntable
```

*(Everything below is the ORIGINAL session-1 handoff, retained for context. Note items
4/6/7 of "What's Been Ruled Out" and the "σ_min" framing are confirmed; the "Hypotheses
Still On The Table" list is now narrowed to candidates A/B above.)*

---

## The Bug
A MoveIt Servo (Jazzy) node driving a UR5e produces a "single-minded trajectory" toward an upside-down EEF configuration regardless of the commanded twist. The pattern: tiny commanded twist on `/servo_node/delta_twist_cmds` (e.g. `vy = 0.002 m/s`), but the realized Cartesian motion of the EE is **~2 m/s linear and ~6.5 rad/s angular** — roughly 1000× amplification.

This is *not* explainable by IK alone: at the configurations seen, `σ_min ≈ 0.22`, so an unregularized pseudoinverse can at most amplify by `1/σ_min ≈ 4.5×`. We are seeing ~1000×.

## System
- Robot: UR5e on a turntable, with EOAT (eoat_base → camera) tipped at `eoat_camera_link`
- URDF root: `object_frame` (not `base_link`)
- MoveGroup `ur5e`: chain `ur_base_link → eoat_camera_link`, joints = 6 UR joints
- MoveGroup `disc_to_ur5e`: chain `object_frame → eoat_camera_link`, 7 joints (turntable + UR)
- Servo move_group_name: `ur5e`
- Admittance node publishes twist on `/servo_node/delta_twist_cmds`, expressed in `eoat_camera_link`
- Servo: `command_in_type: speed_units`, `apply_twist_commands_about_ee_frame: true`, smoothing on (Butterworth), publishes joint velocities to `/ur5e_forward_velocity_controller/commands`

## Current Configuration Snapshot
- `joint_limits.yaml`: position ±2π, velocity π, accel 1.0 (all joints incl. turntable)
- `cell_servo.yaml`:
  - `lower_singularity_threshold: 17.0`
  - `hard_stop_singularity_threshold: 30.0`
  - `leaving_singularity_threshold_multiplier: 2.0`
  - `use_smoothing: true`, Butterworth
  - `apply_twist_commands_about_ee_frame: true`
- `initial_positions.yaml`: `pan=0.2, lift=-1.3, elbow=-1.7, w1=-1.4, w2=1.4, w3=0.3` (perturbed off π/2 multiples)
- SRDF `Home_ur5e`: `pan=3.14, lift=-1.8398, elbow=-1.8224, w1=-1, w2=1.57, w3=0`
- Confirmed only `/admittance_control` publishes on `/servo_node/delta_twist_cmds`

## Debug Infrastructure
- New node: `inspection_control/nodes/servo_logger_node.py`
  - 10s rolling buffer
  - Service-trigger snapshot → PNG + JSON to `/data`
  - Subscribes: `teleop_wrench`, `orient_wrench`, `servo_twist`, `joint_vel_cmd`, `joint_states`, `/servo_node/status`, `robot_description`
  - Computes **actual EE twist** via KDL Jacobian from `joint_states.velocity` (inline `_kdl_tree_from_urdf_string`; `urdf_parser_py` + `PyKDL`; no `kdl_parser_py` needed)
  - SVD of the same Jacobian → σ₀..σ₅, σ_min, σ_max, cond
  - 7-panel plot: forces, torques, twist (cmd vs actual), commanded q̇, measured q̇, q positions, Jacobian SVD
  - Status changes annotated with vertical lines and short name labels

## What's Been Ruled Out
1. **Frame of cmd twist** — published in `ur_base_link` in test (a). Same single-minded trajectory.
2. **End-effector choice** — `tip_link=tool0` instead of `eoat_camera_link`. Same.
3. **Initial pose at singularity** — perturbed off π/2 multiples. Same.
4. **Velocity limits clamping** — tried disabling (catastrophic 10⁴¹ rad/s output), then π. Velocity limits aren't *causing* the bug; they constrain its symptom.
5. **Position limits placeholder** — were ±62831853; now ±2π. Didn't fix it.
6. **Singularity damping disabled** — user had thresholds at 170M / 300B (effectively infinite). Lowering to 5/20 then 17/30 makes servo *halt* sooner but does NOT reduce the magnitude of motion during the active window.
7. **Pseudoinverse amplification** — proven mathematically insufficient (1/σ_min ≈ 4.5 vs observed ~1000×).

## What's Still Unknown — and the Most Important Finding
**The 1000× amplification is upstream of (or independent of) the IK pseudoinverse math.** Looking at `/home/col/inspection-docker/data/servo_log_20260601_211233.json` during the active window t=6.49→6.72s:

| t (s) | cmd v | cmd w | act v | act w |
|---|---|---|---|---|
| 6.586 | (0, 0.002, 0) | (0,0,0) | (+0.40, −1.46, +1.41) | (+6.19, −2.05, −0.09) |
| 6.685 | (0, 0.007, 0) | (0,0,0) | (+0.86, −1.25, +1.55) | (+5.87, −1.92, −1.95) |

cond at these times ≈ 9, σ_min ≈ 0.22. Joint velocities are saturated at ±π on j2, j3, j5. The IK math cannot produce this from a 0.002 m/s cmd.

## Hypotheses Still On The Table
1. **Hidden command source.** Some other node publishing to `/servo_node/delta_twist_cmds`, `/servo_node/pose_target_cmds`, or `/servo_node/delta_joint_cmds`. We've only verified the twist topic earlier; should re-verify all three with `ros2 topic info --verbose` while running.
2. **Servo internal state / mode latch.** `switch_command_type` between POSE and TWIST may leave a "pose-tracking target" active. With pose tolerances `0.001 m / 0.01 rad`, a stale target would produce huge corrective motion until tolerance is met.
3. **First-cycle integration bug.** Servo may treat the first non-zero twist as integrated over the time since startup (6.5s here), producing a huge effective delta.
4. **URDF kinematics subtly wrong.** A joint axis flipped or origin misplaced somewhere along the chain. The user mentioned "the EOAT was put on tool0 backwards" — but the tip_link=tool0 test showed the bug is not in the EOAT chain, so this is unlikely.
5. **Smoothing filter state.** Butterworth smoothing is on; with bad initial state it could ring up at startup. But the filter is normally bounded.

## Recommended Next Steps for the Next Session
1. **Verify topic publishers at runtime:**
   ```
   ros2 topic info /servo_node/delta_twist_cmds --verbose
   ros2 topic info /servo_node/pose_target_cmds --verbose
   ros2 topic info /servo_node/delta_joint_cmds --verbose
   ```
2. **Watch in two terminals simultaneously:**
   ```
   ros2 topic echo /servo_node/delta_twist_cmds
   ros2 topic echo /ur5e_forward_velocity_controller/commands
   ```
   Pump a hand-crafted small twist via `ros2 topic pub` (bypassing admittance) and observe whether servo *still* emits π-saturated joint commands. This isolates whether the bug is in admittance vs. servo.
3. **Inspect MoveIt Servo source for `command_in_type`/`switch_command_type` state leakage.** Specifically look for a member like `pose_target_` that persists across mode switches.
4. **Try `use_smoothing: false`** as a one-shot to rule out filter ring-up.
5. **Try `apply_twist_commands_about_ee_frame: false`** combined with publishing cmd in `ur_base_link` — fully rule out frame double-rotation inside servo.
6. **Confirm command_in_type at runtime** with `ros2 param get /servo_node moveit_servo.command_in_type` (we did this once; confirm again post-restart that nothing reverted it).

## Key Files
- Logger: `src/Inspection_Control/inspection_control/inspection_control/nodes/servo_logger_node.py`
- Admittance: `src/Inspection_Control/inspection_control/inspection_control/nodes/admittance_control_node.py`
- Servo config: `src/Inspection_Cell/inspection_cell_moveit_config/config/cell_servo.yaml`
- Joint limits: `src/Inspection_Cell/inspection_cell_description/config/beta/joint_limits.yaml`
- Initial pos: `src/Inspection_Cell/inspection_cell_description/config/beta/initial_positions.yaml`
- SRDF: `src/Inspection_Cell/inspection_cell_moveit_config/config/inspection_cell.srdf`
- Launch: `src/Inspection_Control/inspection_control/launch/admittance_control.launch.py` (auto-launches logger)

## Key Data Captures (all under `/home/col/inspection-docker/data/`)
- `servo_log_20260601_173654.json` — early baseline
- `servo_log_20260601_183845.json` — ur_base_link frame test
- `servo_log_20260601_185452.json` — eoat frame restored
- `servo_log_20260601_190849.json` — semi-controllable end state
- `servo_log_20260601_203322.json` — first run with Jacobian SVD
- `servo_log_20260601_204438.json` / `_204456.json` — single-minded vs eventually-controllable
- `servo_log_20260601_205644.json` — tip_link=tool0 test
- `servo_log_20260601_210526.json` — perturbed home + eoat restored
- `servo_log_20260601_211233.json` — singularity thresholds 5/20; **the smoking gun** for "amplification persists even with damping"
