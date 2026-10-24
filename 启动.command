#!/bin/bash
# 双击即可启动。第一次运行若提示「无法打开」，右键 → 打开。
cd "$(dirname "$0")" || exit 1

# 有些终端环境会残留这个变量，它会让 Electron 以纯 Node 模式运行、不弹窗。
unset ELECTRON_RUN_AS_NODE

if [ ! -x ./node_modules/.bin/electron ]; then
  echo "缺少运行环境，请先执行：npm install"
  read -r -p "按回车关闭…" _
  exit 1
fi

exec ./node_modules/.bin/electron . "$@"
