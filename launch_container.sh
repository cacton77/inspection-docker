#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR" || exit 1

# Load environment variables
if [ -f .env ]; then
    source .env
fi

# Default container name if not set
CONTAINER_NAME="${CONTAINER_NAME:-ros2-docker-template}"

# Build compose command based on GPU setting
COMPOSE_CMD="docker compose -f docker-compose.yaml"
if [ "$USE_GPU" = "true" ]; then
    COMPOSE_CMD="$COMPOSE_CMD -f docker-compose.nvidia.yaml"
fi

# Check if a container is already running (exact match or compose run pattern)
RUNNING_CONTAINER=$(docker ps --format '{{.Names}}' | grep -E "^${CONTAINER_NAME}(-app-run-.*)?$" | head -n 1)

if [ -n "$RUNNING_CONTAINER" ]; then
    echo "Container '$RUNNING_CONTAINER' is already running. Executing bash..."
    if [ $# -eq 0 ]; then
        docker exec -it "$RUNNING_CONTAINER" /bin/bash
    else
        # Source entrypoint directly (not .bashrc which has non-interactive guard)
        docker exec -it "$RUNNING_CONTAINER" /bin/bash -c "source /entrypoint.sh && $*"
    fi
else
    echo "Starting container '$CONTAINER_NAME'..."
    if [ "$USE_GPU" = "true" ]; then
        echo "GPU support: enabled"
    else
        echo "GPU support: disabled"
    fi
    if [ $# -eq 0 ]; then
        $COMPOSE_CMD run --rm app /bin/bash
    else
        # Don't use "bash -c" wrapper - let entrypoint handle environment and run command directly
        $COMPOSE_CMD run --rm app "$@"
    fi
fi
