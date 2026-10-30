"""Merge research/*.json into data/content.json (tolerates missing files so development can start early)."""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
R = ROOT / "research"
OUT = ROOT / "data" / "content.json"


def load(name):
    p = R / name
    if not p.exists():
        print("missing", name, file=sys.stderr)
        return None
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception as e:
        print("invalid", name, e, file=sys.stderr)
        return None


def main():
    history, seen = [], set()
    for f in sorted(R.glob("history_*.json")):
        d = load(f.name) or {}
        for ev in d.get("events", []):
            if not isinstance(ev, dict) or not ev.get("id") or not ev.get("title"):
                continue
            eid = ev["id"]
            if eid in seen:
                eid = f"{eid}_{f.stem.split('_')[-1]}"
                ev["id"] = eid
            seen.add(eid)
            ev["_file"] = f.stem
            history.append(ev)
    history.sort(key=lambda e: (e.get("year") or 0, -(e.get("importance") or 0)))

    future = {"baseline_assumptions": [], "dimensions": [], "milestones": [], "random_shocks": []}
    for name in ("future_part_a.json", "future_part_b.json", "future_scenarios.json"):
        d = load(name) or {}
        for k in future:
            future[k].extend(d.get(k, []) or [])
    # normalise branch probabilities per dimension
    for dim in future["dimensions"]:
        br = dim.get("branches") or []
        tot = sum(max(0.0, float(b.get("prob") or 0)) for b in br) or 1.0
        for b in br:
            b["prob"] = round(max(0.0, float(b.get("prob") or 0)) / tot, 4)

    econ = load("econ_reference.json") or {}
    lp = {"countries": {}, "defaults_by_income_group": {}}
    for name in ("life_paths_a.json", "life_paths_b.json", "life_paths.json"):
        d = load(name) or {}
        lp["countries"].update(d.get("countries", {}) or {})
        if d.get("defaults_by_income_group"):
            lp["defaults_by_income_group"].update(d["defaults_by_income_group"])
    names = load("names.json") or {"countries": {}}

    content = {"meta": {"generated": "2026-10-24", "counts": {
        "history": len(history), "dimensions": len(future["dimensions"]), "milestones": len(future["milestones"]),
        "shocks": len(future["random_shocks"]), "lifePaths": len(lp["countries"]), "names": len(names.get("countries", {}))}},
        "history": history, "future": future, "econ": econ, "lifePaths": lp, "names": names}
    OUT.write_text(json.dumps(content, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("content.json", OUT.stat().st_size, content["meta"]["counts"], file=sys.stderr)


if __name__ == "__main__":
    main()
