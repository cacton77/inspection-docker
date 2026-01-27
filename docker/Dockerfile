ARG BASE_IMAGE=osrf/ros:humble-desktop-full
FROM ${BASE_IMAGE}

ARG ROS_DISTRO=humble
ENV ROS_DISTRO=${ROS_DISTRO}

# Install base dependencies
COPY docker/packages.txt /tmp/packages.txt
RUN apt-get update && \
    grep -v '^#' /tmp/packages.txt | grep -v '^$' | xargs apt-get install -y && \
    rm -rf /var/lib/apt/lists/* /tmp/packages.txt

# Update colcon to latest version via pip to ensure --allow-overriding support
RUN python3 -m pip install --upgrade colcon-common-extensions colcon-core

# Set up colcon mixins (check if default already exists)
RUN colcon mixin list | grep -q "default" || \
    colcon mixin add default https://raw.githubusercontent.com/colcon/colcon-mixin-repository/master/index.yaml && \
    colcon mixin update default

# Update rosdep (it should already be initialized in the base image)
RUN rosdep update

# Create base workspace
RUN mkdir -p /workspaces/base_ws/src
WORKDIR /workspaces/base_ws/src

# Clone base repositories


# Build the workspace without tests and with overrides
WORKDIR /workspaces/base_ws
RUN /bin/bash -c "source /opt/ros/${ROS_DISTRO}/setup.bash && \
    colcon build \
    --executor sequential \
    --cmake-args -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF"

# Install overlay dependencies
COPY docker/overlay_packages.txt /tmp/overlay_packages.txt
RUN apt-get update && \
    grep -v '^#' /tmp/overlay_packages.txt | grep -v '^$' | xargs apt-get install -y && \
    rm -rf /var/lib/apt/lists/* /tmp/overlay_packages.txt

COPY docker/requirements.txt /tmp/requirements.txt
RUN python3 -m pip install -r /tmp/requirements.txt --force-reinstall && rm /tmp/requirements.txt

# Install CycloneDDS
RUN apt-get update && apt-get install -y --no-install-recommends \
    ros-${ROS_DISTRO}-rmw-cyclonedds-cpp

# Clone shared workspace repositories
RUN mkdir -p /workspaces/shared_ws/src
RUN mkdir -p /data

# Create new user and add to video group
RUN apt-get update && apt-get install -y sudo && rm -rf /var/lib/apt/lists/*

ARG USERNAME=ros_user
ARG UID=1000
ARG GID=${UID}
ARG VIDEO_GID=44
ARG DIALOUT_GID=20

# Create the video group with the same GID as the host
RUN getent group video || groupadd --gid ${VIDEO_GID} video
RUN getent group dialout || groupadd --gid ${DIALOUT_GID} dialout

RUN groupadd --gid ${GID} ${USERNAME} \
    && useradd --uid ${UID} --gid ${GID} --create-home ${USERNAME} \
    && usermod -a -G video ${USERNAME} \
    && usermod -a -G dialout ${USERNAME} \
    # Give sudo permissions without password 
    && echo ${USERNAME} ALL=\(root\) NOPASSWD:ALL > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME} \
    && mkdir -p /home/${USERNAME} \
    && chown -R ${UID}:${GID} /home/${USERNAME}

# Set the ownership of the shared workspace to the new user
RUN chown -R ${UID}:${UID} /workspaces/shared_ws/
RUN chown -R ${UID}:${UID} /data/

# Set the user and source entrypoint in the user's .bashrc file
COPY ./docker/entrypoint.sh /
RUN chmod +x /entrypoint.sh
RUN echo "source /entrypoint.sh" >> /home/${USERNAME}/.bashrc

USER ${USERNAME}
ENTRYPOINT [ "/entrypoint.sh" ]