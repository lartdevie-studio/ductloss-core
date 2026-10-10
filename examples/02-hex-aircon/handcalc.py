"""
検算例 2 の手計算（計算本体を使わない）。 python3 handcalc.py で expected.json を書き出す。

系統（矢印は木のつながり）:

  外気フード ← 外気ダクト ← [熱交換器] → 熱交→エアコン → [エアコン] ┬→ 給気 1 → 吹出口 1
  （熱交の吸込側）                         （熱交の吹出側）            ├→ 給気 2 → 吹出口 2
                                                                    └← リターン ← リターン口（エアコンの吸込側）

熱交換器とエアコンは、それぞれが受け持つ区間で評価する（SPEC §6）。2 台の圧力・風量の相互作用は解かない。
"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from handcalc_common import duct, local, fan_pressure, operating_points  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
inp = json.load(open(os.path.join(HERE, 'input.json'), encoding='utf-8'))
c = inp['coefficients']
RHO = inp['payload']['rho']
LAM = c['lambda']
TABLE = {int(k): v for k, v in c['bendEquivLength90M'].items()}
nodes = inp['payload']['systems'][0]['nodes']

# ── 風量（SPEC §5）── 質量保存を 1 つずつ書く
Q_T1, Q_T2 = 200.0, 200.0
CIRC = Q_T1 + Q_T2                  # エアコンの循環風量（吹出側の端末の和）＝ 400
RETURN = min(CIRC, 300.0)           # リターン量を入れているので、追加吸込 ＝ min(循環, リターン量) ＝ 300
SUPPLY_FROM_HEX = CIRC - RETURN     # 熱交換器からの供給 ＝ 100
Q_HEX = SUPPLY_FROM_HEX             # 熱交換器の吹出側の子はエアコンだけ。エアコンの手前へ流れるのは供給分だけ
Q_OA = Q_HEX                        # 熱交換器の吸込側の端末は外気フード 1 つ
assert abs(Q_HEX + RETURN - CIRC) < 1e-12   # 混合点の質量保存: 熱交からの供給 ＋ 追加吸込 ＝ 循環

m = {}
m['oa'] = duct(RHO, LAM, TABLE, Q_OA, 100, 2, [(90, 1)])
m['hood'] = local(RHO, 2.5, Q_OA, 100)
m['trunk'] = duct(RHO, LAM, TABLE, Q_HEX, 100, 6, [(90, 2)])
m['ac'] = local(RHO, 0.0, CIRC, 200)            # 本体の ζ は 0（機外静圧と比べるので本体の損失は入れない。SPEC §7）
m['s1'] = duct(RHO, LAM, TABLE, Q_T1, 150, 5, [(90, 1)])
m['t1'] = local(RHO, 1.5, Q_T1, 150)
m['s2'] = duct(RHO, LAM, TABLE, Q_T2, 150, 3, [])
m['t2'] = local(RHO, 1.5, Q_T2, 150)
m['ra'] = duct(RHO, LAM, TABLE, RETURN, 200, 2, [(90, 1)])
m['grille'] = local(RHO, 1.0, RETURN, 200)

# ── ルートの合計（SPEC §6）: 経路の部材の和（根の送風機は数えない）──
routes = {
    't1': ['trunk', 'ac', 's1', 't1'],
    't2': ['trunk', 'ac', 's2', 't2'],
    'grille': ['trunk', 'ac', 'ra', 'grille'],
    'hood': ['oa', 'hood'],
}
route_pa = {k: sum(m[i]['dP'] for i in v) for k, v in routes.items()}

# ── 送風機ごとの必要静圧（SPEC §6）──
# 熱交換器: 上流側 ＝ 外気側のルート、下流側 ＝ max（受け持つ吹出側ルート〔無し〕, エアコンの手前までの経路〔本体を除く〕）
hex_up = m['oa']['dP'] + m['hood']['dP']
hex_down = m['trunk']['dP']
hex_required = hex_up + hex_down
# エアコン: 供給側 ＝ 本体から吹出口までの最大、吸込側 ＝ エアコンの次からリターン口まで
ac_supply = max(m['ac']['dP'] + m['s1']['dP'] + m['t1']['dP'], m['ac']['dP'] + m['s2']['dP'] + m['t2']['dP'])
ac_intake = m['ra']['dP'] + m['grille']['dP']
ac_required = ac_supply + ac_intake

# ── 判定（SPEC §7）──
hex_p = nodes['hex']['params']
# 定格 1 点（機外静圧 80 Pa・定格風量 100 m³/h）。設定風量 100 と定格風量がほぼ同じ → この 1 点で比べる
hex_level = 'ok' if hex_p['maxStaticPa'] >= hex_required else 'ng'
PQ = [(p['q'], p['p']) for p in nodes['ac']['params']['pqPoints']]
ac_k = ac_required / CIRC ** 2
ac_available = fan_pressure(PQ, CIRC)
ac_ops = operating_points(PQ, ac_k)

expected = {
    'members': m,
    'flows': {'circulation': CIRC, 'return': RETURN, 'supplyFromHex': SUPPLY_FROM_HEX, 'hex': Q_HEX, 'oa': Q_OA},
    'routes': route_pa,
    'hex': {'flowQh': Q_HEX, 'upstreamPa': hex_up, 'downstreamPa': hex_down, 'requiredPa': hex_required,
            'ratedPa': hex_p['maxStaticPa'], 'ratedQh': hex_p['maxStaticAtQh'], 'level': hex_level},
    'aircon': {'flowQh': CIRC, 'supplyPa': ac_supply, 'intakePa': ac_intake, 'requiredPa': ac_required, 'k': ac_k,
               'availableAtDesignPa': ac_available, 'marginPa': ac_available - ac_required,
               'level': 'ok' if ac_available >= ac_required else 'ng', 'operatingPoints': ac_ops},
}
json.dump(expected, open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

print(f'循環 {CIRC:.0f} ＝ 熱交からの供給 {SUPPLY_FROM_HEX:.0f} ＋ 追加吸込 {RETURN:.0f} m³/h')
print('部材          Q      D      v       q       ΔP')
for i, r in m.items():
    print(f"{i:8s} {r['Q']:7.1f} {r['D']:5d} {r['v']:7.3f} {r['q']:7.3f} {r['dP']:8.3f}")
for kk, v in route_pa.items():
    print(f'ルート {kk}: {v:.3f} Pa')
print(f'熱交換器: 上流側 {hex_up:.3f} ＋ 下流側 {hex_down:.3f} ＝ {hex_required:.3f} Pa（定格 {hex_p["maxStaticPa"]} Pa → {hex_level}）')
print(f'エアコン: 供給側 {ac_supply:.3f} ＋ 吸込側 {ac_intake:.3f} ＝ {ac_required:.3f} Pa'
      f'（{CIRC:.0f} m³/h で {ac_available:.3f} Pa → {expected["aircon"]["level"]}）')
print('エアコンの運転点', ', '.join(f"{o['q']:.3f} m³/h・{o['p']:.3f} Pa" for o in ac_ops))
