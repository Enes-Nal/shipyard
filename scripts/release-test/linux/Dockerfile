# A fresh Ubuntu 24.04 machine for the Linux release tests
# (scripts/linux-box-test.sh, scripts/upgrade-test.sh --linux): systemd runs
# as init, so berthd installs as the systemd user service it is on a real
# box, for the user dev, with lingering on as install.sh asks for. Nothing
# of Terminal is in the image: the test installs it with site/install.sh.
# The same image, without systemd, is the laptop the box pairs with.
#   docker build -f scripts/release-test/linux/Dockerfile scripts/release-test
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
# What a box usually has (git, tmux, curl) and the sample project needs
# (Node.js); python3 serves the release archives to install.sh.
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session ca-certificates curl git tmux nodejs python3 sudo procps iproute2 \
    && rm -rf /var/lib/apt/lists/* \
    && (userdel -r ubuntu 2>/dev/null || true)
RUN useradd -m -u 1000 -s /bin/bash dev \
    && echo 'dev ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/dev \
    && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/dev
# The agent CLI and Chromium are stand-ins: no tokens, no 100 MB download.
COPY fake-claude /usr/local/bin/claude
COPY linux/fake-chromium /usr/local/bin/chromium
RUN chmod 755 /usr/local/bin/claude /usr/local/bin/chromium
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
