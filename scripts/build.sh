#!/bin/bash
# 构建：src/ → lib/（host 用 tsc；client 另跑 npm run build:client）
#
# 两条路径，任选其一 —— 不再强制要求 DSH 源码检出：
#
#   A. 免检出（推荐给使用者）
#      npm install --ignore-scripts     # 只装 typescript / @types/node
#      bash scripts/build.sh
#
#   B. 有 DSH 源码检出（开发者，复用检出里的 tsc）
#      export DSH_CHECKOUT=/path/to/deepseek-harness
#      bash scripts/build.sh
#
# 为什么不需要检出：host 源码只 import node:fs / node:os / node:path，一个
# `@deepseek-ai/*` 值都不引（服务一律经 ctx 取用），client 侧用本地 react.d.ts
# 声明类型。所以旧版那一大段 junction 链接（cordis / dsh-tools / dsh-llm /
# schemastery …）对编译没有任何作用，只会在别人机器上变成一道装不上的门槛。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# tsc 探测：本地 node_modules → DSH_CHECKOUT
TSC=""
if [ -f "node_modules/.bin/tsc" ] || [ -f "node_modules/.bin/tsc.cmd" ]; then
  TSC="node_modules/.bin/tsc"
fi

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi

if [ -z "$TSC" ]; then
  if [ -n "$CHECKOUT" ] && [ -f "$CHECKOUT/node_modules/.bin/tsc" ]; then
    TSC="$CHECKOUT/node_modules/.bin/tsc"
    echo "=== Using tsc from checkout: $CHECKOUT ==="
  else
    echo "build: 找不到 tsc，二选一 ——" >&2
    echo "  npm install --ignore-scripts                       # 用本地 devDependencies" >&2
    echo "  export DSH_CHECKOUT=/path/to/deepseek-harness      # 复用检出的 tsc" >&2
    exit 1
  fi
fi

# 可选：有检出且本地没装 @types/node 时，借用检出里的类型声明。
# 缺失一律跳过（不是错误）——编译真正需要的只有 node 类型。
link_if_missing() {
  local link="node_modules/$1"
  local target="$2"
  if [ -e "$link" ]; then return 0; fi
  if [ ! -e "$target" ]; then
    echo "build: 跳过 $1（目标不存在：$target）" >&2
    return 0
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$link" "$target"
}

if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/packages" ]; then
  echo "=== Linking node types (checkout: $CHECKOUT) ==="
  link_if_missing @types/node "$CHECKOUT/node_modules/@types/node"
fi

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json
echo "=== Build complete ==="
