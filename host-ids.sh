# shellcheck shell=bash
# Sourced (not executed) by install.sh / run.sh / connect.sh / stop.sh to make
# the host user's real UID and GID available to docker compose.
#
# Why this exists:
#   docker-compose.yaml interpolates ${HOST_UID}/${HOST_GID} into the image
#   build args (so useradd bakes a matching user) and into the container's
#   `user:` at runtime. Compose reads those from its *process environment*.
#   The obvious choice, ${UID}/${GID}, does NOT work: UID is a bash-internal,
#   readonly, NON-exported variable, so a child `docker compose` never receives
#   it and silently falls back to 1000 -- breaking every host whose UID != 1000
#   (bind-mounted files under models/, data/, src/ become unwritable in-container).
#
# Using distinct, exported names sidesteps the readonly/non-export trap.
# Order of precedence: an explicit override, then the invoking user under sudo
# (SUDO_UID/SUDO_GID), then the current user.

: "${HOST_UID:=${SUDO_UID:-$(id -u)}}"
: "${HOST_GID:=${SUDO_GID:-$(id -g)}}"
export HOST_UID HOST_GID
