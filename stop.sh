#!/bin/bash

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR" || exit 1

if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

CONTAINER_NAME="${CONTAINER_NAME:-ros2-docker-template}"
COMPOSE_PROFILE="${COMPOSE_PROFILE:-linux}"

if [ "$USE_SERVICE" = "true" ]; then
    SERVICE_NAME="${CONTAINER_NAME}.service"
    if systemctl list-unit-files "$SERVICE_NAME" >/dev/null 2>&1 \
       && systemctl is-active --quiet "$SERVICE_NAME"; then
        echo "Stopping $SERVICE_NAME..."
        sudo systemctl stop "$SERVICE_NAME"
    fi
fi

COMPOSE_CMD="docker compose --profile $COMPOSE_PROFILE"

echo "Stopping any existing '$CONTAINER_NAME' containers..."
$COMPOSE_CMD down --remove-orphans

for _ in 1 2 3 4 5 6 7 8 9 10; do
    mapfile -t STALE < <(docker ps -aq --filter "name=^${CONTAINER_NAME}")
    [ ${#STALE[@]} -eq 0 ] && break
    sleep 1
done
if [ ${#STALE[@]} -gt 0 ]; then
    docker rm -f "${STALE[@]}" >/dev/null 2>&1 || true
fi
