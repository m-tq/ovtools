#!/bin/sh
# Keep the node RPC on localhost; only the dashboard and local tools need it.
set -e
if command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT ! -i lo -p tcp --dport 8080 -j DROP 2>/dev/null \
    || iptables -I INPUT 1 ! -i lo -p tcp --dport 8080 -j DROP
fi
