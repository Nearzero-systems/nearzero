# A test server for the setup suite (e2e/server-setup): Ubuntu 24.04 booting systemd, with SSH
# like a cloud image: root is refused with the image's message (written by the suite into root's
# authorized_keys), "ubuntu" has passwordless sudo, and "nosudo" has sudo only with a password.
# It runs privileged so setup can install Docker inside it. Password sign-in starts on, so the
# SSH hardening step has something to change. ufw is installed (the suite turns it on), so
# published ports can be seen opened in a host firewall (30b R2-13). unattended-upgrades is there
# as on a cloud image: its shutdown helper waits idle all the time, which must not make setup wait
# (C2-06); the daily apt timers are masked so no real package job runs during the suite.
FROM ubuntu:24.04
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus openssh-server sudo ca-certificates ufw unattended-upgrades \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty.target console-getty.service systemd-logind.service systemd-udevd.service \
      systemd-networkd-wait-online.service systemd-resolved.service \
      apt-daily.timer apt-daily-upgrade.timer \
 && systemctl enable unattended-upgrades.service \
 && systemctl enable ssh \
 && useradd -m -s /bin/bash nosudo \
 && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-cloud-init-users \
 && echo 'nosudo ALL=(ALL) ALL' > /etc/sudoers.d/nosudo \
 && chmod 0440 /etc/sudoers.d/90-cloud-init-users /etc/sudoers.d/nosudo \
 && install -d -m 0700 /root/.ssh \
 && install -d -m 0700 -o ubuntu -g ubuntu /home/ubuntu/.ssh \
 && install -d -m 0700 -o nosudo -g nosudo /home/nosudo/.ssh \
 && printf '%s\n' 'PasswordAuthentication yes' 'PermitRootLogin yes' > /etc/ssh/sshd_config.d/50-cloud-like.conf
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
