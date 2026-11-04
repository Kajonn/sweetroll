#!/bin/sh
set -eu

# Railway volumes arrive owned by root. Initialize only the configured private
# media directories, then run the application as the existing node user.
if [ "$(id -u)" = "0" ]; then
  media_dir=${SWEETROLL_MEDIA_DIR:-/app/data/media}
  display_dir=${SWEETROLL_DISPLAY_DIR:-/app/data/display}
  mkdir -p "$media_dir" "$display_dir"
  chown node:node "$media_dir" "$display_dir"
  exec su-exec node "$@"
fi
exec "$@"
