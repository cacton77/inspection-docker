#!/bin/bash
# Basic entrypoint for ROS / Colcon Docker containers
#
# Runs two ways:
#   - executed, as the container's ENTRYPOINT: once per new container
#     (connect.sh / run.sh starting one). Runs an incremental colcon build of
#     the host-mounted workspace, then execs the command.
#   - sourced, from ~/.bashrc and by connect.sh when attaching to a running
#     container: only sources the workspaces (building only if nothing has
#     been built yet), so opening a shell never triggers a rebuild.

# Source ROS 2
source /opt/ros/${ROS_DISTRO}/setup.bash

# Source the base workspace, if built
if [ -f /workspaces/base_ws/install/setup.bash ]
then
    source /workspaces/base_ws/install/setup.bash
fi

# The overlay workspace (./ros2_ws on the host) keeps build/, install/ and
# log/ between containers, so this build only redoes packages that changed.
build_ros2_ws() {
    if (cd /workspaces/ros2_ws && colcon build); then
        echo "✓ Shared workspace built"
    else
        echo "⚠ Shared workspace build failed"
    fi
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "Building shared workspace (incremental)..."
    build_ros2_ws
elif [ ! -f /workspaces/ros2_ws/install/setup.bash ]; then
    echo "Shared workspace not found. Building shared workspace..."
    build_ros2_ws
fi

if [ -f /workspaces/ros2_ws/install/setup.bash ]
then
    source /workspaces/ros2_ws/install/setup.bash
fi

# Middleware selection. Honors RMW_IMPLEMENTATION from the environment
# (set via docker-compose / .env). Defaults to CycloneDDS if unset.
export RMW_IMPLEMENTATION=${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}

exec "$@"
