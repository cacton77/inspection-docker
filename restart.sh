#!/bin/bash

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR" || exit 1

if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

CONTAINER_NAME="${CONTAINER_NAME:-ros2-docker-template}"

if [ "$USE_SERVICE" = "true" ]; then
    sudo systemctl restart "${CONTAINER_NAME}.service"
else
    "$SCRIPT_DIR/stop.sh"
    "$SCRIPT_DIR/run.sh" "$@"
fi
