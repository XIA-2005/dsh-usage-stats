#!/bin/bash
# client bundle：src/client/index.ts → lib/client.js（tsdown 打成 CJS + ModuleLoader 包装）
#
# tsdown 探测：本地 node_modules → DSH_CHECKOUT（两条路径都不需要额外配置）
#   A. npm install --ignore-scripts   → devDependencies 里的 tsdown
#   B. export DSH_CHECKOUT=...        → 复用检出里的 tsdown
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TSDOWN=""
if [ -f "node_modules/.bin/tsdown" ] || [ -f "node_modules/.bin/tsdown.cmd" ]; then
  TSDOWN="node_modules/.bin/tsdown"
fi

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi

if [ -z "$TSDOWN" ] && [ -n "$CHECKOUT" ] && [ -f "$CHECKOUT/node_modules/.bin/tsdown" ]; then
  TSDOWN="$CHECKOUT/node_modules/.bin/tsdown"
  echo "=== Using tsdown from checkout: $CHECKOUT ==="
fi

if [ -z "$TSDOWN" ]; then
  echo "build-client: 找不到 tsdown，二选一 ——" >&2
  echo "  npm install --ignore-scripts                  # 用本地 devDependencies" >&2
  echo "  export DSH_CHECKOUT=/path/to/deepseek-harness # 复用检出的 tsdown" >&2
  exit 1
fi

echo "=== Bundling client → lib/client.js ==="
"$TSDOWN"
echo "=== Client bundle complete ==="