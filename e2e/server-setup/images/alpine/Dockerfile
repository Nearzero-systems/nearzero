# A test server for the setup suite (e2e/server-setup): plain Alpine without bash or an init
# system, signed in to as root with a key. It runs privileged so setup can install and start
# Docker inside it; start.sh lets that Docker Engine manage cgroups.
FROM alpine:3.22
RUN apk add --no-cache openssh-server \
 && ssh-keygen -A \
 && install -d -m 0700 /root/.ssh \
 && printf '%s\n' 'PermitRootLogin prohibit-password' >> /etc/ssh/sshd_config
COPY start.sh /usr/local/bin/start.sh
CMD ["/bin/sh", "/usr/local/bin/start.sh"]
