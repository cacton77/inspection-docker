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
COMPOSE_PROFILE="${COMPOSE_PROFILE:-linux}"
COMPOSE_SERVICE="${COMPOSE_SERVICE:-linux}"

COMPOSE_CMD="docker compose --profile $COMPOSE_PROFILE"

# Ensure the Qt/XDG runtime directory exists and is owned by the container user
RUNTIME_DIR="/tmp/runtime-${USERNAME:-macs}"
mkdir -p "$RUNTIME_DIR" 2>/dev/null || true
if [ "$(stat -c %u "$RUNTIME_DIR")" != "${UID:-1000}" ]; then
    sudo chown "${UID:-1000}:${UID:-1000}" "$RUNTIME_DIR"
fi

# Check if a container is already running (exact match or compose run pattern)
RUNNING_CONTAINER=$(docker ps --format '{{.Names}}' | grep -E "^${CONTAINER_NAME}(-.*-run-.*)?$" | head -n 1)

TTY_FLAG=""
[ -t 0 ] && TTY_FLAG="-it"
if [ -n "$RUNNING_CONTAINER" ]; then
    echo "Container '$RUNNING_CONTAINER' is already running. Executing bash..."
    if [ $# -eq 0 ]; then
        docker exec $TTY_FLAG "$RUNNING_CONTAINER" bash -c "source /entrypoint.sh && exec bash"
    else
        docker exec $TTY_FLAG "$RUNNING_CONTAINER" bash -c "source /entrypoint.sh && $*"
    fi
else
    echo "Starting container '$CONTAINER_NAME' (profile: $COMPOSE_PROFILE)..."
    if [ $# -eq 0 ]; then
        $COMPOSE_CMD run --rm "$COMPOSE_SERVICE" /bin/bash
    else
        $COMPOSE_CMD run --rm "$COMPOSE_SERVICE" "$@"
    fi
fi
