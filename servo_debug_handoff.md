# MoveIt Servo Debug Handoff

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
