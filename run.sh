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

COMPOSE_CMD="docker compose --profile $COMPOSE_PROFILE"

echo "Stopping any existing '$CONTAINER_NAME' containers..."
$COMPOSE_CMD down --remove-orphans
mapfile -t STALE < <(docker ps -aq --filter "name=^${CONTAINER_NAME}")
if [ ${#STALE[@]} -gt 0 ]; then
    docker rm -f "${STALE[@]}" >/dev/null
fi

# --- X11 access for the in-container GUI (gui_node / RViz) -------------------
# docker-compose.yaml bind-mounts /tmp/.docker.xauth (XAUTHORITY) and inherits
# $DISPLAY, but nothing creates that cookie -- so a fresh host has no valid X
# authorization and the Open3D GUI dies with "Failed to open X display".
#
# Gotcha this heals: if the path didn't exist as a *file* when Docker first
# created the bind mount, Docker made it a *directory* (usually root-owned),
# after which xauth can't write it. We remove any such directory and recreate
# the cookie as a file, before compose 'up'.
XAUTH=/tmp/.docker.xauth
if [ -d "$XAUTH" ]; then
    echo "Healing $XAUTH (it is a directory; it must be a file)..."
    rm -rf "$XAUTH" 2>/dev/null || sudo rm -rf "$XAUTH" 2>/dev/null || true
fi
if [ -d "$XAUTH" ]; then
    echo "ERROR: $XAUTH is a directory and could not be removed. Remove it manually:"
    echo "       sudo rm -rf $XAUTH"
fi
touch "$XAUTH" 2>/dev/null || true
chmod 644 "$XAUTH" 2>/dev/null || true

if [ -n "$DISPLAY" ] && command -v xauth >/dev/null 2>&1; then
    # When invoked via sudo, root has no X cookie -- read it from the invoking
    # user's session instead. Merge with a wildcard hostname so the cookie is
    # valid regardless of the container's hostname.
    SRC_XAUTH="$XAUTHORITY"
    if [ -z "$SRC_XAUTH" ] && [ -n "$SUDO_USER" ]; then
        SRC_XAUTH="$(getent passwd "$SUDO_USER" | cut -d: -f6)/.Xauthority"
    fi
    if [ -n "$SRC_XAUTH" ] && [ -f "$SRC_XAUTH" ]; then
        XAUTHORITY="$SRC_XAUTH" xauth nlist "$DISPLAY" 2>/dev/null \
            | sed -e 's/^..../ffff/' | xauth -f "$XAUTH" nmerge - 2>/dev/null || true
    else
        xauth nlist "$DISPLAY" 2>/dev/null | sed -e 's/^..../ffff/' \
            | xauth -f "$XAUTH" nmerge - 2>/dev/null || true
    fi
    chmod 644 "$XAUTH" 2>/dev/null || true
    # Host-based access for local clients -- the reliable fallback that works
    # even when no cookie could be sourced (e.g. Wayland/Xwayland).
    command -v xhost >/dev/null 2>&1 && xhost +local: >/dev/null 2>&1 || true
    export DISPLAY
elif [ -z "$DISPLAY" ]; then
    echo "WARNING: \$DISPLAY is not set -- the GUI (gui_node) will fail to open a display."
    echo "         Set DISPLAY to your X server (e.g. 'export DISPLAY=:0'), or run headless:"
    echo "         ./run.sh headless_mode:=true"
fi

exec "$SCRIPT_DIR/connect.sh" ros2 launch viewpoint_generation bringup.launch.py "$@"
