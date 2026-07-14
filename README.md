# Inspection Docker

A Docker-based deployment environment for the MACS Lab inspection cell. This repo sets up a ROS2 workspace (Humble or Jazzy), clones all inspection cell packages and data, provides GPU-accelerated mesh segmentation via PartField, and includes desktop shortcuts and a systemd service option for one-click bringup.

---

## Overview

The container's ROS distro is parametrized (`ROS_DISTRO` in `.env`, currently `jazzy`) and built from `osrf/ros:${ROS_DISTRO}-desktop-full`:

- **MoveIt2** — built from source on Humble (apt doesn't ship `moveit_py` there); installed via apt on Jazzy
- **CycloneDDS** as the default ROS2 middleware (FastDDS config is also shipped, but CycloneDDS is the one that's held up under cross-host, high-bandwidth image streaming — see `.env`)
- **Universal Robots**, **Intel RealSense**, and **Foxglove Bridge** drivers/tools
- **CUDA 12.8 + PyTorch 2.7** for GPU workloads, supporting everything from Ampere (A4000) through Blackwell (RTX 50-series) — see [GPU / PartField](#gpu--partfield-mesh-segmentation) below
- A **source workspace** (`src/`) mounted from the host, containing all inspection cell packages
- A **data directory** (`data/`) mounted from the host, containing viewpoint generation data via Git LFS
- A **models directory** (`models/`) mounted from the host, containing the PartField mesh-segmentation model
- **Arduino firmware** management for cell peripherals (e.g. the turntable's ESP32), built/flashed by `install.sh`

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
├── desktop/
│   ├── bringup.desktop           # Desktop shortcut: Inspection Bringup
│   └── devel.desktop             # Desktop shortcut: Inspection Development
├── assets/                       # Icons for the desktop shortcuts
├── docker-compose.yaml           # Services: linux (no GPU), linux-gpu (NVIDIA passthrough)
├── docker/
│   ├── Dockerfile.humble         # Image definition — ROS2 Humble
│   ├── Dockerfile.jazzy          # Image definition — ROS2 Jazzy (CUDA/PyTorch/PartField)
│   ├── entrypoint.sh             # Sources ROS2, base_ws, and shared_ws on shell startup
│   ├── packages.{humble,jazzy}.txt          # APT packages for the base image
│   ├── overlay_packages.{humble,jazzy}.txt  # APT packages for the overlay (UR, RealSense)
│   └── requirements.txt          # Python/PyTorch packages (PartField dependencies)
├── config/
│   ├── dds/                      # cyclonedds.xml + fastdds.xml (mounted at /config/dds)
│   └── rviz/                     # Saved RViz configs (mounted at /config/rviz)
├── src/
│   ├── shared.repos              # vcstool manifest for inspection cell packages
│   └── ...                       # Cloned packages (created by install.sh)
├── data/
│   ├── data.repos                # vcstool manifest for data repositories
│   └── ViewpointGenerationData/  # Git LFS data (cloned by install.sh)
├── models/
│   ├── models.repos              # vcstool manifest for model repositories
│   └── PartField/                # Cloned by install.sh; checkpoint also fetched by install.sh
└── arduino/                       # arduino-cli install + compiled firmware artifacts
```

---

## ROS2 Packages

All packages are cloned into `src/` by `install.sh` using vcstool.

| Package | Repository | Branch |
|---|---|---|
| [ViewpointGeneration](https://github.com/cacton77/ViewpointGeneration) | cacton77/ViewpointGeneration | `main` |
| [Inspection_Cell](https://github.com/DevanshB99/Inspection_Cell) | DevanshB99/Inspection_Cell | `main` |
| [Inspection_Control](https://github.com/antara1005/Inspection_Control) | antara1005/Inspection_Control | `main` |
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
- `terminator` terminal emulator (used by desktop shortcuts)
- `git-lfs`, `vcstool`, and `arduino-cli` are installed automatically by `install.sh` if missing

---

## Installation & Building

`install.sh` is the main script for both initial setup and rebuilding during development:

```bash
./install.sh
```

The script will:
1. Install `pip3`, `vcstool`, and `git-lfs` if not present
2. Clone all packages from `src/shared.repos` into `src/`
3. Clone data repositories from `data/data.repos` and pull Git LFS objects
4. Clone model repositories from `models/models.repos` and download the PartField checkpoint
5. Install `arduino-cli` and compile/flash any firmware sketches found under `src/` (per-sketch `MICROROS_DOMAIN_ID` is generated from `.env`)
6. Auto-detect an NVIDIA GPU (override with `--gpu` or `--linux`) and pick the Compose profile accordingly
7. Build (or rebuild) the Docker image
8. Install `.env`, `docker-compose.yaml`, `connect.sh`, and desktop shortcuts to `~/.local/share/applications/<container>/`, symlinked onto `~/Desktop`
9. Increase kernel socket buffer limits (`rmem_max`/`wmem_max`/IP fragmentation thresholds) for DDS performance
10. Optionally install a systemd service for auto-start (`--service`)
11. Build `shared_ws` inside the container

```bash
# Force a platform profile
./install.sh --gpu       # linux-gpu profile (NVIDIA passthrough)
./install.sh --linux     # linux profile (no GPU)
./install.sh --profile=custom-profile

# Run the container as a systemd service (auto-start on boot)
./install.sh --service
./install.sh --no-service
```

Re-running `install.sh` during development rebuilds the Docker image (using cache) and rebuilds `shared_ws`, making it the standard way to apply source changes. **After changing anything under `docker/`** (Dockerfile, packages, requirements), re-run `install.sh` (or `docker compose build`) to pick it up — an already-running container won't see Dockerfile changes until it's rebuilt.

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

Stop any existing container, start fresh, and run the full inspection cell bringup (`viewpoint_generation bringup.launch.py`):

```bash
./run.sh
```

### Stop / Restart / Logs

```bash
./stop.sh      # Stop the container (and systemd service, if USE_SERVICE=true)
./restart.sh   # stop.sh followed by run.sh (or `systemctl restart`, if using the service)
./log.sh       # Tail systemd service logs (only useful when USE_SERVICE=true)
```

### Desktop Shortcuts

After running `install.sh`, two shortcuts appear on the desktop:

- **Inspection Bringup** — opens a terminal and runs `connect.sh`
- **Inspection Development** — opens an interactive development shell

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

### DDS

`config/dds/cyclonedds.xml` and `config/dds/fastdds.xml` are mounted into the container at `/config/dds/` and configure tuned socket buffer sizes (10 MB send/receive) for high-bandwidth image topics. Both `FASTRTPS_DEFAULT_PROFILES_FILE` (Humble) and `FASTDDS_DEFAULT_PROFILES_FILE` (Jazzy) are set so the FastDDS config is picked up on either distro if you switch `RMW_IMPLEMENTATION`.

---

## GPU / PartField Mesh Segmentation

`docker/Dockerfile.jazzy` installs CUDA 12.8 and PyTorch 2.7.0+cu128 to run [PartField](https://github.com/nv-tlabs/PartField), used by `ViewpointGeneration`'s `PartFieldSegmentation` for AI-based mesh part segmentation (`src/ViewpointGeneration/.../partfield_segmentation.py`, invoked as a subprocess per segmentation call).

This stack supports GPUs from Ampere through Blackwell (RTX 50-series). One thing to know if you touch this again: `torch_scatter`'s prebuilt wheel only ships native CUDA kernels up to `sm_90` (Hopper) — on `sm_120` (Blackwell) it silently falls back to JIT-compiling ancient `sm_50` PTX via the CUDA driver. The Dockerfile instead builds `torch_scatter` from source with `TORCH_CUDA_ARCH_LIST="8.6;12.0"` (Ampere + Blackwell) so both machine types get native kernels. `MAX_JOBS` is capped during that build to avoid OOM from parallel `nvcc` invocations.

Our PartField fork (`models/models.repos` → `cacton77/PartField`) carries two compatibility fixes needed for this newer torch/matplotlib combo:
- `torch.serialization.add_safe_globals([CfgNode])` for PyTorch's `weights_only=True` default in `torch.load`
- `matplotlib.colormaps[...].resampled(...)` replacing the removed `plt.cm.get_cmap`

---

## Workspace Layout Inside the Container

| Path | Description |
|---|---|
| `/workspaces/base_ws` | MoveIt2 built from source on Humble (image layer, read-only at runtime) |
| `/workspaces/shared_ws/src` | Inspection cell packages (bind-mounted from `./src`) |
| `/data` | Viewpoint generation data (bind-mounted from `./data`) |
| `/models` | PartField and other models (bind-mounted from `./models`); added to `PYTHONPATH` |
| `/config` | DDS and RViz config (bind-mounted from `./config`) |

The entrypoint sources workspaces in order: ROS2 → `base_ws` → `shared_ws` (building `shared_ws` first if it hasn't been built yet).

---

## Updating Packages

To pull the latest changes for all packages:

```bash
cd src && vcs pull        # ROS2 packages
cd ../data && vcs pull    # Data repositories
cd ../models && vcs pull  # Model repositories
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

- [`JAZZY_MIGRATION.md`](JAZZY_MIGRATION.md) — handoff notes from the Humble → Jazzy migration, including an unresolved `moveit_servo` regression
- [`ISAAC_SIM_INTEGRATION.md`](ISAAC_SIM_INTEGRATION.md) — plan for integrating Isaac Sim 5.0 as a simulation backend
