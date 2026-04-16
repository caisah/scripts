#!/usr/bin/env bash
set -euo pipefail

# update brew
brew update
# upgrade packages
brew upgrade
# upgrade cask packages
brew upgrade --cask
# remove any unused homebrew stuff
brew cleanup
# update all global packages
vp update -g
