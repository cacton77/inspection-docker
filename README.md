# Inspection Docker

A Docker-based deployment environment for the MACS Lab inspection cell. This repo sets up a ROS2 workspace (Humble or Jazzy), clones all inspection cell packages and data, provides GPU-accelerated mesh segmentation via PartField, and includes a systemd service option for auto-start bringup.

---

## Overview

The container's ROS distro is parametrized (`ROS_DISTRO` in `.env`, currently `jazzy`) and built from `osrf/ros:${ROS_DISTRO}-desktop-full`:

- **MoveIt2** — built from source on Humble (apt doesn't ship `moveit_py` there); installed via apt on Jazzy
- **CycloneDDS** as the default ROS2 middleware (FastDDS config is also shipped, but CycloneDDS is the one that's held up under cross-host, high-bandwidth image streaming — see `.env`)
- **Universal Robots**, **Intel RealSense**, and **Foxglove Bridge** drivers/tools
- **Zivid SDK 2.18** + the `zivid-ros` driver for the Zivid 2+ MR60 3D camera — see [Zivid 3D Camera](#zivid-3d-camera-zivid-2-mr60) below
- **CUDA 12.8 + PyTorch 2.7** for GPU workloads, supporting everything from Ampere (A4000) through Blackwell (RTX 50-series) — see [GPU / PartField](#gpu--partfield-mesh-segmentation) below
- A **colcon workspace** (`ros2_ws/`) mounted from the host: the inspection cell packages in `ros2_ws/src/`, plus colcon's `build/`, `install/` and `log/`, which persist between containers so only changed packages rebuild
- A **data directory** (`data/`) mounted from the host, containing viewpoint generation data via Git LFS
- A **models directory** (`models/`) mounted from the host, containing the PartField mesh-segmentation model
- **Arduino firmware** management for cell peripherals (e.g. the turntable's ESP32), built/flashed by `install.sh`
- **Foxglove** remote viewing and control: camera feeds, the robot model and viewpoint-generation results through the lab's `foxglove_bridge`, plus custom panels for the EOAT lights and focus, the part catalog and the planning pipeline — see [Foxglove](#foxglove)

---

## Repository Structure

```
inspection-docker/
├── .env                          # Container name, ROS domain/distro, DDS choice, compose profile
├── install.sh                    # One-time setup / rebuild script
├── connect.sh                    # Start or attach to the container
├── run.sh                        # Stop any existing container, start fresh, run bringup
├── stop.sh                       # Stop the container (and systemd service, if enabled)
├── restart.sh                    # stop.sh + run.sh (or systemd restart)
├── log.sh                        # Tail systemd service logs (only when USE_SERVICE=true)
├── docker/
│   ├── docker-compose.yaml       # Services: linux (no GPU), linux-gpu (NVIDIA passthrough)
│   ├── Dockerfile.humble         # Image definition — ROS2 Humble
│   ├── Dockerfile.jazzy          # Image definition — ROS2 Jazzy (CUDA/PyTorch/PartField)
│   ├── entrypoint.sh             # Sources ROS2, base_ws, and ros2_ws on shell startup
│   ├── packages.{humble,jazzy}.txt          # APT packages for the base image
│   ├── overlay_packages.{humble,jazzy}.txt  # APT packages for the overlay (UR, RealSense)
│   └── requirements.txt          # Python/PyTorch packages (PartField dependencies)
├── config/
│   ├── dds/                      # cyclonedds.xml + fastdds.xml (mounted at /config/dds)
│   └── rviz/                     # Saved RViz configs (mounted at /config/rviz)
├── ros2_ws/                     # colcon workspace, mounted at /workspaces/ros2_ws
│   ├── src/
│   │   ├── shared.repos          # vcstool manifest for inspection cell packages
│   │   └── ...                   # Cloned packages (created by install.sh)
│   └── build/ install/ log/      # colcon outputs (gitignored, persist across containers)
├── data/
│   ├── data.repos                # vcstool manifest for data repositories
│   └── ViewpointGenerationData/  # Git LFS data (cloned by install.sh)
├── models/
│   ├── models.repos              # vcstool manifest for model repositories
│   └── PartField/                # Cloned by install.sh; checkpoint also fetched by install.sh
├── foxglove/
│   └── eoat-controls/            # Foxglove extension: EOAT Lighting/Focus, PLM Catalog, Viewpoint Generation panels
├── docs/                         # FOXGLOVE.md, migration notes, integration plans
└── arduino/                       # arduino-cli install + compiled firmware artifacts
```

---

## ROS2 Packages

All packages are cloned into `ros2_ws/src/` by `install.sh` using vcstool.

| Package | Repository | Branch |
|---|---|---|
| [Inspection_System](https://github.com/cacton77/Inspection_System) | cacton77/Inspection_System | `main` |
| [ViewpointGeneration](https://github.com/cacton77/ViewpointGeneration) | cacton77/ViewpointGeneration | `main` |
| [Inspection_Cell](https://github.com/DevanshB99/Inspection_Cell) | DevanshB99/Inspection_Cell | `main` |
| [Inspection_Control](https://github.com/antara1005/Inspection_Control) | antara1005/Inspection_Control | `main` |
| [zivid-ros](https://github.com/zivid/zivid-ros) | zivid/zivid-ros | `v3.4.0` (pinned to match the SDK) |
| [Turntable_ROS2_Driver](https://github.com/DevanshB99/Turntable_ROS2_Driver) | DevanshB99/Turntable_ROS2_Driver | `ESP32` |
| [http_image_publisher](https://github.com/cacton77/http_image_publisher) | cacton77/http_image_publisher | `main` |

### Data Repositories

Large data assets are stored in Git LFS and cloned into `data/`.

| Repository | Branch |
|---|---|
| [ViewpointGenerationData](https://github.com/cacton77/ViewpointGenerationData) | `main` |

### Model Repositories

Cloned into `models/` by `install.sh`. `PartField` points at our fork (compatibility fixes for current PyTorch/matplotlib — see below), not the upstream `nv-tlabs/PartField`.

| Repository | Branch |
|---|---|
| [PartField](https://github.com/cacton77/PartField) (fork of [nv-tlabs/PartField](https://github.com/nv-tlabs/PartField)) | `main` |

`install.sh` also downloads the pretrained checkpoint (`model_objaverse.ckpt`, ~1.2 GB) from Hugging Face into `models/PartField/model/` if it isn't already present.

---

## Prerequisites

- [Docker](https://docs.docker.com/engine/install/) with the Compose plugin
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) (if using GPU — required for the `linux-gpu` profile)
- `git-lfs`, `vcstool`, and `arduino-cli` are installed automatically by `install.sh` if missing

---

## Installation & Building

`install.sh` is the main script for both initial setup and rebuilding during development:

```bash
./install.sh
```

The script will:
1. Install `pip3`, `vcstool`, and `git-lfs` if not present
2. Clone all packages from `ros2_ws/src/shared.repos` into `ros2_ws/src/` (first moving any packages from the old `./src` layout into place)
3. Clone data repositories from `data/data.repos` and pull Git LFS objects
4. Clone model repositories from `models/models.repos` and download the PartField checkpoint
5. Install `arduino-cli` and compile/flash any firmware sketches found under `ros2_ws/src/` (per-sketch `MICROROS_DOMAIN_ID` is generated from `.env`)
6. Auto-detect an NVIDIA GPU (override with `--gpu` or `--linux`) and pick the Compose profile accordingly
7. Build (or rebuild) the Docker image
8. Increase kernel socket buffer limits (`rmem_max`/`wmem_max`/IP fragmentation thresholds) for DDS performance
9. Optionally install a systemd service for auto-start (`--service`)
10. Build `ros2_ws` inside the container

```bash
# Force a platform profile
./install.sh --gpu       # linux-gpu profile (NVIDIA passthrough)
./install.sh --linux     # linux profile (no GPU)
./install.sh --profile=custom-profile

# Run the container as a systemd service (auto-start on boot)
./install.sh --service
./install.sh --no-service
```

Re-running `install.sh` during development rebuilds the Docker image (using cache) and rebuilds `ros2_ws`. For source-only changes it's quicker to start a new container (`./connect.sh` / `./run.sh`), which runs an incremental `colcon build`, or to run `./connect.sh colcon build` in the running one. **After changing anything under `docker/`** (Dockerfile, packages, requirements), re-run `install.sh` (or `docker compose -f docker/docker-compose.yaml --env-file .env build`) to pick it up — an already-running container won't see Dockerfile changes until it's rebuilt.

---

## Usage

### Interactive Development Shell

Open a bash shell inside the container (starts the container if not already running):

```bash
./connect.sh
```

If the container is already running, this execs a new shell into it. Additional arguments are passed as a command:

```bash
./connect.sh colcon build
./connect.sh ros2 topic list
```

### Bringup

Stop any existing container, start fresh, and run the full inspection cell bringup, [Inspection_System](https://github.com/cacton77/Inspection_System)'s `inspection_bringup`:

```bash
./run.sh                 # the rig set by RIG in .env
./run.sh sim:=true       # extra launch arguments override the rig
```

`RIG` in `.env` names a rig profile, `inspection_bringup/config/rigs/<RIG>.yaml`, which holds the launch arguments for this machine's physical setup (e.g. `beta_dual`: the beta cell with the Zivid arm). Unset, it is `none`: no cell hardware. The rigs and every launch argument are documented in Inspection_System's README.

### Stop / Restart / Logs

```bash
./stop.sh      # Stop the container (and systemd service, if USE_SERVICE=true)
./restart.sh   # stop.sh followed by run.sh (or `systemctl restart`, if using the service)
./log.sh       # Tail systemd service logs (only useful when USE_SERVICE=true)
```

---

## Configuration

### `.env`

Key environment variables read by the scripts and Docker Compose:

| Variable | Default | Description |
|---|---|---|
| `CONTAINER_NAME` | `inspection-docker` | Docker container/image name |
| `ROS_DOMAIN_ID` | `9` | ROS2 domain ID |
| `ROS_DISTRO` | `jazzy` | `humble` or `jazzy` — selects the Dockerfile, base image, and package lists |
| `RMW_IMPLEMENTATION` | `rmw_cyclonedds_cpp` | ROS2 middleware. FastDDS is also configured but stalls on cross-host high-bandwidth image topics — stick with Cyclone unless something specifically needs FastDDS |
| `COMPOSE_PROFILE` / `COMPOSE_SERVICE` | `linux` | Which Compose profile/service to run — set automatically by `install.sh` based on GPU auto-detection (or `--gpu`/`--linux`/`--profile=`) |
| `USE_SERVICE` | `false` | Whether the container is managed by a systemd service |
| `RIG` | `none` | Rig profile `run.sh` launches (`inspection_bringup/config/rigs/<RIG>.yaml`), e.g. `beta_dual` |

### DDS

`config/dds/cyclonedds.xml` and `config/dds/fastdds.xml` are mounted into the container at `/config/dds/` and configure tuned socket buffer sizes (10 MB send/receive) for high-bandwidth image topics. Both `FASTRTPS_DEFAULT_PROFILES_FILE` (Humble) and `FASTDDS_DEFAULT_PROFILES_FILE` (Jazzy) are set so the FastDDS config is picked up on either distro if you switch `RMW_IMPLEMENTATION`.

---

## GPU / PartField Mesh Segmentation

`docker/Dockerfile.jazzy` installs CUDA 12.8 and PyTorch 2.7.0+cu128 to run [PartField](https://github.com/nv-tlabs/PartField), used by `ViewpointGeneration`'s `PartFieldSegmentation` for AI-based mesh part segmentation (`ros2_ws/src/ViewpointGeneration/.../partfield_segmentation.py`, invoked as a subprocess per segmentation call).

This stack supports GPUs from Ampere through Blackwell (RTX 50-series). One thing to know if you touch this again: `torch_scatter`'s prebuilt wheel only ships native CUDA kernels up to `sm_90` (Hopper) — on `sm_120` (Blackwell) it silently falls back to JIT-compiling ancient `sm_50` PTX via the CUDA driver. The Dockerfile instead builds `torch_scatter` from source with `TORCH_CUDA_ARCH_LIST="8.6;12.0"` (Ampere + Blackwell) so both machine types get native kernels. `MAX_JOBS` is capped during that build to avoid OOM from parallel `nvcc` invocations.

Our PartField fork (`models/models.repos` → `cacton77/PartField`) carries two compatibility fixes needed for this newer torch/matplotlib combo:
- `torch.serialization.add_safe_globals([CfgNode])` for PyTorch's `weights_only=True` default in `torch.load`
- `matplotlib.colormaps[...].resampled(...)` replacing the removed `plt.cm.get_cmap`

---

## Zivid 3D Camera (Zivid 2+ MR60)

`docker/Dockerfile.jazzy` installs the Zivid SDK (`ZIVID_SDK_VERSION`, currently 2.18) from Zivid's `.deb` releases, and `ros2_ws/src/shared.repos` clones [`zivid-ros`](https://github.com/zivid/zivid-ros) at `v3.4.0`, which supports SDK 2.15–2.18. **Bump the two together.** If they don't match, the driver fails to configure (`find_package(Zivid 2.15.0 ...)`) or the SDK rejects the camera firmware.

The SDK has two compute backends, set per compose service by the `ZIVID_BACKEND` build arg:

| Service | `ZIVID_BACKEND` | Package | GPU access |
|---|---|---|---|
| `linux-gpu` | `cuda` | `zivid-cuda` | NVIDIA Container Toolkit (`NVIDIA_DRIVER_CAPABILITIES=all` already includes `compute`) |
| `linux` | `opencl` | `zivid-opencl` + `intel-opencl-icd` | Intel iGPU via `/dev/dri` (already mounted through `/dev`) |

`zivid-tools` (`ZividListCameras`, `ZividFirmwareUpdater`) and `zivid-genicam` (the GigE transport) are installed for both. The container already uses `network_mode: host`, so the camera is discovered on the host's interfaces.

### Host network

The Zivid 2+ is a GigE Vision camera, and it needs **10 GbE** for full capture speed. 1/2.5/5 GbE work but are slower, and USB NICs are unreliable. Out of the box the camera has the static IP `172.28.60.5/24`. Give the host NIC it plugs into a static address on the same subnet, and enable jumbo frames:

```bash
nmcli con add type ethernet ifname <nic> con-name zivid \
    ipv4.method manual ipv4.addresses 172.28.60.2/24 ipv6.method disabled 802-3-ethernet.mtu 9000
nmcli con up zivid
```

The lab camera (serial `2631665A`) currently sits on the lab LAN instead, using DHCP (`192.168.0.209` as of 2026-10-05) over the host's 1 GbE port. That works, but captures are slower than over a dedicated 10 GbE link. Only one client can connect to the camera at a time. If Zivid Studio is open, `ZividListCameras` reports `Status: busy` and the driver aborts with *No available cameras found*. Close Studio before you launch the driver.

The camera must also be reachable through **exactly one** host interface. If two NICs are on the camera's subnet (e.g. wired and Wi-Fi both on `192.168.0.0/24`), the driver aborts on connect with `Internal error: Expected only one local interface for a 'connected' state camera`. Disconnect the second interface (`nmcli dev disconnect <wifi-if>`), or give the camera its own subnet.

### Verify and launch

```bash
./connect.sh ZividListCameras --test-connect        # camera discovered + connectable?
./connect.sh ros2 launch zivid_samples zivid_camera.launch \
    model:=ZIVID_2_PLUS_MR60 serial_number:=<serial>  # driver + URDF (robot_state_publisher)
# Capture fails until settings are set. Have the capture assistant fill in settings_yaml:
./connect.sh ros2 service call /capture_assistant/suggest_settings \
    zivid_interfaces/srv/CaptureAssistantSuggestSettings "{max_capture_time: {sec: 1}}"
./connect.sh ros2 service call /capture std_srvs/srv/Trigger   # publishes points/xyzrgba, color/image_color, depth/image
```

The driver sets `update_firmware_automatically:=true` by default, so on first connect it flashes the camera to match the SDK. Don't interrupt that. For repeatable inspection captures, tune the settings in Zivid Studio, export them to a `.yml`, and pass that file as `settings_file_path`. Set either `settings_file_path` or `settings_yaml`, not both; with both set, capture errors. Without hardware, set `file_camera_path` to a [Zivid file camera](https://support.zivid.com/en/latest/academy/camera/file-camera.html).

---

## Foxglove

The bringup starts `foxglove_bridge` on port 8765, so the cell can be watched and driven from
the [Foxglove](https://foxglove.dev) desktop app on any machine that can reach the lab PC
(on the LAN, or over Tailscale from off campus). Connect with **Open connection → Foxglove
WebSocket**, `ws://<lab host>:8765`.

- **Cameras**: view the EOAT macro camera as `/pi_camera/video/foxglove`, an H.264 stream
  (~1 Mbit/s) re-encoded on the lab, rather than the ~88 Mbit/s JPEG topic.
- **Robot model**: enable `/robot_description` in a 3D panel, and set **Scene → Ignore COLLADA
  `<up_axis>`**.
- **Viewpoint generation**: ViewpointGeneration's `foxglove_viz_node` draws each pipeline
  stage's results (regions, clusters, viewpoints, path, blind spots) on
  `/viewpoint_generation/viz/*`, the remote counterpart of the Open3D GUI.
- **Panels**: the `EOAT Controls` extension in [`foxglove/eoat-controls/`](foxglove/eoat-controls/)
  adds **EOAT Lighting**, **EOAT Focus**, **PLM Catalog** and **Viewpoint Generation** panels.
  Install it once per machine (Node.js 18+):

  ```bash
  cd foxglove/eoat-controls && npm install && npm run local-install   # then restart Foxglove
  ```

The bridge only lets clients publish on, and call, the topics and services those panels need.
[`docs/FOXGLOVE.md`](docs/FOXGLOVE.md) has the full guide: the bridge whitelist, topics, panel
details, layout tips and troubleshooting.

---

## Workspace Layout Inside the Container

| Path | Description |
|---|---|
| `/workspaces/base_ws` | MoveIt2 built from source on Humble (image layer, read-only at runtime) |
| `/workspaces/ros2_ws` | colcon workspace (bind-mounted from `./ros2_ws`): `src/`, `build/`, `install/`, `log/` |
| `/catalog` | PLM parts catalog cache, used by [plm_bridge](https://github.com/cacton77/plm_bridge) (bind-mounted from `./catalog`) |
| `/data` | Viewpoint generation data (bind-mounted from `./data`) |
| `/models` | PartField and other models (bind-mounted from `./models`); added to `PYTHONPATH` |
| `/config` | DDS and RViz config (bind-mounted from `./config`) |

The entrypoint sources workspaces in order: ROS2 → `base_ws` → `ros2_ws`. When a **new container** starts (`./connect.sh` or `./run.sh` with none running), it first runs `colcon build` in `ros2_ws`. Because `build/`/`install/`/`log/` live on the host, that build is incremental: unchanged packages are skipped. Attaching to an already-running container, or opening another shell in it, only sources the workspace and never rebuilds (unless nothing has been built yet).

`colcon build` writes into `ros2_ws/` as the container user, which `host-ids.sh` matches to the host user, so the outputs stay owned by you on the host. To force a clean rebuild, delete `ros2_ws/build ros2_ws/install ros2_ws/log` on the host.

---

## Updating Packages

To pull the latest changes for all packages:

```bash
cd ros2_ws/src && vcs pull   # ROS2 packages
cd ../../data && vcs pull      # Data repositories
cd ../models && vcs pull       # Model repositories
```

Then re-run `install.sh` to rebuild the workspace:

```bash
./install.sh
```

Or rebuild directly inside the container without going through the full install:

```bash
./connect.sh colcon build
```

---

## Further Documentation

- [`docs/FOXGLOVE.md`](docs/FOXGLOVE.md) — remote viewing and control with Foxglove: bridge setup, topics, the EOAT Controls panels, troubleshooting
- [`JAZZY_MIGRATION.md`](JAZZY_MIGRATION.md) — handoff notes from the Humble → Jazzy migration, including an unresolved `moveit_servo` regression
- [`ISAAC_SIM_INTEGRATION.md`](ISAAC_SIM_INTEGRATION.md) — plan for integrating Isaac Sim 5.0 as a simulation backend
