"""
検算例 4 の手計算（計算本体を使わない）。 python3 handcalc.py で expected.json を書き出す。

曲がりを ζ で持つ係数のうち、0.3.0 で足した 2 つの決まりの検算（SPEC §3「曲がりを ζ で持つ」）:
- 径ごとの ζ90（zeta90ByDiameter）: ダクトの径に一番近い径の値を使う。同じ近さなら小さい径
- 角度に比例させる形（angleProportional）: 角度の補正は θ/90。係数の角度の表は使わない
あわせて、ふつうの形（zeta90 が 1 つ）の角度の表（補間・表の値）と、器材の ζ
（曲がりに zeta があれば、形があっても使わず、角度の補正もしない）を見る。

  外気フード ← 外気ダクト ← [送風機] → 主管 → 分岐 ┬→ 枝 A（φ125）→ 吹出口 A
  （吸込側）  （φ150）                （φ150）       ├→ 枝 B（φ100）→ 吹出口 B
                                                    └→ 枝 C（φ75） → 吹出口 C

係数（架空）:
- 形 tube: 径ごとの ζ90 φ100 0.8・φ150 0.6・φ200 0.4、角度に比例（θ/90）
- 形 elbow（既定の形）: ζ90 0.3、角度の補正は係数の表 30° 0.5・45° 0.6・90° 1.0 を直線で補間

- λ は一定。直管の摩擦は λ·(L/D)·q。外気ダクトは自分の λ 0.02、ほかは送風機の既定値 0.025（係数の λ 0.03 は使われない）
- 曲がりは λ によらない局部損失 ζ1個 × 個数 × q を直管の摩擦に足す。直管の長さ L は曲がりを含む中心線の長さ
- 空気密度 ρ 1.2（標準空気と同じなので、送風機の特性の倍率 ρ/1.20 は 1）
"""
import json, math, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from handcalc_common import velocity, dynamic_pressure, local, fan_pressure, operating_points  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
inp = json.load(open(os.path.join(HERE, 'input.json'), encoding='utf-8'))
c = inp['coefficients']
RHO = inp['payload']['rho']
BEND = c['bend']
SHAPES = BEND['shapes']
ANGLE = {float(a): f for a, f in BEND['angleFactor'].items()}
nodes = inp['payload']['systems'][0]['nodes']


def nearest_diameter(table_mm, d_mm):
    """表の径のうち d に一番近い径。同じ近さなら小さい径（「近さ」と「径」の組で一番小さいもの）"""
    return min(table_mm, key=lambda k: (abs(k - d_mm), k))


def table_factor(deg):
    """係数の角度の表を直線で補間する。表の外は端の値。どの決まりで決めたかも返す"""
    pts = sorted(ANGLE.items())
    if deg in ANGLE:
        return ANGLE[deg], '角度の表の値'
    if deg < pts[0][0]:
        return pts[0][1], '角度の表の端'
    if deg > pts[-1][0]:
        return pts[-1][1], '角度の表の端'
    for (a0, f0), (a1, f1) in zip(pts, pts[1:]):
        if a0 < deg < a1:
            return f0 + (f1 - f0) * (deg - a0) / (a1 - a0), f'角度の表を補間（{a0:g}°〜{a1:g}°）'
    raise ValueError(deg)


def bend_one(b, d_mm):
    """曲がり 1 個の ζ（SPEC §3）と、どの決まりで決めたか"""
    if b.get('zeta') is not None:
        # 器材の ζ: その角度での値なので補正しない。形（shape）が書いてあっても使わない
        return {'angleDeg': b['angleDeg'], 'count': b['count'], 'shapeUsed': None, 'from': '器材の ζ',
                'tableDiameterMm': None, 'zeta90': None, 'angleFactor': None, 'angleRule': None,
                'zetaOne': b['zeta']}
    key = b.get('shape') or BEND['defaultShape']
    s = SHAPES[key]
    assert ('zeta90' in s) != ('zeta90ByDiameter' in s)   # 形はどちらか一方だけを持つ
    if 'zeta90ByDiameter' in s:
        table = {int(k): v for k, v in s['zeta90ByDiameter'].items()}
        dk = nearest_diameter(table, d_mm)
        z90, src = table[dk], '形の zeta90ByDiameter'
    else:
        dk, z90, src = None, s['zeta90'], '形の zeta90'
    if s.get('angleProportional'):
        f, rule = b['angleDeg'] / 90.0, 'θ/90（角度に比例させる形。角度の表は使わない）'
    else:
        f, rule = table_factor(float(b['angleDeg']))
    return {'angleDeg': b['angleDeg'], 'count': b['count'], 'shapeUsed': key, 'from': src,
            'tableDiameterMm': dk, 'zeta90': z90, 'angleFactor': f, 'angleRule': rule, 'zetaOne': z90 * f}


