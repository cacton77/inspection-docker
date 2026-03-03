#!/bin/bash

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

exec "$SCRIPT_DIR/launch_container.sh" ros2 launch viewpoint_generation bringup.launch.py "$@"
