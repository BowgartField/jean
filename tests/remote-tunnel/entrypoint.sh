#!/bin/sh
set -eu

ssh-keygen -A >/dev/null
adduser -D -s /bin/sh jean
passwd -d jean >/dev/null
mkdir -p /run/sshd
install -d -m 700 -o jean -g jean /home/jean/.ssh
install -m 600 -o jean -g jean /tmp/test_key.pub /home/jean/.ssh/authorized_keys

sed -i 's/^AllowTcpForwarding .*/AllowTcpForwarding yes/' /etc/ssh/sshd_config
cat >>/etc/ssh/sshd_config <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers jean
PermitOpen any
EOF

node /opt/remote-tunnel-test/server.mjs &
exec /usr/sbin/sshd -D -e
