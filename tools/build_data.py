"""Build compact game data from raw UN WPP 2024 + World Bank WDI downloads.

Outputs (D:/LifeLine2090/data):
  countries.json  - per-country metadata, WPP demographic series, WB indicator series (history + baseline projection)
  mortality.json  - WPP abridged life-table mx by country/year/sex/age-group, Uint16 base64 encoded

Series are stored on the YEARS grid (annual 2000-2026, then every 5 years to 2090, plus 2100).
Values after the last observed year of a World Bank indicator are a transparent baseline projection
(documented in PROJECTION_NOTES); the game applies scenario modifiers on top at runtime.
"""
import base64, csv, gzip, json, math, statistics, subprocess, sys
from array import array
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "data"
OUT.mkdir(exist_ok=True)

YEARS = list(range(2000, 2027)) + list(range(2030, 2091, 5)) + [2100]
YIDX = {y: i for i, y in enumerate(YEARS)}
AGE_STARTS = [0, 1] + list(range(5, 101, 5))  # 22 groups
AGE_IDX = {a: i for i, a in enumerate(AGE_STARTS)}

SUBREGION_TO_REGION = {
    "Eastern Asia": "EAS", "South-Eastern Asia": "SEA", "Southern Asia": "SAS", "Central Asia": "CAS",
    "Western Asia": "WAS", "Northern Africa": "NAF", "Eastern Africa": "SSA", "Middle Africa": "SSA",
    "Southern Africa": "SSA", "Western Africa": "SSA", "Eastern Europe": "EEU", "Northern Europe": "WEU",
    "Southern Europe": "WEU", "Western Europe": "WEU", "Northern America": "NAM", "Caribbean": "LAC",
    "Central America": "LAC", "South America": "LAC", "Australia/New Zealand": "OCE", "Melanesia": "OCE",
    "Micronesia": "OCE", "Polynesia": "OCE",
}
REGION_OVERRIDE = {"IRN": "WAS", "USA": "NAM", "CAN": "NAM", "BMU": "NAM", "GRL": "NAM", "SPM": "NAM"}
NAME_OVERRIDE = {"TWN": "中国台湾", "HKG": "中国香港", "MAC": "中国澳门", "PSE": "巴勒斯坦", "SWZ": "斯威士兰",
                 "COD": "刚果（金）", "COG": "刚果（布）", "PRK": "朝鲜", "KOR": "韩国", "XKX": "科索沃"}

WPP_FIELDS = {
    "pop": "TPopulation1July", "births": "Births", "le": "LEx", "le_m": "LExMale", "le_f": "LExFemale",
    "tfr": "TFR", "med_age": "MedianAgePop", "imr": "IMR", "q5": "Q5", "srb": "SRB", "cnmr": "CNMR", "mac": "MAC",
    "cdr": "CDR", "q1560_m": "Q1560Male", "q1560_f": "Q1560Female",
}

WB = {
    # key: (label_zh, unit, decimals, rule, cap)
    "gdp_pc_ppp": ("人均GDP(购买力平价, 2021年国际元)", "$", 0, "gdp", None),
    "gdp_growth": ("GDP增长率", "%", 1, "derived", None),
    "gini": ("基尼系数", "", 1, "hold", None),
    "poverty": ("极端贫困率(每天3美元以下)", "%", 1, "model", None),
    "unemployment": ("失业率", "%", 1, "hold", None),
    "youth_unemp": ("青年失业率(15-24岁)", "%", 1, "hold", None),
    "internet": ("互联网使用率", "%", 1, "logistic", 97),
    "mobile": ("每百人移动电话", "", 0, "logistic", 135),
    "electricity": ("通电率", "%", 1, "logistic", 100),
    "water": ("基本饮用水普及率", "%", 1, "logistic", 100),
    "urban": ("城镇化率", "%", 1, "urban", 92),
    "sec_enroll": ("中学毛入学率", "%", 1, "logistic", 105),
    "ter_enroll": ("高等教育毛入学率", "%", 1, "logistic", 95),
    "literacy": ("成人识字率", "%", 1, "logistic", 100),
    "health_exp_pc": ("人均卫生支出(美元)", "$", 0, "health", None),
    "physicians": ("每千人医生数", "", 2, "slowgrow", 6),
    "homicide": ("凶杀率(每十万人)", "", 1, "decline1", None),
    "suicide": ("自杀率(每十万人)", "", 1, "decline1", None),
    "road_deaths": ("道路交通死亡率(每十万人)", "", 1, "decline1", None),
    "inflation": ("通货膨胀率", "%", 1, "infl", None),
    "ppp_factor": ("购买力平价换算因子(本币/国际元)", "", 3, "hold", None),
    "fx_rate": ("官方汇率(本币/美元)", "", 3, "hold", None),
    "female_lfp": ("女性劳动参与率", "%", 1, "hold", None),
    "adol_fert": ("青少年生育率(每千名15-19岁女性)", "", 1, "decline2", None),
    "maternal_mort": ("孕产妇死亡率(每十万活产)", "", 0, "decline3", None),
    "ncd_mort": ("30-70岁死于四大慢性病概率", "%", 1, "decline1", None),
    "smoking": ("吸烟率", "%", 1, "decline15", None),
}
PROJECTION_NOTES = {
    "gdp": "最后观测年之后：近十年人均增速与向前沿收敛速度加权（近期权重按 8 年时间常数衰减）；前沿 7.5 万国际元，年增 1.2%。",
    "logistic": "按近年增速向上限逐年逼近。",
    "urban": "按近年增速缓慢逼近 92% 上限。",
    "hold": "保持最近 3 次观测的平均值。",
    "model": "对数正态收入分布：由人均GDP与基尼系数推算，按国家用最近观测校准。",
    "health": "随人均GDP同比例增长（弹性 1.1）。",
    "slowgrow": "每年增长 1%，不超过上限。",
    "decline1": "每年下降 1%。", "decline2": "每年下降 2%。", "decline3": "每年下降 3%，下限 2。",
    "decline15": "每年下降 1.5%。", "infl": "未来按 3% 显示（仅展示）。", "derived": "由人均GDP序列推导。",
}

