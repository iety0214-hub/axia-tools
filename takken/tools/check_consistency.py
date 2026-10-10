#!/usr/bin/env python3
"""
check_consistency.py — 宅建問題の形式面・整合性チェック（PDF化前に必須）

検出項目
  [E] エラー（1件でも残っている間はPDF化に進まない）
      E1  questions.js と explanations.js の件数不一致
      E2  num の欠番・重複・不一致
      E3  選択肢が4つでない
      E4  marks が4つでない / lines が4行でない
      E5  lines の先頭記号（ア＝○：等）が marks と食い違う
      E6  ans がア〜エ以外 / ans の位置の marks が問い方の向きと不一致
      E7  【二重正解】問い方に対して該当する肢が2つ以上ある
      E8  該当する肢が0（正解が存在しない）
      E9  二重否定表現の混入
      E10 同じ正解記号が3問以上連続
      E11 空の問題文・空の選択肢・空の trap
      E12 【周期パターン】正解順の一部（4〜n/2問幅のブロック）が直後にそのまま繰り返されている
          （2〜3問幅の短い繰り返し〔ア・イ・ア・イ等〕は偶然でも頻出する自然な揺らぎなので対象外）
          （例: 問9〜12が「イ・ア・エ・ウ」、問13〜16も同じ「イ・ア・エ・ウ」など。
          3連続同一（E10）はすり抜けるが、機械的な並びに見える典型パターン）

  [W] 警告（内容を確認して必要なら直す）
      W1  解説に条文番号らしき記載がない肢がある
      W2  正解記号の分布が偏っている（最多と最少の差が全問数の25%超）
      W3  選択肢が極端に短い（20文字未満）

使い方
  python3 check_consistency.py                 # カレントの questions.js / explanations.js
  python3 check_consistency.py q.js e.js       # ファイル指定

終了コード
  0 = エラーなし（警告は出ていてもよい） / 1 = エラーあり
"""

import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

MARKS = "アイウエ"
# E12で検出する最小のブロック幅。2〜3問幅はランダムな並びでも頻出するため対象外
# （均等分布のランダム30問で、最小2問幅だとE10通過分の約8割がE12で落ちる。4問幅なら約1割）。
MIN_PERIOD = 4

# Windows日本語環境（既定cp932）だと日本語の print() や subprocess の出力デコードで
# 文字化け・UnicodeDecodeErrorが起きるけん、標準入出力をUTF-8に固定する。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


def load_js(path: str):
    """module.exports = [...] 形式の JS を node 経由で JSON 化して読む。"""
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


