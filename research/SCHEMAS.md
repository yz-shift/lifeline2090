# LifeLine 2090 — research data schemas

All research files are UTF-8 JSON, Chinese (zh-Hans) for every player-facing string, neutral and factual tone.
Validate every file with `python -c "import json,sys;json.load(open(sys.argv[1],encoding='utf-8'))" FILE` before finishing.

## Shared conventions
- Countries: ISO 3166-1 alpha-3 codes as used by UN WPP 2024 (e.g. CHN, IND, USA, TWN = "中国台湾", HKG = "中国香港", MAC = "中国澳门", PSE, XKX not used -> use SRB/none).
- Region codes (game regions; membership = UN M49 sub-region, except Iran -> WAS):
  EAS 东亚 (CHN HKG MAC TWN JPN KOR PRK MNG), SEA 东南亚, SAS 南亚 (IND PAK BGD LKA NPL BTN MDV AFG),
  CAS 中亚, WAS 西亚/中东 (incl. IRN TUR SAU IRQ SYR ISR PSE JOR LBN YEM ARE OMN QAT KWT BHR GEO ARM AZE CYP),
  NAF 北非, SSA 撒哈拉以南非洲, EEU 东欧 (incl. RUS UKR BLR POL CZE SVK HUN ROU BGR MDA),
  WEU 西欧/北欧/南欧 (rest of Europe), NAM 北美 (USA CAN), LAC 拉美与加勒比, OCE 大洋洲.
- Years are integers. Dates as "YYYY-MM-DD" or "YYYY-MM" when the day is unknown.
- Every factual item carries `sources` (URLs or precise citations) and `confidence` ("high" | "medium").
  Never invent a source. If unsure of a detail, leave it out rather than guess.

## 1. History events (history_*.json)
```json
{ "file": "history_global_2000_2012", "events": [ {
  "id": "gfc_2008",                      // unique snake_case
  "start": "2008-09-15", "end": "2009-06", // end optional
  "year": 2008, "end_year": 2009,         // integer years the event is "active" for players
  "scope": "global" | "regions" | "countries",
  "regions": ["NAM","WEU"],              // when scope=regions (may also list countries)
  "countries": ["USA","GBR","ISL"],       // ISO3, the most affected countries (also for global events)
  "category": "economy|war|conflict|disaster|epidemic|technology|politics|policy|society|science|sport|culture",
  "title": "全球金融危机",
  "summary": "雷曼兄弟破产引发全球金融危机……(1-3 句, 事实)",
  "personal_hooks": ["一个普通人在当时可能怎样经历这件事 (1 句)", "..."],  // 1-3 short lines, generic, no invented specifics
  "effects": { "economy": -3, "health": 0, "happiness": -1, "safety": 0, "education": 0, "tech": 0 }, // ints -3..3 for the affected population
  "mortality": { "mult": 1.0, "ages": [0, 120] },  // optional, all-cause hazard multiplier for affected countries in active years (approximate; omit if negligible)
  "migration_push": 0,                    // 0..3 refugee / emigration pressure
  "importance": 1-5,                      // 5 = shaped the whole world
  "sources": ["https://..."], "confidence": "high"
} ] }
```