def num(s):
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def norm_ppf(p):
    # Acklam's approximation
    p = min(max(p, 1e-9), 1 - 1e-9)
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549671010322837e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
    pl = 0.02425
    if p < pl:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > 1 - pl:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5
    r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


def sigma_from_gini(g):
    g = min(max(g / 100.0, 0.15), 0.75)
    return math.sqrt(2) * norm_ppf((g + 1) / 2)


def poverty_rate(gdp, gini, s, line=3.0):
    if not gdp or gdp <= 0:
        return None
    sig = sigma_from_gini(gini)
    mu = s * gdp / 365.0
    return 100 * norm_cdf((math.log(line / mu) + sig * sig / 2) / sig)


# ---------------------------------------------------------------- WPP indicators
def load_wpp():
    locs, rows = {}, {}
    with gzip.open(RAW / "WPP2024_Demographic_Indicators_Medium.csv.gz", "rt", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            locid = row["LocID"]
            locs.setdefault(locid, (row["Location"], row["LocTypeName"], row["ParentID"]))
            iso3 = row["ISO3_code"]
            if not iso3 or row["LocTypeName"] != "Country/Area":
                continue
            y = int(row["Time"])
            if y not in YIDX:
                continue
            c = rows.setdefault(iso3, {"iso2": row["ISO2_code"], "en": row["Location"], "parent": row["ParentID"], "s": {}})
            for k, col in WPP_FIELDS.items():
                c["s"].setdefault(k, [None] * len(YEARS))[YIDX[y]] = num(row[col])
    return locs, rows


def load_mortality(countries):
    """Return dict iso3 -> array of len(YEARS)*2*22 mx values."""
    n = len(YEARS) * 2 * 22
    mx = {iso: [None] * n for iso in countries}
    for fn in ["WPP2024_Life_Table_Abridged_Medium_1950-2023.csv.gz", "WPP2024_Life_Table_Abridged_Medium_2024-2100.csv.gz"]:
        with gzip.open(RAW / fn, "rt", encoding="utf-8") as f:
            r = csv.reader(f)
            h = next(r)
            ix = {k.lstrip("\ufeff"): i for i, k in enumerate(h)}
            for row in r:
                iso = row[ix["ISO3_code"]]
                if iso not in mx or row[ix["LocTypeName"]] != "Country/Area":
                    continue
                y = int(row[ix["Time"]])
                if y not in YIDX:
                    continue
                sex = row[ix["SexID"]]
                if sex not in ("1", "2"):
                    continue
                a = int(row[ix["AgeGrpStart"]])
                if a not in AGE_IDX:
                    continue
                k = (YIDX[y] * 2 + (int(sex) - 1)) * 22 + AGE_IDX[a]
                mx[iso][k] = num(row[ix["mx"]])
        print("mortality read", fn, file=sys.stderr)
    return mx


# ---------------------------------------------------------------- World Bank
def load_wb():
    meta = json.load(open(RAW / "wb" / "_countries.json", encoding="utf-8"))[1]
    wbmeta = {m["id"]: {"wbRegion": m["region"]["id"], "income": m["incomeLevel"]["id"]} for m in meta if m["region"]["id"]}
    series = {}
    for key in WB:
        p = RAW / "wb" / f"{key}.json"
        if not p.exists():
            continue
        d = json.load(open(p, encoding="utf-8"))
        if len(d) < 2 or not d[1]:
            continue
        for rec in d[1]:
            iso = rec["countryiso3code"]
            v = rec["value"]
            if iso and v is not None:
                series.setdefault(iso, {}).setdefault(key, {})[int(rec["date"])] = float(v)
    return wbmeta, series


def interp_hist(obs):
    """obs: {year: value}. Return dict year->value for 2000..last obs year with linear interpolation and
    backward hold before the first observation; plus first/last obs years."""
    if not obs:
        return {}, None, None
    ys = sorted(y for y in obs if 1990 <= y <= 2025)
    if not ys:
        return {}, None, None
    out = {}
    last = ys[-1]
    for y in range(2000, last + 1):
        if y in obs:
            out[y] = obs[y]
            continue
        lo = max((t for t in ys if t < y), default=None)
        hi = min((t for t in ys if t > y), default=None)
        if lo is None:
            out[y] = obs[hi]
        elif hi is None:
            out[y] = obs[lo]
        else:
            out[y] = obs[lo] + (obs[hi] - obs[lo]) * (y - lo) / (hi - lo)
    return out, ys[0], last


def project(rule, hist, last, cap, gdp_full=None):
    """Extend hist (year->value up to last) to 2100 annually."""
    vals = dict(hist)
    if last is None:
        return vals
    recent = [vals[y] for y in range(max(2000, last - 2), last + 1) if y in vals]
    base = sum(recent) / len(recent) if recent else vals[last]
    x = vals[last]
    slope = (vals[last] - vals.get(last - 5, vals[last])) / 5 if last - 5 in vals else 0
    for y in range(last + 1, 2101):
        if rule == "hold":
            x = base
        elif rule in ("logistic", "urban"):
            room = max(cap - x, 0.0)
            if rule == "urban":
                k = min(max(slope / room, 0.004), 0.03) if room > 0.5 else 0.0
            else:
                k = min(max(slope / room, 0.02), 0.15) if room > 0.5 else 0.0
            x = x + k * room
        elif rule == "slowgrow":
            x = min(x * 1.01, cap)
        elif rule == "decline1":
            x = x * 0.99
        elif rule == "decline2":
            x = x * 0.98
        elif rule == "decline3":
            x = max(x * 0.97, 2.0)
        elif rule == "decline15":
            x = x * 0.985
        elif rule == "infl":
            x = 3.0
        elif rule == "health":
            if gdp_full and y in gdp_full and (y - 1) in gdp_full and gdp_full[y - 1]:
                x = x * (gdp_full[y] / gdp_full[y - 1]) ** 1.1
        vals[y] = x
    return vals


def project_gdp(hist, last):
    vals = dict(hist)
    if last is None:
        return vals
    ys = [y for y in range(last - 10, last + 1) if y in vals and vals[y] > 0]
    if len(ys) >= 2:
        recent = (vals[ys[-1]] / vals[ys[0]]) ** (1 / (ys[-1] - ys[0])) - 1
    else:
        recent = 0.02
    recent = min(max(recent, -0.03), 0.07)
    x = vals[last]
    for y in range(last + 1, 2101):
        frontier = 75000 * 1.012 ** (y - 2025)
        conv = 0.012 + 0.012 * math.log(max(frontier / max(x, 300), 1.0))
        conv = min(max(conv, 0.004), 0.05)
        w = math.exp(-(y - last) / 8)
        g = w * recent + (1 - w) * conv
        x = x * (1 + g)
        vals[y] = x
    return vals


def zh_names(iso2s):
    js = "const d=new Intl.DisplayNames(['zh-Hans'],{type:'region'});const out={};for(const c of process.argv.slice(1)){try{out[c]=d.of(c)}catch(e){}}console.log(JSON.stringify(out))"
    res = subprocess.run(["node", "-e", js] + iso2s, capture_output=True, text=True, encoding="utf-8")
    return json.loads(res.stdout)


def rnd(v, d):
    if v is None:
        return None
    return round(v, d) if d else int(round(v))


def main():
    locs, wpp = load_wpp()
    print("wpp countries", len(wpp), file=sys.stderr)
    wbmeta, wbs = load_wb()
    names = zh_names([c["iso2"] for c in wpp.values() if c["iso2"]])

    countries = {}
    for iso, c in wpp.items():
        sub = locs.get(c["parent"], ("", "", ""))[0]
        region = REGION_OVERRIDE.get(iso) or SUBREGION_TO_REGION.get(sub)
        if not region:
            print("no region", iso, sub, file=sys.stderr)
            continue
        zh = NAME_OVERRIDE.get(iso) or names.get(c["iso2"]) or c["en"]
        countries[iso] = {"name": zh, "en": c["en"], "iso2": c["iso2"], "region": region, "subregion": sub,
                          "wbRegion": wbmeta.get(iso, {}).get("wbRegion"), "incomeWB": wbmeta.get(iso, {}).get("income"),
                          "wpp": c["s"], "wb": {}, "imputed": [], "lastObs": {}}

    # --- World Bank series: interpolate history, impute missing, project
    hist_all = {}
    for iso in countries:
        hist_all[iso] = {}
        for key in WB:
            if key in ("gdp_growth", "poverty"):
                continue
            h, first, last = interp_hist(wbs.get(iso, {}).get(key, {}))
            hist_all[iso][key] = (h, first, last)

    # Taiwan is not in WDI: anchor GDP to Korea with the IMF WEO PPP ratio (approx 1.20 in 2000 -> 1.27 in 2024)
    if "TWN" in countries and "KOR" in hist_all:
        kh, kf, kl = hist_all["KOR"]["gdp_pc_ppp"]
        tw = {y: v * (1.20 + 0.07 * (y - 2000) / 24) for y, v in kh.items()}
        hist_all["TWN"]["gdp_pc_ppp"] = (tw, kf, kl)
        countries["TWN"]["imputed"].append("gdp_pc_ppp(按IMF WEO台湾/韩国购买力比估算)")
        for key in ("internet", "mobile", "electricity", "water", "urban", "sec_enroll", "ter_enroll", "literacy", "physicians", "health_exp_pc", "unemployment", "youth_unemp", "gini", "female_lfp"):
            if not hist_all["TWN"][key][0]:
                hist_all["TWN"][key] = hist_all["KOR"][key]
                countries["TWN"]["imputed"].append(key + "(参照韩国)")

    # group medians for imputation: (region, income) by year
    def group_key(iso):
        c = countries[iso]
        return (c["region"], c["incomeWB"] or "UNK")

    full = {iso: {} for iso in countries}
    for iso in countries:
        h, first, last = hist_all[iso]["gdp_pc_ppp"]
        full[iso]["gdp_pc_ppp"] = project_gdp(h, last) if h else {}
        countries[iso]["lastObs"]["gdp_pc_ppp"] = last
    # impute gdp for countries without any: median of same region+income, else region
    def median_series(key, members):
        out = {}
        for y in range(2000, 2101):
            vs = [full[m][key][y] for m in members if full[m].get(key) and y in full[m][key]]
            if vs:
                out[y] = statistics.median(vs)
        return out
    groups = {}
    for iso in countries:
        groups.setdefault(group_key(iso), []).append(iso)
    regions = {}
    for iso in countries:
        regions.setdefault(countries[iso]["region"], []).append(iso)
    for iso in countries:
        if not full[iso]["gdp_pc_ppp"]:
            mem = [m for m in groups[group_key(iso)] if full[m]["gdp_pc_ppp"]] or [m for m in regions[countries[iso]["region"]] if full[m]["gdp_pc_ppp"]]
            full[iso]["gdp_pc_ppp"] = median_series("gdp_pc_ppp", mem)
            countries[iso]["imputed"].append("gdp_pc_ppp")

    for key, (label, unit, dec, rule, cap) in WB.items():
        if key in ("gdp_pc_ppp", "gdp_growth", "poverty"):
            continue
        for iso in countries:
            h, first, last = hist_all[iso][key]
            countries[iso]["lastObs"][key] = last
            if h:
                full[iso][key] = project(rule, h, last, cap, full[iso]["gdp_pc_ppp"])
        for iso in countries:
            if not full[iso].get(key):
                mem = [m for m in groups[group_key(iso)] if full[m].get(key)] or [m for m in regions[countries[iso]["region"]] if full[m].get(key)]
                if mem:
                    full[iso][key] = median_series(key, mem)
                    countries[iso]["imputed"].append(key)

    # gdp growth derived
    for iso in countries:
        g = full[iso]["gdp_pc_ppp"]
        full[iso]["gdp_growth"] = {y: 100 * (g[y] / g[y - 1] - 1) for y in g if (y - 1) in g and g[y - 1]}

    # poverty: observations interpolated; outside the observed range a lognormal model (GDP + Gini, fixed
    # consumption share 0.6) shifted in probit space so it joins the nearest observation, shift decaying over 10 years.
    CS = 0.6
    def probit(p):
        return norm_ppf(min(max(p / 100.0, 1e-7), 1 - 1e-7))
    for iso in countries:
        countries[iso]["consumption_share"] = CS
        gdp, gini = full[iso]["gdp_pc_ppp"], full[iso].get("gini", {})
        model = {y: poverty_rate(gdp[y], gini[y], CS) for y in range(2000, 2101) if y in gdp and y in gini}
        h, first, last = interp_hist(wbs.get(iso, {}).get("poverty", {}))
        pov = {}
        for y in range(2000, 2101):
            if h and first is not None and max(first, 2000) <= y <= last:
                pov[y] = h[y]
            elif y in model:
                if h and first is not None and model.get(last if y > last else max(first, 2000)) is not None:
                    anchor = last if y > last else max(first, 2000)
                    delta = probit(h[anchor]) - probit(model[anchor])
                    w = 1.0
                    pov[y] = 100 * norm_cdf(probit(model[y]) + delta * w)
                else:
                    pov[y] = model[y]
        full[iso]["poverty"] = pov
        if not h:
            countries[iso]["imputed"].append("poverty(模型)")

    # write compact series on the YEARS grid
    for iso, c in countries.items():
        for key, (label, unit, dec, rule, cap) in WB.items():
            s = full[iso].get(key, {})
            c["wb"][key] = [rnd(s.get(y), dec) for y in YEARS]
        wppc = {}
        for k, arr in c["wpp"].items():
            d = 0 if k in ("pop", "births") else 2
            if k in ("pop", "births"):
                wppc[k] = [rnd(v, 3) if v is not None and v < 10 else rnd(v, 0) for v in arr]
            else:
                wppc[k] = [rnd(v, 2) for v in arr]
        c["wpp"] = wppc
        c["income_now"] = c.pop("incomeWB")

    out = {
        "meta": {
            "generated": "2026-10-24",
            "years": YEARS,
            "wpp_fields": {k: v for k, v in WPP_FIELDS.items()},
            "wpp_units": {"pop": "千人", "births": "千人/年", "le": "岁", "tfr": "每名妇女", "med_age": "岁", "imr": "每千活产",
                           "q5": "每千活产", "srb": "男婴/百女婴", "cnmr": "每千人净迁移", "mac": "岁", "cdr": "每千人", "q1560_m": "每千人", "q1560_f": "每千人"},
            "wb_indicators": {k: {"label": v[0], "unit": v[1], "rule": v[3], "projection": PROJECTION_NOTES[v[3]]} for k, v in WB.items()},
            "sources": {
                "wpp": "United Nations, DESA, Population Division (2024). World Population Prospects 2024, Medium variant. https://population.un.org/wpp/",
                "wb": "World Bank, World Development Indicators (accessed 2026-10-24). https://data.worldbank.org/",
                "twn": "Taiwan is not covered by WDI; GDP per capita estimated from Korea x IMF WEO PPP ratio, other gaps filled from Korea.",
            },
            "notes": "WB values after lastObs[key] and all values after 2026 are projections; imputed[] lists indicators filled from regional medians.",
        },
        "countries": countries,
    }
    (OUT / "countries.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("countries.json", (OUT / "countries.json").stat().st_size, "bytes,", len(countries), "countries", file=sys.stderr)

    # mortality
    mx = load_mortality(countries)
    order = sorted(countries)
    buf = array("H")
    missing = 0
    for iso in order:
        arr = mx[iso]
        for k, v in enumerate(arr):
            if v is None:
                missing += 1
                v = 0.5
            v = min(max(v, 1e-6), 1.5)
            q = int(round((-math.log(v) + 1.0) * 4000))
            buf.append(min(max(q, 0), 65535))
    mort = {
        "meta": {"years": YEARS, "ages": AGE_STARTS, "sexes": ["male", "female"], "countries": order,
                 "encoding": "Uint16 little-endian; mx = exp(1 - v/4000); index = ((country*nYears + year)*2 + sex)*22 + age",
                 "source": "UN WPP 2024 abridged life tables (Medium variant), mx (central death rate)", "missing_filled": missing},
        "b64": base64.b64encode(buf.tobytes()).decode("ascii"),
    }
    (OUT / "mortality.json").write_text(json.dumps(mort, separators=(",", ":")), encoding="utf-8")
    print("mortality.json", (OUT / "mortality.json").stat().st_size, "bytes; missing", missing, file=sys.stderr)


if __name__ == "__main__":
    main()
