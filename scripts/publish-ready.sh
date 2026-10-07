#!/bin/bash
# Runs scripts/publish-ready.mjs on the Railway production box.
# Ceremony writes happen only inside the standalone CLIs that the script
# spawns on the box; this wrapper itself performs no provider writes.
# Optional: PUBLISH_EXCLUDE_SKUS=SKU1,SKU2 skips those ready rows this run.
set -uo pipefail
cd "$(dirname "$0")/.."
EXCLUDE="${PUBLISH_EXCLUDE_SKUS:-}"
if [[ -n "$EXCLUDE" && ! "$EXCLUDE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(,[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$ ]]; then
  echo "PUBLISH_EXCLUDE_SKUS must be comma-separated eBay-legal SKUs" >&2
  exit 2
fi
exec npx -y @railway/cli@latest ssh \
  --project f8c050c9-11c3-4611-8805-092289941aa4 \
  --environment production \
  --service product-pipeline \
  "cd /app && PUBLISH_EXCLUDE_SKUS='$EXCLUDE' node --input-type=module -e \"$(sed 's/"/\\"/g' scripts/publish-ready.mjs)\""
