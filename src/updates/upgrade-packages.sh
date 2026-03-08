#!/usr/bin/env bash
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  printf 'Error: Homebrew is not installed.\n' >&2
  exit 1
fi

brew update
brew upgrade
brew cleanup

if ! command -v npm >/dev/null 2>&1; then
  printf 'Skipping global Node module upgrades: npm is not installed.\n'
  exit 0
fi

npm_outdated="$(npm outdated -g --depth=0 --parseable 2>/dev/null || true)"

if [[ -z "${npm_outdated}" ]]; then
  printf 'Global Node modules are already up to date.\n'
  exit 0
fi

mapfile -t npm_packages < <(printf '%s\n' "${npm_outdated}" | cut -d: -f4 | sort -u)

latest_specs=()
for package in "${npm_packages[@]}"; do
  if [[ -n "${package}" ]]; then
    latest_specs+=("${package}@latest")
  fi
done

if [[ ${#latest_specs[@]} -eq 0 ]]; then
  printf 'Global Node modules are already up to date.\n'
  exit 0
fi

npm install -g "${latest_specs[@]}"
