"""2 つの expected.json が同じ値かを比べる（Python 3 の標準ライブラリだけ）。

手計算を回し直した結果と、保存してある期待値を比べるのに使う。
数は相対 1e-12（とても小さい値は絶対 1e-12）までの差を同じとみなす。
対数や累乗の計算は、OS の数学ライブラリによって最後の 1 桁が違うことがあり、
文字どおりに比べると、計算が正しくても Linux と macOS で食い違うため。
数以外（文字・鍵・並び）は完全に同じでなければならない。

使い方: python3 examples/same_numbers.py <保存してある期待値> <回し直した期待値>
"""
import json
import math
import sys

TOL = 1e-12


def diffs(a, b, path="$"):
    if isinstance(a, bool) or isinstance(b, bool):
        return [] if a is b else [f"{path}: {a!r} と {b!r}"]
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if math.isclose(a, b, rel_tol=TOL, abs_tol=TOL):
            return []
        return [f"{path}: {a!r} と {b!r}"]
    if isinstance(a, dict) and isinstance(b, dict):
        if list(a.keys()) != list(b.keys()):
            return [f"{path}: 鍵が違う {list(a.keys())} と {list(b.keys())}"]
        return [d for k in a for d in diffs(a[k], b[k], f"{path}.{k}")]
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [f"{path}: 長さが違う {len(a)} と {len(b)}"]
        return [d for i, (x, y) in enumerate(zip(a, b)) for d in diffs(x, y, f"{path}[{i}]")]
    return [] if a == b else [f"{path}: {a!r} と {b!r}"]


def main():
    saved, fresh = sys.argv[1], sys.argv[2]
    with open(saved, encoding="utf-8") as f:
        a = json.load(f)
    with open(fresh, encoding="utf-8") as f:
        b = json.load(f)
    found = diffs(a, b)
    if found:
        print(f"期待値が違います（{saved}）:")
        for d in found[:20]:
            print("  " + d)
        sys.exit(1)
    print(f"同じ値です（{saved}・相対 {TOL:g} まで）")


if __name__ == "__main__":
    main()