## 2. Future scenarios (future_scenarios.json) — 2026-2090 projections, never presented as fact
```json
{ "baseline_assumptions": [ {"domain":"demography|economy|technology|climate|health|geopolitics|energy|society|space",
     "statement":"基于 UN WPP 2024 中方案……", "numbers": {...}, "sources":[...] } ],
  "dimensions": [ { "id":"ai", "title":"人工智能走向", "branches": [
      {"id":"ai_gradual", "title":"渐进普及", "prob":0.5, "description":"...",
       "modifiers": {"gdp_growth_add": 0.3, "unemployment_add": 1.0, "life_exp_add_by_2090": 1.0, "inequality_add": 0.02},  // engine-level knobs, documented below
       "region_overrides": {"SSA": {"gdp_growth_add": 0.1}} } ] } ],
  "milestones": [ { "id":"...", "year": 2031, "year_range":[2029,2035], "requires": {"ai":["ai_transformative"]},  // branch ids, omit = any
      "scope":"global|regions|countries", "regions":[...], "countries":[...], "category":"...",
      "title":"...", "summary":"...", "personal_hooks":[...], "effects":{...}, "mortality":{...}, "migration_push":0,
      "prob": 0.8, "basis": "为什么这是合理推演(引用当前趋势)", "sources":[...] } ],
  "random_shocks": [ {"id":"pandemic_major", "title":"新的大流行", "annual_prob": 0.02, "requires":{}, "effects":{...}, "mortality":{"mult":1.1,"ages":[60,120]}, "duration_years":2, "basis":"...", "sources":[...]} ]
}
```
Modifier knobs the engine understands (all optional, additive unless noted):
`gdp_growth_add` (pp/yr), `unemployment_add` (pp), `life_exp_add_by_2090` (years, phased in linearly from 2026),
`mortality_mult` (multiplier from 2030 on), `inequality_add` (Gini points 0-1 scale), `internet_ceiling` (0-100),
`heat_risk` (0-3), `sea_level_risk` (0-3, coastal countries), `conflict_risk_add` (annual prob of war shock, regional),
`migration_push_add` (0-3), `retirement_age_add` (years by 2060), `education_years_add`, `happiness_add` (-3..3 drift).

## 3. Economy & mortality references (econ_reference.json)
```json
{ "asset_returns": { "years":[2000,...,2025],
    "series": { "us_stocks": {"name":"美国股市 (标普500 含股息)", "values":[-9.1,...], "sources":[...]},
                "cn_stocks": {...}, "jp_stocks": {...}, "in_stocks": {...}, "eu_stocks": {...}, "em_stocks": {...}, "world_stocks": {...},
                "gold": {...}, "us_bonds": {...}, "us_cash": {...}, "us_housing": {...}, "bitcoin": {"values":[null,...], "note":"2010 前无市场"} },
    "country_market": {"USA":"us_stocks","CHN":"cn_stocks", "...": "...", "_default":"em_stocks"} },
  "causes_of_death": { "age_bands": [[0,4],[5,14],[15,29],[30,49],[50,69],[70,120]],
     "income_groups": ["LIC","LMC","UMC","HIC"],
     "causes": [{"id":"cvd","name":"心血管疾病"}, ...],
     "shares": { "LIC": [[0.05, ...per cause...], ...per age band...], ... }, "sources":[...] } }
```

## 4. Life-path institutions (life_paths.json)
```json
{ "countries": { "CHN": {
     "currency": {"code":"CNY","name":"人民币","symbol":"¥"},
     "school_start_age": 6, "compulsory_years": 9, "key_exams": [{"age":15,"name":"中考"},{"age":18,"name":"高考"}],
     "conscription": {"exists": false, "sex": "male|all", "months": 0, "since": null, "until": null, "note":""},
     "legal_marriage_age": {"male":22, "female":20},
     "median_first_marriage_age": {"male": 28, "female": 26, "year": 2020},
     "retirement_age": [{"from":2000,"male":60,"female":50}, {"from":2025,"male":"60→63 渐进","female":"50/55→55/58 渐进"}],
     "common_destinations": ["USA","CAN","AUS","GBR","JPN","SGP"],
     "notes": ["户籍制度影响上学与就业", "..."], "sources":[...] } },
  "defaults_by_income_group": { "LIC": {...same keys...}, "LMC": {...}, "UMC": {...}, "HIC": {...} } }
```

## 5. Names (names.json)
```json
{ "countries": { "CHN": { "surnames": ["王","李",...20], "male": ["子轩","浩然",...20], "female": ["梓涵","欣怡",...20],
                         "format": "surname+given" | "given·surname" | "given surname",
                         "era_note": "2000s 与 2020s 常见名不同时可按 era 字段分组" },
   "IND": { "surnames": ["夏尔马",...], "male": ["拉胡尔",...], "female": ["普丽娅",...], "format":"given·surname" } } }
```
Names are written in Chinese transliteration (standard 新华社 style), plus `"latin"` arrays in the same order for non-Chinese names.
