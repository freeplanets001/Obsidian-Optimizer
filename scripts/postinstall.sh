#!/bin/bash
# PKGインストール後にquarantine属性を除去するスクリプト
# これにより「破損しているか不完全」エラーを防止する

APP_PATH="/Applications/Obsidian Optimizer.app"

if [ -d "$APP_PATH" ]; then
    # dot_cleanでリソースフォーク除去
    dot_clean "$APP_PATH" 2>/dev/null || true

    # quarantine属性を除去
    xattr -cr "$APP_PATH" 2>/dev/null || true

    # 権限を修正
    chmod -R a+rX "$APP_PATH" 2>/dev/null || true

    echo "Obsidian Optimizer: postinstall completed"
fi

exit 0
