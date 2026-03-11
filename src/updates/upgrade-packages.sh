#!/usr/bin/env bash
set -euo pipefail

brew update
brew upgrade
brew cleanup
npm upgrade -g
