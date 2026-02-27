# Inspection Docker

A Docker-based deployment environment for the MACS Lab inspection cell. This repo sets up a standardized ROS2 Humble workspace with MoveIt2 (built from source), clones all inspection cell packages, and provides desktop shortcuts for one-click bringup and development workflows.

---

## Overview

The container is built on `osrf/ros:humble-desktop-full` and includes:

- **MoveIt2** built from source (baked into the image layer)
- **CycloneDDS** as the ROS2 middleware
- **Universal Robots** and **Intel RealSense** drivers
- A **shared workspace** (`shared_ws/`) mounted from the host, containing all inspection cell packages
- A **data directory** (`data/`) mounted from the host, containing viewpoint generation data via Git LFS

---

## Repository Structure

```
inspection-docker/
├── .env                          # Container name, ROS domain ID, GPU flag
├── install.sh                    # One-time setup script
├── launch_container.sh           # Start or attach to the container
├── run.sh                        # Start container in detached mode and run bringup
├── bringup.desktop               # Desktop shortcut: Inspection Bringup
├── devel.desktop                 # Desktop shortcut: Inspection Development
├── docker-compose.yaml           # Main Docker Compose file
├── docker-compose.nvidia.yaml    # NVIDIA GPU overlay (merged when USE_GPU=true)
├── docker/
│   ├── Dockerfile                # Image definition
│   ├── entrypoint.sh             # Sources ROS2, base_ws, and shared_ws on shell startup
│   ├── bringup_entrypoint.sh     # Builds shared_ws and launches bringup.launch.py
│   ├── packages.txt              # APT packages installed into the base image
│   ├── overlay_packages.txt      # APT packages for the overlay (UR, RealSense)
│   └── requirements.txt          # Python pip packages
├── config/
│   └── cyclonedds.xml            # CycloneDDS tuning (buffer sizes, multicast)
├── shared_ws/
│   ├── shared.repos              # vcstool manifest for inspection cell packages
│   └── src/                      # Cloned packages (created by install.sh)
└── data/
    ├── data.repos                # vcstool manifest for data repositories
    └── ViewpointGenerationData/  # Git LFS data (cloned by install.sh)
```

---

## ROS2 Packages

All packages are cloned into `shared_ws/src/` by `install.sh` using vcstool.

| Package | Repository | Branch |
|---|---|---|
| [ViewpointGeneration](https://github.com/cacton77/ViewpointGeneration) | cacton77/ViewpointGeneration | `devel` |
| [Inspection_Cell](https://github.com/DevanshB99/Inspection_Cell) | DevanshB99/Inspection_Cell | `main` |
| [Inspection_Control](https://github.com/antara1005/Inspection_Control) | antara1005/Inspection_Control | `main` |
| [Turntable_ROS2_Driver](https://github.com/DevanshB99/Turntable_ROS2_Driver) | DevanshB99/Turntable_ROS2_Driver | `ESP32` |
| [http_image_publisher](https://github.com/cacton77/http_image_publisher) | cacton77/http_image_publisher | `main` |

### Data Repositories

Large data assets are stored in Git LFS and cloned into `data/`.

| Repository | Branch |
|---|---|
| [ViewpointGenerationData](https://github.com/cacton77/ViewpointGenerationData) | `main` |

---

## Prerequisites

- [Docker](https://docs.docker.com/engine/install/) with the Compose plugin
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) (if using GPU)
- `terminator` terminal emulator (used by desktop shortcuts)

---

## Installation & Building

`install.sh` is the main script for both initial setup and rebuilding the workspace during development:

```bash
./install.sh
```

The script will:
1. Auto-detect an NVIDIA GPU (override with `--gpu` or `--no-gpu`)
2. Build (or rebuild) the Docker image
3. Install `vcstool` and `git-lfs` if not present
4. Clone all packages from `shared.repos` into `shared_ws/src/` (skipped if `src/` already exists)
5. Clone data repositories from `data.repos` and pull Git LFS objects
6. Create desktop shortcuts (`bringup.desktop`, `devel.desktop`) on `~/Desktop`
7. Increase kernel socket buffer limits for DDS performance
8. Build `shared_ws` inside the container

```bash
# Force GPU support
./install.sh --gpu

# Disable GPU support
./install.sh --no-gpu
```

Re-running `install.sh` during development will rebuild the Docker image (using cache) and rebuild `shared_ws`, making it the standard way to apply source changes.

---

## Usage

### Interactive Development Shell

Open a bash shell inside the container (starts the container if not already running):

```bash
./launch_container.sh
```

If the container is already running, this attaches a new shell to it. Additional arguments are passed as a command:

```bash
./launch_container.sh colcon build
./launch_container.sh ros2 topic list
```

### Bringup

Start the full inspection cell bringup (launches `viewpoint_generation bringup.launch.py`):

```bash
./run.sh
```

This starts the container in detached mode if needed, then attaches and runs the bringup launch file.

### Desktop Shortcuts

After running `install.sh`, two shortcuts appear on the desktop:

- **Inspection Bringup** — opens a terminal and runs the bringup launch file
- **Inspection Development** — opens an interactive development shell

---

## Configuration

### `.env`

Key environment variables read by `launch_container.sh` and Docker Compose:

| Variable | Default | Description |
|---|---|---|
| `CONTAINER_NAME` | `inspection-docker` | Docker container/image name |
| `ROS_DOMAIN_ID` | `2` | ROS2 domain ID |
| `USE_GPU` | `true` | Enable NVIDIA GPU passthrough |

### CycloneDDS

`config/cyclonedds.xml` is mounted into the container at `/config/cyclonedds.xml` and configures CycloneDDS with tuned socket buffer sizes (10 MB send/receive) for high-bandwidth image topics.

---

## Workspace Layout Inside the Container

| Path | Description |
|---|---|
| `/workspaces/base_ws` | MoveIt2 built from source (image layer, read-only at runtime) |
| `/workspaces/shared_ws` | Inspection cell packages (bind-mounted from `./shared_ws`) |
| `/data` | Viewpoint generation data (bind-mounted from `./data`) |
| `/config` | CycloneDDS and other runtime config (bind-mounted from `./config`) |

The entrypoint sources workspaces in order: ROS2 → `base_ws` → `shared_ws`.

---

## Updating Packages

To pull the latest changes for all packages in `shared_ws`:

```bash
cd shared_ws/src
vcs pull
```

Then re-run `install.sh` to rebuild the workspace:

```bash
./install.sh
```

Or rebuild directly inside the container without going through the full install:

```bash
./launch_container.sh colcon build
```
