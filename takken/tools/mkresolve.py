# 使い方: python3 -I mkresolve.py <spec.txt> <out resolve.json>
# spec の各行:  num|marks(4文字 ○×)|ア根拠|イ根拠|ウ根拠|エ根拠
import json, sys
M = "アイウエ"
out = []
for ln in open(sys.argv[1], encoding="utf-8"):
    ln = ln.strip()
    if not ln or ln.startswith("#"):
        continue
    num, marks, *ky = ln.split("|")
    assert len(marks) == 4 and len(ky) == 4, ln
    marks = list(marks)
    out.append({
        "num": int(num),
        "marks": marks,
        "ans": "",  # 後で決定
        "kyoka": [f"{M[i]}＝{marks[i]}：{ky[i]}" for i in range(4)],
    })
# ans: 否定型の問は×が1つ、それ以外は○が1つ（spec 側で ! を付けた num は否定型）
neg = set(int(x) for x in sys.argv[3].split(",")) if len(sys.argv) > 3 and sys.argv[3] else set()
for r in out:
    t = "×" if r["num"] in neg else "○"
    hits = [M[i] for i in range(4) if r["marks"][i] == t]
    assert len(hits) == 1, (r["num"], hits)
    r["ans"] = hits[0]
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("written", len(out))
