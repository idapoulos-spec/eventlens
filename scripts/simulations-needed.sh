#!/usr/bin/env bash
# Whether the slow simulations (pnpm test:sim) need to run for a branch: they do when, since it left
# <base>, it changes a path listed in .github/simulation-inputs.txt (this checkout's copy). package.json
# counts unless the only change is its "version", so a release's version bump doesn't run them.
# Prints why. CI's "Simulations needed?" job runs this on every push to a branch other than main.
#
#   bash scripts/simulations-needed.sh [base, default origin/main] [head, default HEAD]
#
# Exit status: 0 they need to run, 1 they don't, 2 it couldn't tell (CI then runs them).
set -uo pipefail

base=${1:-origin/main}
head=${2:-HEAD}
list=.github/simulation-inputs.txt

cd "$(git rev-parse --show-toplevel)" || exit 2

fork=$(git merge-base "$base" "$head") || { echo "Couldn't find where $head left $base."; exit 2; }
paths=$(grep -Ev '^[[:space:]]*(#|$)' "$list") || { echo "Couldn't read $list."; exit 2; }

# The entries are git pathspecs: keep the shell from expanding them.
set -f
# shellcheck disable=SC2086
changed=$(git diff --name-only "$fork" "$head" -- $paths) || { echo "Couldn't compare $head with $base."; exit 2; }
set +f

if printf '%s\n' "$changed" | grep -qx package.json; then
  before=$(git show "$fork:package.json" | jq -S 'del(.version)') || { echo "Couldn't read package.json."; exit 2; }
  after=$(git show "$head:package.json" | jq -S 'del(.version)') || { echo "Couldn't read package.json."; exit 2; }
  if [ "$before" = "$after" ]; then
    changed=$(printf '%s\n' "$changed" | grep -vx package.json)
  fi
fi

if [ -z "$changed" ]; then
  echo "This branch changes none of the simulations' inputs since it left $base ($list; package.json apart from its version)."
  exit 1
fi

count=$(printf '%s\n' "$changed" | wc -l | tr -d ' ')
shown=$(printf '%s\n' "$changed" | head -n 10 | paste -s -d ',' - | sed 's/,/, /g')
more=""
if [ "$count" -gt 10 ]; then more=", and $((count - 10)) more"; fi
echo "This branch changes $count of the simulations' inputs since it left $base: $shown$more."
exit 0
