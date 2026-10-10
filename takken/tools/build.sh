#!/usr/bin/env bash
# build.sh — 1セット分を チェック → 照合 → PDF化 → 所定の名前で保存 まで一括実行する
#
# 使い方（takken/tools で実行）:
#   bash build.sh <セットdir> "<タイトル括弧内>" <出力名の科目> <回>
# 例:
#   bash build.sh ../2026予想/src/gyoho5 "宅建業法・第5回" 宅建業法 第5回
#   → ../2026予想/問題編_宅建業法_2026予想_第5回.pdf / 解答解説編_… を上書き
#
# 環境変数:
#   TAKKEN_MAXPAGES  ページ上限（既定5。45問=12）
#   TAKKEN_FONT      フォント名（既定 IPAGothic。Mac は "Hiragino Sans" 等）
set -euo pipefail

if [ $# -lt 4 ]; then
  sed -n '2,12p' "$0"; exit 1
fi
SRC="$(cd "$1" && pwd)"; LABEL="$2"; SUBJ="$3"; ROUND="$4"
TOOLS="$(cd "$(dirname "$0")" && pwd)"
OUTDIR="$(cd "$TOOLS/../2026予想" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/takken_build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

command -v soffice >/dev/null || { echo "[E] soffice が PATH にない（LibreOffice を入れてね）" >&2; exit 1; }
[ -d "$TOOLS/node_modules/docx" ] || (cd "$TOOLS" && npm install --silent)

cp "$SRC"/questions.js "$SRC"/explanations.js "$WORK"/
[ -f "$SRC/resolve.json" ] && cp "$SRC/resolve.json" "$WORK"/
cp "$TOOLS"/{generate_takken_docx.js,fit_to_5pages.sh,check_consistency.py,resolve_diff.py} "$WORK"/
cp -r "$TOOLS/office" "$WORK"/office
ln -s "$TOOLS/node_modules" "$WORK/node_modules"

cd "$WORK"
echo "== 形式チェック"; python3 check_consistency.py | tail -4
if [ -f resolve.json ]; then echo "== 独立再解答との照合"; python3 resolve_diff.py | grep -E "不一致|D[0-9]"; fi
echo "== PDF化"
TAKKEN_TITLE="宅地建物取引士試験　2026年度予想問題（${LABEL}）" TAKKEN_MAXPAGES="${TAKKEN_MAXPAGES:-5}" bash fit_to_5pages.sh
cp 問題編.pdf "$OUTDIR/問題編_${SUBJ}_2026予想_${ROUND}.pdf"
cp 解答解説編.pdf "$OUTDIR/解答解説編_${SUBJ}_2026予想_${ROUND}.pdf"
echo "== 出力: $OUTDIR/{問題編,解答解説編}_${SUBJ}_2026予想_${ROUND}.pdf"
