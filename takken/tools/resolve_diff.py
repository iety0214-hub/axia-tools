#!/usr/bin/env python3
"""
resolve_diff.py — 独立再解答（resolve.json）と元解答（explanations.js）の機械照合

takken-mondai-check スキル §2 手順4 で使う。
Claude の「たぶん元のが正しい」という追認を封じ、突き合わせをスクリプトに固定するためのもの。

前提
  resolve.json      … 元の explanations.js を見る前に書いた自力の答え（形式は data_format.md §4）
  explanations.js   … 元の解答解説データ

検出項目
  D1  件数不一致（部分照合は弾く。全問そろってから実行すること）
  D2  num の欠落・余分
  D3  正解記号（ans）の不一致          ← 最重要
  D4  肢ごとの ○× （marks）の不一致    ← 二重正解の温床

使い方
  python3 resolve_diff.py                        # resolve.json / explanations.js
  python3 resolve_diff.py resolve.json e.js

終了コード
  0 = 完全一致 / 1 = 不一致あり（web_search で条文を確定させてから裁定すること）
"""

import json
import subprocess
import sys
from pathlib import Path

MARKS = "アイウエ"

# Windows日本語環境（既定cp932）だと日本語の print() や subprocess の出力デコードで
# 文字化け・UnicodeDecodeErrorが起きるけん、標準入出力をUTF-8に固定する。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


def load_js(path: str):
    p = Path(path).resolve()
    if not p.exists():
        print(f"[E] ファイルが見つからん: {path}")
        sys.exit(1)
    out = subprocess.run(
        ["node", "-e", f"process.stdout.write(JSON.stringify(require({json.dumps(str(p))})))"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if out.returncode != 0:
        print(f"[E] {path} の読み込みに失敗:\n{out.stderr}")
        sys.exit(1)
    return json.loads(out.stdout)


def main() -> int:
    rf = sys.argv[1] if len(sys.argv) > 1 else "resolve.json"
    ef = sys.argv[2] if len(sys.argv) > 2 else "explanations.js"

    if not Path(rf).exists():
        print(f"[E] {rf} がない。先に自力の再解答を書き出すこと（元解説を見る前に）")
        return 1

    rs = json.loads(Path(rf).read_text(encoding="utf-8"))
    es = load_js(ef)

    diffs: list[str] = []

    if len(rs) != len(es):
        print("=" * 56)
        print(f"[D1] 件数不一致: resolve={len(rs)} / explanations={len(es)}")
        print(" 部分照合は認めない。全問そろえてから再実行すること。")
        print("=" * 56)
        return 1

    emap = {e.get("num"): e for e in es}
    rmap = {r.get("num"): r for r in rs}

    only_r = sorted(set(rmap) - set(emap))
    only_e = sorted(set(emap) - set(rmap))
    if only_r or only_e:
        diffs.append(f"D2 num不一致: resolveのみ={only_r} / explanationsのみ={only_e}")

    ans_ng = 0
    mark_ng = 0

    for n in sorted(set(rmap) & set(emap)):
        r, e = rmap[n], emap[n]
        ra, ea = r.get("ans", ""), e.get("ans", "")
        if ra != ea:
            ans_ng += 1
            diffs.append(f"D3 問{n} 正解不一致: 再解答={ra} / 元解答={ea}")
        rm, em = r.get("marks", []), e.get("marks", [])
        if len(rm) == 4 and len(em) == 4:
            for i in range(4):
                if rm[i] != em[i]:
                    mark_ng += 1
                    diffs.append(
                        f"D4 問{n} {MARKS[i]}の○×不一致: 再解答={rm[i]} / 元解答={em[i]}"
                    )
        else:
            diffs.append(f"D4 問{n} marksが4個でない: 再解答={len(rm)} / 元解答={len(em)}")

    print("=" * 56)
    print(f" resolve_diff.py  照合={len(rs)}問")
    print("=" * 56)
    if not diffs:
        print(" 不一致 0件（正解・肢の○×とも完全一致）")
        print("=" * 56)
        print(" → 内容面の裁定は不要。ただし条文番号・表現の点検は別途行うこと")
        return 0

    print(f" 不一致 {len(diffs)}件（正解ズレ{ans_ng} / 肢ズレ{mark_ng}）")
    for d in diffs:
        print("  " + d)
    print("=" * 56)
    print(" → 各不一致は web_search で条文を確定させてから裁定すること。")
    print("   『たぶん元のが正しい』で握りつぶさない。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
