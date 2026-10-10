# 宅建 2026年度予想問題

## フォルダ構成

```
takken/
├─ 2026予想/
│   ├─ 問題編_*.pdf / 解答解説編_*.pdf   … 完成品（14セット）
│   └─ src/<セット>/                       … 元データ
│        ├─ questions.js     問題（num, ask, text, items, choices）
│        ├─ explanations.js  正解・肢ごとの○×・解説・ひっかけ
│        └─ resolve.json     独立再解答（チェック用）
└─ tools/
    ├─ build.sh                 1セットを チェック→照合→PDF化 まで一括
    ├─ generate_takken_docx.js  docx生成（問題編・解答解説編）
    ├─ fit_to_5pages.sh         ページ上限に収まる倍率を自動採用してPDF化
    ├─ check_consistency.py     形式チェック（二重正解・周期パターン等）
    ├─ resolve_diff.py          resolve.json と explanations.js の照合
    ├─ mkresolve.py + specs/    再解答メモ（spec_*.txt）→ resolve.json 生成
    ├─ common_traps.md          ひっかけメモ
    └─ office/                  LibreOffice 呼び出し・docx検証ヘルパー
```

| src | 出力名 | タイトル括弧内 |
|---|---|---|
| gyoho1〜6 | 宅建業法 第1回〜第6回 | 宅建業法・第N回 |
| hourei1〜6 | 法令上の制限税 第1回〜第6回 | 法令上の制限・税・第N回 |
| kenri1 | 権利関係 法改正重点 | 権利関係・法改正重点 |
| kenri2 | 権利関係 第2回 | 権利関係・第2回 |

## ローカルで必要なもの

- Node.js 18 以上（`docx` パッケージは build.sh が初回に `npm install`）
- Python 3.9 以上
- LibreOffice（`soffice` に PATH を通す）
  - Mac: `brew install --cask libreoffice` のあと
    `export PATH="/Applications/LibreOffice.app/Contents/MacOS:$PATH"`
- poppler（`pdfinfo` でページ数を数える）
  - Mac: `brew install poppler` ／ Ubuntu: `sudo apt install poppler-utils`
- 日本語フォント
  - 既定は IPAGothic（Ubuntu: `sudo apt install fonts-ipafont-gothic`）
  - 入っていない場合は `TAKKEN_FONT="Hiragino Sans"`（Mac）や `TAKKEN_FONT="Yu Gothic"`（Windows）を指定

## 使い方

```bash
cd takken/tools
bash build.sh ../2026予想/src/gyoho5 "宅建業法・第5回" 宅建業法 第5回
bash build.sh ../2026予想/src/hourei6 "法令上の制限・税・第6回" 法令上の制限税 第6回
```

問題を直すときは、`src/<セット>/questions.js` と `explanations.js` を編集して build.sh を再実行します。
正解や○×を変えた場合は、`tools/specs/spec_*.txt` の該当行も直してから、resolve.json を作り直します。

```bash
cd takken/2026予想/src/gyoho5
python3 -I ../../../tools/mkresolve.py ../../../tools/specs/spec_g5.txt resolve.json ""
```

第3引数には、「誤っているもの」を問う設問の問番号をカンマ区切りで指定します（なければ空文字）。

## 新しいセットを作るとき

`src/` に新しいフォルダを作り、既存セットの questions.js / explanations.js を雛形にします。
Claude Code に頼む場合は、takken-mondai（作問）→ takken-mondai-check（検算）スキルの順で使います。
