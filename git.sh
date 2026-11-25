#!/usr/bin/env bash
#
# Commit everything and push the current branch:   ./git.sh "what changed"
#
# It used to commit with the message "push fix" and push whatever branch you
# were on, main included. Now it wants a message and will not touch main (or a
# detached HEAD): make a branch, open a pull request.

set -euo pipefail

branch="$(git rev-parse --abbrev-ref HEAD)"
case "${branch}" in
  main | master | HEAD)
    echo "error: refusing to commit and push on '${branch}'. Create a branch first:" >&2
    echo "         git switch -c my-change" >&2
    exit 1
    ;;
esac

if [[ $# -lt 1 || -z "${1// /}" ]]; then
  echo "usage: ./git.sh \"commit message\"" >&2
  exit 2
fi

git pull --ff-only
git add -A
git status --short
git commit -m "$1"
git push -u origin "${branch}"
