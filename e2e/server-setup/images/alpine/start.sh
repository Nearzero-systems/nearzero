#!/bin/sh
# With cgroup v2 a group that holds processes can't hand controllers to child groups, so this
# container's own processes move into a child group first; a Docker Engine started later can
# then create its containers' groups beside it.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/start
  for pid in $(cat /sys/fs/cgroup/cgroup.procs); do
    echo "$pid" > /sys/fs/cgroup/start/cgroup.procs 2>/dev/null || true
  done
  for controller in $(cat /sys/fs/cgroup/cgroup.controllers); do
    echo "+$controller" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
  done
fi
exec /usr/sbin/sshd -D -e
