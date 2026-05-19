# Jazzy migration — handoff notes

Self-contained context for continuing the ROS2 Humble → Jazzy migration on another machine.

## Why we're migrating

The container builds MoveIt2 from `main` because Humble apt does not ship `moveit_py`. This pulls an unpinned `main` clone on every rebuild, and a recent build picked up a `moveit_servo` regression that has the following signature:

- Servo accepts twist input on `/servo_node/delta_twist_cmds` (verified varying with joystick).
- Servo emits a fixed joint-velocity vector on `/ur5e_forward_velocity_controller/commands`, identical across all joystick directions (verified — values match to 4+ decimal places regardless of input).
- The locked vector saturates one joint at `max_velocity` (0.5 rad/s) and scales the others proportionally — the signature of an IK solution to a fixed Cartesian target.
- Robot drives along the locked trajectory until `hard_stop_singularity_threshold: 30.0` trips, at which point Servo emits `code: 2, message: "Very close to a singularity, emergency stop"`.
- Final pose has every wrist joint converging toward 0 — i.e., Servo's frozen target appears to be FK(initial_positions = all zeros), which sits at the wrist singularity (`wrist_2 = 0`).
- Smoothing filter (Butterworth), latency compensation, command frame, joint limits, singularity thresholds, and phantom-publisher hypotheses were all ruled out.

Diagnosis: Servo's twist→target accumulation is broken in the built revision of `main`. The fastest stable path is Jazzy + apt MoveIt + apt `moveit_py`.

## What's already done on this branch

All files committed to the repo. The Humble setup is untouched and still works for rollback.

**New files:**
- `docker/Dockerfile.jazzy` — Jazzy base image, apt-installs MoveIt + moveit_py + servo + configs-utils. No source build. CUDA 12.4 repo path adjusted to `ubuntu2404`. All pip commands use `--break-system-packages` (PEP 668 on Ubuntu 24.04).
- `docker/packages.jazzy.txt` — humble→jazzy package names. Slimmed: most MoveIt source-build deps removed since apt MoveIt pulls them.
- `docker/overlay_packages.jazzy.txt` — `ros-humble-*` → `ros-jazzy-*` (ur driver, realsense).
- `docker-compose.jazzy.yaml` — compose override. Sets image tag `:jazzy`, Dockerfile path, base image, `ROS_DISTRO=jazzy`.

**Modified files:**
- `install.sh` — accepts `--jazzy` flag; persists `USE_JAZZY` to `.env`; layers `docker-compose.jazzy.yaml` into the build command when set.
- `launch_container.sh` — reads `USE_JAZZY` from `.env`; layers the jazzy override when set.

The existing Humble files (`docker/Dockerfile`, `docker/packages.txt`, `docker/overlay_packages.txt`, `docker-compose.yaml`) are unchanged.

## How to build the Jazzy image

From the repo root on the new machine:

```bash
./install.sh --jazzy           # auto-detects GPU
./install.sh --jazzy --gpu     # force GPU
./install.sh --jazzy --no-gpu  # force CPU
```

This builds an image tagged `<container_name>:jazzy` and writes `USE_JAZZY=true` to `.env`. `launch_container.sh` then uses that image. To switch back to Humble, re-run `./install.sh` without `--jazzy` (which sets `USE_JAZZY=false`).

## Known risks on first build (expected fix order)

