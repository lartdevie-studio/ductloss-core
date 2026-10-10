"""
検算例 1 の手計算（計算本体を使わない）。 python3 handcalc.py で expected.json を書き出す。

系統（矢印は木のつながり。吸込側の空気は逆向きに流れる）:

  外気フード ← 外気ダクト 2 ← フィルター ← 外気ダクト 1 ← [送風機] → 主管 → 分岐 ┬→ 枝 A → 吹出口 A
  （吸込側）                                                         （吹出側）   └→ レジューサ → 枝 B → 吹出口 B
"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from handcalc_common import duct, local, fan_pressure, operating_points  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
inp = json.load(open(os.path.join(HERE, 'input.json'), encoding='utf-8'))
c = inp['coefficients']
RHO = inp['payload']['rho']
LAM = c['lambda']                       # 直管にも送風機にも別の λ が無いので、送風機の既定値 0.035（＝係数と同じ）
TABLE = {int(k): v for k, v in c['bendEquivLength90M'].items()}

# ── 風量（SPEC §5）: 吹出側は端末の目標風量の和、吸込側は送風機の風量を端末の比で配る ──
Q_A, Q_B = 90.0, 60.0
Q_FAN = Q_A + Q_B                       # 150。主管・分岐も 150
Q_OA = Q_FAN                            # 吸込側の端末は外気フード 1 つなので全量

m = {}
# 吸込側（径はそれぞれの部材の径。フードは根の方向の外気ダクト 2 の φ150）
m['oa1'] = duct(RHO, LAM, TABLE, Q_OA, 150, 3, [(90, 1)])
m['flt'] = local(RHO, 4.0, Q_OA, 150)
m['oa2'] = duct(RHO, LAM, TABLE, Q_OA, 150, 1, [])
m['hood'] = local(RHO, 2.5, Q_OA, 150)
# 吹出側
m['main'] = duct(RHO, LAM, TABLE, Q_FAN, 150, 5, [(90, 2)])
m['br'] = local(RHO, 0.8, Q_FAN, 150)                       # 分岐の径は上流の主管 φ150
m['dA'] = duct(RHO, LAM, TABLE, Q_A, 125, 8, [(90, 1)])     # φ125 は表に無い → 同じ近さの小さい径 φ100 の 0.4 m
m['tA'] = local(RHO, 1.5, Q_A, 125)                         # 吹出口 A の径は上流の枝 A φ125
m['red'] = local(RHO, 0.2, Q_B, 100)                        # レジューサ φ150 → φ100、ζ は細い側（φ100）の動圧に掛ける
m['dB'] = duct(RHO, LAM, TABLE, Q_B, 100, 2, [(45, 1)])     # 45° は 90° の値 × 45/90
m['tB'] = local(RHO, 1.5, Q_B, 100)

# ── ルート（SPEC §6）: 吸込側は送風機本体を数えない ──
routes = {
    'tA': ['main', 'br', 'dA', 'tA'],
    'tB': ['main', 'br', 'red', 'dB', 'tB'],
    'hood': ['oa1', 'flt', 'oa2', 'hood'],
}
route_pa = {k: sum(m[i]['dP'] for i in v) for k, v in routes.items()}
up = route_pa['hood']
down = max(route_pa['tA'], route_pa['tB'])
required = up + down

# ── 送風機の判定（SPEC §7）: 特性の範囲の中なので、設定風量で出せる静圧と比べる ──
PQ = [(p['q'], p['p']) for p in inp['payload']['systems'][0]['nodes']['fan']['params']['pqPoints']]
k = required / Q_FAN ** 2
available = fan_pressure(PQ, Q_FAN)
ops = operating_points(PQ, k)

# ── ダンパ調整（SPEC §10）: 基準 ＝ 下流側の最大、それより 0.01 Pa 低くそろえる ──
crit = 'tA' if route_pa['tA'] >= route_pa['tB'] else 'tB'
other = 'tB' if crit == 'tA' else 'tA'
delta = down - 0.01 - route_pa[other]
zeta_new = m[other]['zeta'] + delta / m[other]['q']

expected = {
    'members': m,
    'routes': route_pa,
    'fan': {'flowQh': Q_FAN, 'upstreamPa': up, 'downstreamPa': down, 'requiredPa': required, 'k': k,
            'availableAtDesignPa': available, 'marginPa': available - required,
            'level': 'ok' if available >= required else 'ng', 'operatingPoints': ops},
    'balance': {'critical': crit, 'adjusted': other, 'deltaPa': delta, 'zetaNew': zeta_new},
}
json.dump(expected, open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

print('部材          Q      D      v       q       ΔP')
for i, r in m.items():
    print(f"{i:8s} {r['Q']:7.1f} {r['D']:5d} {r['v']:7.3f} {r['q']:7.3f} {r['dP']:8.3f}")
for kk, v in route_pa.items():
    print(f'ルート {kk}: {v:.3f} Pa')
print(f'上流側 {up:.3f} ＋ 下流側 {down:.3f} ＝ 必要静圧 {required:.3f} Pa')
print(f'設定風量 {Q_FAN:.0f} m³/h で出せる静圧 {available:.3f} Pa → {expected["fan"]["level"]}（余裕 {available - required:.3f}）')
print('運転点', ', '.join(f"{o['q']:.3f} m³/h・{o['p']:.3f} Pa" for o in ops))
print(f'ダンパ調整: {other} の ζ {m[other]["zeta"]} → {zeta_new:.4f}')