def find_periodic_repeats(seq: list[str]) -> list[tuple[int, int, list[str]]]:
    """正解記号の並びの中に「同じ並びのブロックが直後にそのまま繰り返される」箇所を探す。

    例: [イ,ア,エ,ウ, イ,ア,エ,ウ] のように幅p（MIN_PERIOD〜len//2）のブロックが
    隣接してそっくり繰り返されている場合を検出する。単一記号だけの連続（アアア等）は
    E10（3連続同一）の担当なのでここでは除外する。

    周期は**大きい方から**先に探す。小さい方から探すと、たまたま隣接した偶然の
    短い一致（例：p=2）が先に「消費済み」として区間を専有してしまい、その内側に
    ある本来報告すべき大きい周期パターン（例：p=4）を覆い隠してしまうことがあるため
    （実際にランダム生成した検証データで再現した既知の落とし穴）。大きい周期を
    優先して見つければ、その内側の偶然の小さい一致は正しく「重複」として抑制される。
    """
    n = len(seq)
    found: list[tuple[int, int, list[str]]] = []
    covered: set[int] = set()
    for p in range(n // 2, MIN_PERIOD - 1, -1):
        for i in range(0, n - 2 * p + 1):
            if any(k in covered for k in range(i, i + 2 * p)):
                continue
            block = seq[i : i + p]
            if len(set(block)) == 1:
                continue
            if block == seq[i + p : i + 2 * p]:
                found.append((i, p, block))
                covered.update(range(i, i + 2 * p))
    found.sort(key=lambda t: t[0])
    return found


def is_negative_ask(ask: str) -> bool:
    """『誤っているものはどれか』型か。True なら正解肢は × 側。"""
    if "要しない" in ask or "不要" in ask:
        return False  # 「〜を要しないものはどれか」は該当肢が1つ＝○扱い
    return any(k in ask for k in ("誤って", "適切でない", "正しくない", "妥当でない", "違反する"))


def main() -> int:
    qf = sys.argv[1] if len(sys.argv) > 1 else "questions.js"
    ef = sys.argv[2] if len(sys.argv) > 2 else "explanations.js"
    qs = load_js(qf)
    es = load_js(ef)

    errors: list[str] = []
    warns: list[str] = []

    if len(qs) != len(es):
        errors.append(f"E1 件数不一致: questions={len(qs)} / explanations={len(es)}")

    emap = {e.get("num"): e for e in es}
    nums = [q.get("num") for q in qs]
    if len(set(nums)) != len(nums):
        dup = [n for n, c in Counter(nums).items() if c > 1]
        errors.append(f"E2 num重複: {dup}")
    if nums and nums != list(range(min(nums), min(nums) + len(nums))):
        errors.append(f"E2 numが通しでない: {nums}")

    ans_seq: list[tuple] = []

    for q in qs:
        n = q.get("num")
        tag = f"問{n}"
        e = emap.get(n)
        if e is None:
            errors.append(f"E2 {tag} の解説がない")
            continue

        ask = q.get("ask", "")
        text = q.get("text", "")
        ch = q.get("choices", [])

        if not text.strip():
            errors.append(f"E11 {tag} 問題文が空")
        if len(ch) != 4:
            errors.append(f"E3 {tag} 選択肢が{len(ch)}個（4個必要）")
        for i, c in enumerate(ch):
            if not str(c).strip():
                errors.append(f"E11 {tag} 選択肢{MARKS[i]}が空")
            elif len(str(c)) < 20:
                warns.append(f"W3 {tag} 選択肢{MARKS[i]}が短い（{len(str(c))}字）")
            if re.search(r"(ない|ず)ことはない|ないわけではない", str(c)):
                errors.append(f"E9 {tag} 選択肢{MARKS[i]} に二重否定の疑い")

        marks = e.get("marks", [])
        lines = e.get("lines", [])
        ans = e.get("ans", "")
        trap = e.get("trap", "")

        if len(marks) != 4:
            errors.append(f"E4 {tag} marksが{len(marks)}個（4個必要）")
        if len(lines) != 4:
            errors.append(f"E4 {tag} linesが{len(lines)}行（4行必要）")
        if not str(trap).strip():
            errors.append(f"E11 {tag} trap（ひっかけ）が空")

        if len(marks) == 4 and len(lines) == 4:
            for i in range(4):
                m = re.match(rf"^{MARKS[i]}＝([○×])：", str(lines[i]))
                if not m:
                    errors.append(f"E5 {tag} lines[{i}] の書式が『{MARKS[i]}＝○：』形式でない")
                elif m.group(1) != marks[i]:
                    errors.append(
                        f"E5 {tag} {MARKS[i]}の○×が不一致（marks={marks[i]} / lines={m.group(1)}）"
                    )
                if not re.search(r"\d+\s*条|規約|規則|施行令|通達", str(lines[i])):
                    warns.append(f"W1 {tag} {MARKS[i]} の解説に条文番号らしき記載がない")

        if len(marks) == 4:
            neg = is_negative_ask(ask)
            target = "×" if neg else "○"
            hits = [MARKS[i] for i in range(4) if marks[i] == target]
            if len(hits) >= 2:
                errors.append(
                    f"E7 【二重正解】{tag}『{ask}』に対し該当肢が{len(hits)}個: {'・'.join(hits)}"
                )
            elif len(hits) == 0:
                errors.append(f"E8 {tag}『{ask}』に該当する肢が0個")
            if ans not in MARKS:
                errors.append(f"E6 {tag} ans='{ans}' が不正")
            elif hits and ans not in hits:
                errors.append(f"E6 {tag} ans={ans} だが該当肢は{'・'.join(hits)}")
            ans_seq.append((n, ans))

    # 3連続チェック
    for i in range(len(ans_seq) - 2):
        a, b, c = ans_seq[i][1], ans_seq[i + 1][1], ans_seq[i + 2][1]
        if a == b == c:
            errors.append(
                f"E10 正解が3問連続で同一: 問{ans_seq[i][0]}〜問{ans_seq[i+2][0]} = {a}"
            )

    # 周期パターンチェック（3連続同一はすり抜ける「並びそのものの繰り返し」を検出）
    ans_only = [a for _, a in ans_seq]
    for i, p, block in find_periodic_repeats(ans_only):
        q_first = ans_seq[i][0]
        q_last = ans_seq[i + 2 * p - 1][0]
        errors.append(
            f"E12 【周期パターン】問{q_first}〜問{q_last}で「{'・'.join(block)}」という{p}問幅の並びが直後にそのまま繰り返されとる"
        )

    dist = Counter(a for _, a in ans_seq)
    total = len(ans_seq)
    if total:
        counts = [dist.get(m, 0) for m in MARKS]
        if max(counts) - min(counts) > total * 0.25:
            warns.append(
                "W2 正解分布が偏っている: "
                + "／".join(f"{m}{dist.get(m,0)}" for m in MARKS)
            )

    print("=" * 56)
    print(f" check_consistency.py  問題数={len(qs)}")
    print("=" * 56)
    print(" 正解分布: " + "／".join(f"{m}{dist.get(m,0)}問" for m in MARKS))
    print(" 正解並び: " + "・".join(a for _, a in ans_seq))
    print("-" * 56)
    if errors:
        print(f" エラー {len(errors)}件")
        for x in errors:
            print("  [E] " + x)
    else:
        print(" エラー 0件")
    if warns:
        print(f" 警告 {len(warns)}件")
        for x in warns:
            print("  [W] " + x)
    else:
        print(" 警告 0件")
    print("=" * 56)
    if errors:
        print(" → エラーが残っとる。修正してから再実行すること（PDF化に進まない）")
        return 1
    print(" → 形式チェック通過。takken-mondai-check スキルへ進むこと")
    return 0


if __name__ == "__main__":
    sys.exit(main())
