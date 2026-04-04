#!/usr/bin/env bash
set -euo pipefail

docker run -it --rm \
  -v ~/.hermes:/opt/data \
  nousresearch/hermes-agent