def duct_lambda(p):
    """SPEC §3: ダクトの lambda → 根の方向で最初の送風機の defaultLambda → 係数の lambda。
    この系統のダクトは、どれも根（送風機）の直接の子か、その子孫で、途中に別の送風機は無い"""
    ok = lambda x: isinstance(x, (int, float)) and math.isfinite(x) and x > 0
    if ok(p.get('lambda')):
        return p['lambda'], 'ダクトの λ'
    fan_lam = nodes['fan']['params'].get('defaultLambda')
    if ok(fan_lam):
        return fan_lam, '送風機の既定値'
    return c['lambda'], '係数の λ'


def duct(q_m3h, node):
    p = node['params']
    d = p['diameterMm']
    v = velocity(q_m3h, d)
    qd = dynamic_pressure(RHO, v)
    lam, lam_from = duct_lambda(p)
    friction = lam / (d / 1000) * qd * p['lengthM']      # 直管の摩擦 λ·(L/D)·q。L は曲がりを含む中心線の長さ
    bends = [bend_one(b, d) for b in p['bends']]
    zsum = sum(b['zetaOne'] * b['count'] for b in bends)  # Σ ζ1個 × 個数
    return {'Q': q_m3h, 'D': d, 'v': v, 'q': qd, 'lambda': lam, 'lambdaFrom': lam_from,
            'frictionPa': friction, 'bendZeta': zsum, 'bendPa': zsum * qd, 'dP': friction + zsum * qd,
            'bends': bends}


# ── 風量（SPEC §5）: 吹出側は端末の目標風量の和。吸込側は端末が外気フード 1 つなので全量 ──
Q_A, Q_B, Q_C = 100.0, 70.0, 30.0
Q_FAN = Q_A + Q_B + Q_C            # 200。主管・分岐・外気ダクト・外気フードも 200

m = {
    # 外気ダクト φ150・2 m・λ はダクトの λ 0.02
    #   既定の形 elbow 90° × 1 : ζ90 0.3 × 角度の表の値（90° → 1.0）               ＝ 0.3
    #   tube 30° × 1           : 径の表で φ150 ちょうど → 0.6 × θ/90（30/90）      ＝ 0.2
    #   合計 0.5
    'oa': duct(Q_FAN, nodes['oa']),
    'hood': local(RHO, 2.0, Q_FAN, 150),                  # 外気フードの径は根の方向の外気ダクト φ150
    # 主管 φ150・6 m・λ は送風機の既定値 0.025
    #   tube 45° × 2           : 径の表で φ150 ちょうど → 0.6 × θ/90（45/90 ＝ 0.5）＝ 0.3 × 2 ＝ 0.6
    #                            （角度の表を使うと 45° は 0.6 なので 0.36 × 2 ＝ 0.72 になってしまう）
    #   既定の形 elbow 60° × 1 : ζ90 0.3 × 角度の表を補間 0.6 ＋ (1.0 − 0.6) × 15/45 ＝ 0.7333…（ζ は 0.3 × 0.7333… ＝ 0.2200）
    #   合計 0.82
    'main': duct(Q_FAN, nodes['main']),
    'br': local(RHO, 1.0, Q_FAN, 150),                    # 分岐の径は上流の主管 φ150
    # 枝 A φ125・5 m・λ は送風機の既定値 0.025
    #   tube 30° × 2 : 径の表 φ100 と φ150 は φ125 から同じ近さ（25 mm）→ 小さい径 φ100 の 0.8
    #                  × θ/90（30/90）＝ 0.2666… × 2 ＝ 0.5333…
    #   tube 45° × 1 : 同じく 0.8 × 45/90 ＝ 0.4
    #   合計 0.9333…（大きい径 φ150 の 0.6 を選ぶと 0.7 になってしまう）
    'dA': duct(Q_A, nodes['dA']),
    'tA': local(RHO, 1.5, Q_A, 125),                      # 吹出口 A の径は上流の枝 A φ125
    # 枝 B φ100・4 m・λ は送風機の既定値 0.025
    #   tube 45° × 1                 : 径の表で φ100 ちょうど → 0.8 × 45/90 ＝ 0.4
    #   器材の ζ 0.7（30°・× 2）     : 曲がりに zeta があるので形 tube は使わず、角度の補正もしない ＝ 0.7 × 2 ＝ 1.4
    #                                  （形を使うと 0.8 × 30/90 × 2 ＝ 0.5333…、0.7 を 30/90 倍すると 0.4666… になってしまう）
    #   合計 1.8
    'dB': duct(Q_B, nodes['dB']),
    'tB': local(RHO, 1.5, Q_B, 100),                      # 吹出口 B の径は上流の枝 B φ100
    # 枝 C φ75・3 m・λ は送風機の既定値 0.025
    #   tube 90° × 1 : 径の表に φ75 は無い。一番近いのは φ100（25 mm。φ150 は 75 mm）→ 0.8 × 90/90 ＝ 0.8
    'dC': duct(Q_C, nodes['dC']),
    'tC': local(RHO, 1.5, Q_C, 75),                       # 吹出口 C の径は上流の枝 C φ75
}

