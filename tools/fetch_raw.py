"""Download raw public data: UN WPP 2024 (indicators + abridged life tables) and World Bank WDI indicators.
Idempotent: skips files that already exist with non-zero size."""
import json, os, sys, time, urllib.request, urllib.parse
from pathlib import Path

RAW = Path(__file__).resolve().parent.parent / "raw"
RAW.mkdir(exist_ok=True)
WPP = "https://population.un.org/wpp/assets/Excel%20Files/1_Indicator%20(Standard)/CSV_FILES/"
WPP_FILES = [
    "WPP2024_Demographic_Indicators_Medium.csv.gz",
    "WPP2024_Life_Table_Abridged_Medium_1950-2023.csv.gz",
    "WPP2024_Life_Table_Abridged_Medium_2024-2100.csv.gz",
]
WB_INDICATORS = {
    "gdp_pc_ppp": "NY.GDP.PCAP.PP.KD",
    "gdp_growth": "NY.GDP.MKTP.KD.ZG",
    "gini": "SI.POV.GINI",
    "poverty": "SI.POV.DDAY",
    "unemployment": "SL.UEM.TOTL.ZS",
    "youth_unemp": "SL.UEM.1524.ZS",
    "internet": "IT.NET.USER.ZS",
    "mobile": "IT.CEL.SETS.P2",
    "electricity": "EG.ELC.ACCS.ZS",
    "water": "SH.H2O.BASW.ZS",
    "urban": "SP.URB.TOTL.IN.ZS",
    "sec_enroll": "SE.SEC.ENRR",
    "ter_enroll": "SE.TER.ENRR",
    "literacy": "SE.ADT.LITR.ZS",
    "health_exp_pc": "SH.XPD.CHEX.PC.CD",
    "physicians": "SH.MED.PHYS.ZS",
    "homicide": "VC.IHR.PSRC.P5",
    "suicide": "SH.STA.SUIC.P5",
    "road_deaths": "SH.STA.TRAF.P5",
    "inflation": "FP.CPI.TOTL.ZG",
    "ppp_factor": "PA.NUS.PRVT.PP",
    "fx_rate": "PA.NUS.FCRF",
    "female_lfp": "SL.TLF.CACT.FE.ZS",
    "adol_fert": "SP.ADO.TFRT",
    "maternal_mort": "SH.STA.MMRT",
    "ncd_mort": "SH.DYN.NCOM.ZS",
    "smoking": "SH.PRV.SMOK",
    "share_bottom20": "SI.DST.FRST.20",
    "share_top20": "SI.DST.05TH.20",
}


def get(url, dest=None, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "LifeLine2090-data/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                if dest is None:
                    return r.read()
                tmp = dest.with_suffix(dest.suffix + ".part")
                with open(tmp, "wb") as f:
                    while True:
                        b = r.read(1 << 20)
                        if not b:
                            break
                        f.write(b)
                tmp.replace(dest)
                return None
        except Exception as e:
            print("retry", i, url, e, flush=True)
            time.sleep(3 * (i + 1))
    raise RuntimeError("failed " + url)


def main():
    wb_dir = RAW / "wb"
    wb_dir.mkdir(exist_ok=True)
    meta = wb_dir / "_countries.json"
    if not meta.exists():
        meta.write_bytes(get("https://api.worldbank.org/v2/country?format=json&per_page=400"))
        print("wb countries ok", flush=True)
    for key, code in WB_INDICATORS.items():
        dest = wb_dir / f"{key}.json"
        if dest.exists() and dest.stat().st_size > 1000:
            continue
        url = f"https://api.worldbank.org/v2/country/all/indicator/{code}?date=2000:2025&format=json&per_page=20000"
        data = get(url)
        dest.write_bytes(data)
        print("wb", key, len(data), flush=True)
    for f in WPP_FILES:
        dest = RAW / f
        if dest.exists() and dest.stat().st_size > 1_000_000:
            continue
        print("downloading", f, flush=True)
        get(WPP + f, dest)
        print("done", f, dest.stat().st_size, flush=True)
    print("ALL DONE", flush=True)


if __name__ == "__main__":
    main()
