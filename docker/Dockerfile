ARG BASE_IMAGE=osrf/ros:humble-desktop-full
FROM ${BASE_IMAGE}

ARG ROS_DISTRO=humble
ENV ROS_DISTRO=${ROS_DISTRO}

# Install MoveIt2 build dependencies
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

# Remove any pre-installed MoveIt packages to avoid conflicts
RUN apt-get update && \
    apt-get remove -y ros-${ROS_DISTRO}-moveit* || true && \
    rm -rf /var/lib/apt/lists/*

# Clone base repositories
RUN git clone https://github.com/ros-planning/moveit2.git -b main && \
    for repo in moveit2/moveit2.repos $(f="moveit2/moveit2.repos"; test -r $f && echo $f); do vcs import < "$repo"; done

# Fix issues with includes and servo node name
RUN sed -i 's/#include <types.h>/#include <sys\/types.h>/' \
    /workspaces/base_ws/src/moveit2/moveit_core/online_signal_smoothing/include/moveit/online_signal_smoothing/acceleration_filter.hpp

# Install dependencies (skip problematic packages)
RUN /bin/bash -c "source /opt/ros/${ROS_DISTRO}/setup.bash && \
    rosdep install -r --from-paths . --ignore-src --rosdistro ${ROS_DISTRO} -y \
    --skip-keys='ros-humble-ros-testing ros-humble-stomp ros-humble-topic-tools ros-humble-osqp-vendor ros-humble-launch-pytest ros-humble-rmf-utils ros-humble-ament-clang-format' || \
    echo 'Some dependencies failed to install but continuing with build...'"

RUN ln -sf /usr/include/sys/types.h /usr/include/types.h

# Build the workspace without tests and with overrides
# MAKEFLAGS='-j2' limits compiler parallelism to reduce RAM usage
# --parallel-workers 1 builds only one package at a time
WORKDIR /workspaces/base_ws
RUN /bin/bash -c "source /opt/ros/${ROS_DISTRO}/setup.bash && \
    MAKEFLAGS='-j2' colcon build \
    --executor sequential \
    --parallel-workers 1 \
    --allow-overriding moveit moveit_common moveit_configs_utils moveit_core moveit_hybrid_planning moveit_kinematics moveit_msgs moveit_planners moveit_planners_ompl moveit_resources_fanuc_moveit_config moveit_resources_panda_moveit_config moveit_ros_move_group moveit_ros_perception moveit_ros_planning moveit_ros_planning_interface moveit_ros_visualization moveit_servo moveit_simple_controller_manager \
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