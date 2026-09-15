#!/bin/bash
# Runs scripts/publish-ready.mjs on the Railway production box.
# Ceremony writes happen only inside the standalone CLIs that the script
# spawns on the box; this wrapper itself performs no provider writes.
set -uo pipefail
cd "$(dirname "$0")/.."
exec npx -y @railway/cli@latest ssh \
  --project f8c050c9-11c3-4611-8805-092289941aa4 \
  --environment production \
  --service product-pipeline \
  "cd /app && node --input-type=module -e \"$(sed 's/"/\\"/g' scripts/publish-ready.mjs)\""
