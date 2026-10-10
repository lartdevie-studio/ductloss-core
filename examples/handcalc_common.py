"""
検算例の手計算に使う式（SPEC.md §3・§7）。計算本体（TypeScript）を使わず、式を書き下して求める。

- 部材の風量・径・経路は、各例の handcalc.py に手で書く（本体の集計・径の読み取り・経路の組み立ては使わない）
- 運転点は、本体と違う解き方（特性の区間ごとの二分法）で求める
- Python 3 の標準ライブラリだけで動く
"""
import math


def area(d_mm):
    """断面積 A = π·D²/4（m²）"""
    d = d_mm / 1000.0
    return math.pi * d * d / 4.0


def velocity(q_m3h, d_mm):
    """風速 v = (Q/3600)/A（m/s）"""
    return q_m3h / 3600.0 / area(d_mm)


def dynamic_pressure(rho, v):
    """動圧 q = ρ·v²/2（Pa）"""
    return rho * v * v / 2.0


def l90(table, d_mm):
    """90° 曲がり 1 個の相当長。表の中で一番近い径の値（同じ近さなら小さい径）"""
    best = None
    for k in sorted(table):
        if best is None or abs(k - d_mm) < abs(best - d_mm):
            best = k
    return table[best]


def duct(rho, lam, table, q_m3h, d_mm, length_m, bends):
    """直管: ΔP = (λ/D)·q·(L + L曲)。bends は [(角度, 個数), ...]"""
    v = velocity(q_m3h, d_mm)
    qd = dynamic_pressure(rho, v)
    l_bend = sum(l90(table, d_mm) * angle / 90.0 * count for angle, count in bends)
    l_equiv = length_m + l_bend
    per_m = lam / (d_mm / 1000.0) * qd
    return {"Q": q_m3h, "D": d_mm, "v": v, "q": qd, "lambda": lam, "Lbend": l_bend, "Lequiv": l_equiv,
            "PaPerM": per_m, "dP": per_m * l_equiv}


def local(rho, zeta, q_m3h, d_mm):
    """局部: ΔP = ζ·q（q は d_mm の断面の動圧）"""
    v = velocity(q_m3h, d_mm)
    qd = dynamic_pressure(rho, v)
    return {"Q": q_m3h, "D": d_mm, "v": v, "q": qd, "zeta": zeta, "dP": zeta * qd}


def fan_pressure(points, q):
    """P-Q 特性（点を線でつなぐ）。範囲の外は端の値（判定では使わない）"""
    pts = sorted(points)
    if q <= pts[0][0]:
        return pts[0][1]
    if q >= pts[-1][0]:
        return pts[-1][1]
    for (q0, p0), (q1, p1) in zip(pts, pts[1:]):
        if q0 <= q <= q1:
            return p0 + (p1 - p0) * (q - q0) / (q1 - q0)
    raise ValueError(q)


def operating_points(points, k):
    """運転点: 特性 P(Q) と ΔP = k·Q² の交点を、区間ごとの二分法で全部求める（風量の小さい順）"""
    pts = sorted(points)
    out = []
    for (q0, p0), (q1, p1) in zip(pts, pts[1:]):
        g = lambda q: (p0 + (p1 - p0) * (q - q0) / (q1 - q0)) - k * q * q
        a, b = q0, q1
        ga, gb = g(a), g(b)
        if ga == 0:
            out.append(a)
            continue
        if ga * gb > 0:
            continue
        for _ in range(200):
            m = (a + b) / 2.0
            gm = g(m)
            if ga * gm <= 0:
                b, gb = m, gm
            else:
                a, ga = m, gm
        out.append((a + b) / 2.0)
    res = []
    for q in sorted(out):
        if not res or abs(res[-1] - q) > 1e-7:
            res.append(q)
    return [{"q": q, "p": fan_pressure(points, q)} for q in res]
