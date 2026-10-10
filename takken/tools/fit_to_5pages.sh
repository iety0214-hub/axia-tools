#!/usr/bin/env bash
# fit_to_5pages.sh — ページ上限に収まる最大スケールを自動採用して docx/pdf を生成する
#
#   TAKKEN_TITLE     タイトル（必須級。generate_takken_docx.js へ渡す）
#   TAKKEN_MAXPAGES  ページ上限（既定5。20問=5／45問=12／50問=13）
#
# 使い方:
#   TAKKEN_TITLE="…" TAKKEN_MAXPAGES=5 bash fit_to_5pages.sh
#
# 仕組み:
#   scale を 1.00 → 0.95 → … と下げながら、スケールごとに作業サブディレクトリ
#   fit_<scale>/ を切って docx 生成 → PDF変換 → ページ数判定を繰り返す。
#   （同名PDFへの上書き変換で soffice が IOエラー(Code:27) を出すのを避けるため）
#   問題編・解答解説編がともに上限以内に収まった最初（＝最大）のスケールを採用し、
#   カレントディレクトリへ 問題編.docx/pdf・解答解説編.docx/pdf をコピーする。

set -uo pipefail

MAXPAGES="${TAKKEN_MAXPAGES:-5}"
SCALES=(1.00 0.95 0.90 0.85 0.80 0.75 0.70 0.65 0.60)
MARGINS=(1080 1080 1080 1080 900 900 720 720 720)

if [ ! -f questions.js ] || [ ! -f explanations.js ]; then
  echo "[E] questions.js / explanations.js がカレントにない" >&2
  exit 1
fi
if [ ! -f generate_takken_docx.js ]; then
  echo "[E] generate_takken_docx.js がカレントにない（assetsからコピーすること）" >&2
  exit 1
fi
if [ ! -d office ]; then
  echo "[E] office/ がない（cp -r /mnt/skills/public/docx/scripts/office .）" >&2
  exit 1
fi

pages_of() {
  python3 - "$1" <<'PY'
import subprocess, sys, re
try:
    out = subprocess.run(["pdfinfo", sys.argv[1]], capture_output=True, text=True).stdout
    m = re.search(r"Pages:\s+(\d+)", out)
    print(m.group(1) if m else 0)
except Exception:
    print(0)
PY
}

ADOPTED=""
for i in "${!SCALES[@]}"; do
  S="${SCALES[$i]}"
  M="${MARGINS[$i]}"
  D="fit_${S}"
  rm -rf "$D"; mkdir -p "$D"
  cp questions.js explanations.js generate_takken_docx.js "$D"/
  cp -r office "$D"/office
  [ -e node_modules ] && ln -sfn "$(cd "$(dirname node_modules)" && pwd)/node_modules" "$D/node_modules"

  ( cd "$D" && TAKKEN_SCALE="$S" TAKKEN_MARGIN="$M" node generate_takken_docx.js ) >/dev/null 2>&1
  if [ ! -f "$D/問題編.docx" ]; then
    echo "  scale=$S : docx生成に失敗"; continue
  fi

  ( cd "$D" && python3 -c "
from office.soffice import run_soffice
run_soffice(['--headless','--convert-to','pdf','問題編.docx','解答解説編.docx'])
" ) >/dev/null 2>&1

  PQ=$(pages_of "$D/問題編.pdf")
  PA=$(pages_of "$D/解答解説編.pdf")
  echo "  scale=$S margin=$M : 問題編=${PQ}P / 解答解説編=${PA}P (上限${MAXPAGES}P)"

  if [ "$PQ" -gt 0 ] && [ "$PA" -gt 0 ] && [ "$PQ" -le "$MAXPAGES" ] && [ "$PA" -le "$MAXPAGES" ]; then
    ADOPTED="$S"
    cp "$D/問題編.docx" "$D/解答解説編.docx" "$D/問題編.pdf" "$D/解答解説編.pdf" .
    break
  fi
done

if [ -z "$ADOPTED" ]; then
  echo "[E] 全スケールで上限${MAXPAGES}Pに収まらんかった。TAKKEN_MAXPAGES の指定値を確認すること" >&2
  echo "    （20問=5 / 45問=12 / 50問=13）" >&2
  exit 1
fi

echo "TAKKEN_ADOPTED_SCALE=${ADOPTED}"