# 上のコメントに書いた手の計算と、決まりを関数にしたものが同じ値であることを確かめる
HAND = {
    'oa': 0.3 * 1.0 + 0.6 * 30 / 90,
    'main': 0.6 * 45 / 90 * 2 + 0.3 * (0.6 + (1.0 - 0.6) * 15 / 45),
    'dA': 0.8 * 30 / 90 * 2 + 0.8 * 45 / 90,
    'dB': 0.8 * 45 / 90 + 0.7 * 2,
    'dC': 0.8 * 90 / 90,
}
for i, z in HAND.items():
    assert math.isclose(m[i]['bendZeta'], z, rel_tol=1e-14), (i, m[i]['bendZeta'], z)

# ── ルート（SPEC §6）: 吸込側は送風機本体を数えない ──
routes = {
    'tA': ['main', 'br', 'dA', 'tA'],
    'tB': ['main', 'br', 'dB', 'tB'],
    'tC': ['main', 'br', 'dC', 'tC'],
    'hood': ['oa', 'hood'],
}
route_pa = {k: sum(m[i]['dP'] for i in v) for k, v in routes.items()}
up = route_pa['hood']
critical = max(['tA', 'tB', 'tC'], key=lambda k: route_pa[k])
down = route_pa[critical]
required = up + down

# ── 送風機の判定（SPEC §7）──
# 特性は標準空気 1.20 の値とみなし、計算の ρ に合わせて ρ/1.20 倍にして比べる（ここでは ρ 1.2 なので 1 倍）
PQ = [(p['q'], p['p']) for p in nodes['fan']['params']['pqPoints']]
ratio = RHO / 1.2
PQs = [(q, p * ratio) for q, p in PQ]
k = required / Q_FAN ** 2
available = fan_pressure(PQs, Q_FAN)
ops = operating_points(PQs, k)
# 設定風量が特性の範囲の中にあり、交点が 1 つで設定風量より少なくないので、出せる静圧と必要静圧をそのまま比べる
assert PQs[0][0] <= Q_FAN <= PQs[-1][0] and len(ops) == 1 and ops[0]['q'] >= Q_FAN

expected = {
    'members': m,
    'routes': route_pa,
    'fan': {'flowQh': Q_FAN, 'upstreamPa': up, 'downstreamPa': down, 'requiredPa': required, 'critical': critical,
            'densityRatio': ratio, 'k': k, 'availableAtDesignPa': available, 'marginPa': available - required,
            'level': 'ok' if available >= required else 'ng', 'operatingPoints': ops},
}
json.dump(expected, open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

print(f'ρ {RHO}・特性の倍率 {ratio:g}')
print('部材          Q      D       λ     直管    曲がりζ   曲がり     ΔP')
for i, r in m.items():
    if 'lambda' in r:
        print(f"{i:6s} {r['Q']:7.1f} {r['D']:5d} {r['lambda']:.4f} {r['frictionPa']:7.3f} {r['bendZeta']:7.4f} {r['bendPa']:7.3f} {r['dP']:8.3f}")
        for b in r['bends']:
            how = b['from'] if b['zeta90'] is None else \
                f"{b['shapeUsed']} ζ90 {b['zeta90']:g}" + (f"（表の φ{b['tableDiameterMm']}）" if b['tableDiameterMm'] else '') + \
                f" × {b['angleFactor']:.4f}（{b['angleRule']}）"
            print(f"         {b['angleDeg']:3d}° × {b['count']} : ζ1個 {b['zetaOne']:.4f}  {how}")
    else:
        print(f"{i:6s} {r['Q']:7.1f} {r['D']:5d} {'':6s} {'':7s} ζ{r['zeta']:6.2f} {'':7s} {r['dP']:8.3f}")
for kk, v in route_pa.items():
    print(f'ルート {kk}: {v:.3f} Pa')
print(f'上流側 {up:.3f} ＋ 下流側 {down:.3f}（{critical}）＝ 必要静圧 {required:.3f} Pa')
print(f'設定風量 {Q_FAN:.0f} m³/h で出せる静圧 {available:.3f} Pa → {expected["fan"]["level"]}（余裕 {available - required:.3f}）')
print('運転点', ', '.join(f"{o['q']:.3f} m³/h・{o['p']:.3f} Pa" for o in ops))