1. **PyTorch wheel availability for cu124 + Python 3.12.** `docker/requirements.txt:9-11` pins `torch==2.4.0+cu124`. If pip errors with "no matching distribution" for Python 3.12, bump pins (likely `torch>=2.4.1,<2.6`). Check `https://download.pytorch.org/whl/cu124/` for available wheels.
2. **`torch-scatter` wheel mismatch.** `docker/Dockerfile.jazzy:85` references `torch-2.4.0+cu124.html`. If you bump torch, change this URL to match the chosen torch version (`torch-2.4.1+cu124.html`, etc.). See `https://data.pyg.org/whl/`.
3. **NVIDIA CUDA repo key rotation.** `docker/Dockerfile.jazzy:46` uses `3bf863cc.pub`. If `apt-key adv --fetch-keys` fails on the `ubuntu2404` repo, fetch the current key fingerprint from NVIDIA's CUDA-on-Ubuntu install docs and replace.
4. **Apt package names.** Assumed `ros-jazzy-moveit`, `ros-jazzy-moveit-py`, `ros-jazzy-moveit-servo`, `ros-jazzy-moveit-configs-utils`, `ros-jazzy-moveit-resources`, `ros-jazzy-ur`. If any are missing or renamed, apt will say so — adjust `docker/Dockerfile.jazzy:14-20` and/or `docker/overlay_packages.jazzy.txt`.
5. **PartField Python 3.12 compatibility.** PartField is mounted from `models/PartField` via compose. If it has hard pins on older Python or older torch, may need updates upstream or vendored patches.
6. **`open3d` and `opencv-python` on Python 3.12.** Both have 3.12 wheels in recent versions. `docker/requirements.txt` should be fine but verify after build.

## Validation after build

The whole point of this migration is to escape the Servo regression. Validate in this order:

1. **Container builds and starts:** `./launch_container.sh`
2. **Workspace builds:** the entrypoint auto-builds `shared_ws`. Watch for any `ros-humble-*`-named find_package errors that should be `ros-jazzy-*` — rare but possible if any of our packages have distro-pinned references.
3. **Launch the system:** `./run.sh cell:=beta`
4. **Test Servo specifically:**
   - With the robot in a non-singular pose, push the joystick in different directions.
   - Confirm `/ur5e_forward_velocity_controller/commands` output changes meaningfully with joystick direction (this is the test that failed on Humble main — a locked vector across directions means the bug is still there).
   - Confirm the robot's actual motion matches joystick input direction.
   - If Servo now responds correctly to twist input, the migration succeeded in its primary goal.

## Cleanup after validation

Once Jazzy is confirmed working and you want to retire Humble:

1. Delete `docker/Dockerfile`, `docker/packages.txt`, `docker/overlay_packages.txt`.
2. Rename `Dockerfile.jazzy` → `Dockerfile` (and update `docker-compose.yaml` accordingly).
3. Merge `docker-compose.jazzy.yaml` into `docker-compose.yaml` and delete the override file.
4. Remove the `USE_JAZZY` / `--jazzy` machinery from `install.sh` and `launch_container.sh`.
5. Remove this `JAZZY_MIGRATION.md` file.

Done as a separate commit so the migration history stays auditable.

## Rollback path if Jazzy doesn't work

Re-run `./install.sh` (no flag). That sets `USE_JAZZY=false` in `.env` and rebuilds the Humble image. The new files are inert in that mode.

If you also need to escape the Humble main-MoveIt regression in the meantime, the alternative is to pin the moveit2 clone to a known-good commit:

```dockerfile
# in docker/Dockerfile, replace the existing clone line:
RUN git clone https://github.com/ros-planning/moveit2.git && \
    cd moveit2 && git checkout <known-good-sha> && \
    for repo in moveit2/moveit2.repos $(...); do vcs import < "$repo"; done
```

Find a SHA from before the regression by looking at `moveit_ros/moveit_servo/` history on github.

## Live config notes (carried over from debugging)

Servo parameters that were tuned during debugging and should be kept on Jazzy:

- `cell_servo.yaml:62-63` — singularity thresholds set to `17.0` / `30.0` (defaults). Do NOT revert to the previously-disabled large values.
- `cell_servo.yaml:33` — `use_smoothing: false` currently. Re-enable once Servo is confirmed working on Jazzy; the smoothing-disabled state was only for diagnostic isolation.
- `cell_servo.yaml:53` — `robot_link_command_frame` was switched to `ur_base_link` during diagnosis. Restore to `eoat_camera_link` for normal teleop semantics.

Joint position limits in `inspection_cell_description/config/beta/joint_limits.yaml` were widened (wrist_3 to ±2π) to accommodate the previous EOAT orientation. The EOAT has since been flipped back; ±2π is over-permissive but not harmful. Tighten later if desired.
