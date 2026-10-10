"""
検算例 3 の手計算（計算本体を使わない）。 python3 handcalc.py で expected.json を書き出す。

粗さから求める λ（Colebrook の式）と、曲がりを ζ で持つ係数（形・角度の補正・器材の ζ）の検算。気温 30℃。

  外気フード ← 外気ダクト ← [送風機] → 主管 → 分岐 ┬→ 枝 A（スパイラル）→ 吹出口 A
  （吸込側）                                      └→ 枝 B（平滑な管）  → 吹出口 B

- Colebrook の式は、本体と違う解き方（λ の区間を二分法で詰める）で解く
- 動粘性係数 ν ＝ μ/ρ、μ はサザーランドの式（μ0 1.716e-5 Pa·s・T0 273.15 K・S 110.4 K）
- 曲がりは λ によらない局部損失 ζ90 × 角度の補正 × 個数 × q。直管の長さは曲がりを含む中心線の長さ
"""
import json, math, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from handcalc_common import velocity, dynamic_pressure, local, fan_pressure, operating_points  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
inp = json.load(open(os.path.join(HERE, 'input.json'), encoding='utf-8'))
c = inp['coefficients']
RHO = inp['payload']['rho']
T = inp['tempC']
MATS = {k: v['roughnessMm'] for k, v in c['friction']['materials'].items()}
SHAPES = {k: v['zeta90'] for k, v in c['bend']['shapes'].items()}
ANGLE = {float(a): f for a, f in c['bend']['angleFactor'].items()}

mu = 1.716e-5 * ((T + 273.15) / 273.15) ** 1.5 * (273.15 + 110.4) / (T + 273.15 + 110.4)
NU = mu / RHO


def colebrook_bisect(re, rel):
    """1/√λ + 2·log10(rel/3.7 + 2.51/(Re·√λ)) = 0 を λ ∈ [0.003, 0.3] の二分法で解く"""
    g = lambda lam: 1 / math.sqrt(lam) + 2 * math.log10(rel / 3.7 + 2.51 / (re * math.sqrt(lam)))
    a, b = 0.003, 0.3
    ga = g(a)
    for _ in range(200):
        m = (a + b) / 2
        gm = g(m)
        if (ga > 0) == (gm > 0):
            a, ga = m, gm
        else:
            b = m
    return (a + b) / 2


def angle_factor(deg):
    pts = sorted(ANGLE.items())
    if deg <= pts[0][0]:
        return pts[0][1]
    if deg >= pts[-1][0]:
        return pts[-1][1]
    for (a0, f0), (a1, f1) in zip(pts, pts[1:]):
        if a0 <= deg <= a1:
            return f0 + (f1 - f0) * (deg - a0) / (a1 - a0)


def bend_zeta(b):
    if b.get('zeta') is not None:
        return b['zeta']          # 器材の ζ（その角度での値なので補正しない）
    return SHAPES[b.get('shape') or c['bend']['defaultShape']] * angle_factor(b['angleDeg'])


def duct(q_m3h, node):
    p = node['params']
    d = p['diameterMm']
    v = velocity(q_m3h, d)
    qd = dynamic_pressure(RHO, v)
    material = p.get('material') or c['friction']['defaultMaterial']
    re = v * (d / 1000) / NU
    lam = colebrook_bisect(re, MATS[material] / d)
    friction = lam / (d / 1000) * qd * p['lengthM']
    zsum = sum(bend_zeta(b) * b['count'] for b in p['bends'])
    return {'Q': q_m3h, 'D': d, 'v': v, 'q': qd, 'Re': re, 'lambda': lam, 'material': material,
            'frictionPa': friction, 'bendZeta': zsum, 'bendPa': zsum * qd, 'dP': friction + zsum * qd}


nodes = inp['payload']['systems'][0]['nodes']
Q_A, Q_B = 120.0, 80.0
Q_FAN = Q_A + Q_B
m = {
    'oa': duct(Q_FAN, nodes['oa']),
    'hood': local(RHO, 2.0, Q_FAN, 150),
    'main': duct(Q_FAN, nodes['main']),
    'br': local(RHO, 0.9, Q_FAN, 150),
    'dA': duct(Q_A, nodes['dA']),
    'tA': local(RHO, 1.5, Q_A, 100),
    'dB': duct(Q_B, nodes['dB']),
    'tB': local(RHO, 1.5, Q_B, 100),
}
routes = {'tA': ['main', 'br', 'dA', 'tA'], 'tB': ['main', 'br', 'dB', 'tB'], 'hood': ['oa', 'hood']}
route_pa = {k: sum(m[i]['dP'] for i in v) for k, v in routes.items()}
up = route_pa['hood']
down = max(route_pa['tA'], route_pa['tB'])
required = up + down
PQ = [(p['q'], p['p']) for p in nodes['fan']['params']['pqPoints']]
# 送風機の特性は標準空気 1.20 の値とみなし、計算の ρ に合わせて ρ/1.20 倍にして比べる（SPEC §7）
ratio = RHO / 1.2
PQs = [(q, p * ratio) for q, p in PQ]
k = required / Q_FAN ** 2
expected = {
    'nu': NU, 'members': m, 'routes': route_pa,
    'fan': {'flowQh': Q_FAN, 'upstreamPa': up, 'downstreamPa': down, 'requiredPa': required, 'densityRatio': ratio,
            'availableAtDesignPa': fan_pressure(PQs, Q_FAN), 'operatingPoints': operating_points(PQs, k)},
}
json.dump(expected, open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

print(f'気温 {T}℃・ρ {RHO:.5f}・ν {NU:.4e} m²/s')
print('部材          Q      D       Re       λ     直管    曲がりζ   曲がり     ΔP')
for i, r in m.items():
    if 'lambda' in r:
        print(f"{i:6s} {r['Q']:7.1f} {r['D']:5d} {r['Re']:8.0f} {r['lambda']:.5f} {r['frictionPa']:7.3f} {r['bendZeta']:7.4f} {r['bendPa']:7.3f} {r['dP']:8.3f}")
    else:
        print(f"{i:6s} {r['Q']:7.1f} {r['D']:5d} {'':8s} {'':7s} {'':7s} ζ{r['zeta']:6.2f} {'':7s} {r['dP']:8.3f}")
for kk, v in route_pa.items():
    print(f'ルート {kk}: {v:.3f} Pa')
print(f'上流側 {up:.3f} ＋ 下流側 {down:.3f} ＝ 必要静圧 {required:.3f} Pa')
print(f'出せる静圧（×{ratio:.4f}）{expected["fan"]["availableAtDesignPa"]:.3f} Pa・運転点',
      ', '.join(f"{o['q']:.3f} m³/h" for o in expected['fan']['operatingPoints']))
