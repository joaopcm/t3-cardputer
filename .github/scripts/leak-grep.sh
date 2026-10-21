#!/bin/sh
set -u

status=0
matches=$(grep -rnE '[a-z0-9]\.ts\.net|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+|prod-[0-9a-f]+\.t3coderelay' --exclude-dir=node_modules --exclude-dir=.git "$@") || status=$?
case $status in
  1) ;;
  0)
    echo "homelab hostname, tailnet ip or relay url found in $*:" >&2
    echo "$matches" >&2
    exit 1
    ;;
  *)
    echo "leak grep errored on $* (exit $status), treating as a failure" >&2
    exit 1
    ;;
esac
