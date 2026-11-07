#!/usr/bin/env bash
set -euo pipefail

# Shared by journey/visual and offline jobs. An optional root supports isolated
# fixture verification without writing the machine's apt configuration.
# Ubuntu runners also use mirror+file transport: its .txt lists must be updated.
apt_root="${1:-/etc/apt}"
find "$apt_root" -maxdepth 2 -type f \( -name '*.list' -o -name '*.sources' -o -name 'apt-mirrors*.txt' \) \
  -exec sed -i 's|http://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' {} +
mkdir -p "$apt_root/apt.conf.d"
cat > "$apt_root/apt.conf.d/80-sweetroll-ci" <<'APT'
Acquire::Retries "2";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT
