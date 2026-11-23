"""매매 복기노트: 코스피·코스닥 일별 시장 데이터를 네이버 금융에서 모아 Supabase market_days 표에 저장.

python scripts/market.py --days 7            # 최근 7일 (매일 자동 실행)
python scripts/market.py --days 400          # 1년치 채우기
python scripts/market.py --days 10 --dry-run # 저장 없이 출력만
"""
import argparse, ast, datetime as dt, io, json, math, os, re, sys, time, urllib.request
import pandas as pd

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Referer": "https://finance.naver.com/"}
MARKETS = {"kospi": {"code": "KOSPI", "sosok": "01"}, "kosdaq": {"code": "KOSDAQ", "sosok": "02"}}


def fetch(url, enc="euc-kr", tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
                return r.read().decode(enc, errors="replace")
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def num(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    s = re.sub(r"[,%\s]", "", str(v)).replace("+", "")
    try:
        return float(s)
    except ValueError:
        return None


def ymd(s):
    m = re.match(r"^\s*(\d{2,4})\.(\d{1,2})\.(\d{1,2})", str(s))
    if not m:
        return None
    y = int(m.group(1)); y = y + 2000 if y < 100 else y
    return f"{y:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


def index_close_table(code, pages):
    """일별 체결가·등락률·거래량(천주)·거래대금(백만원)."""
    out = {}
    for p in range(1, pages + 1):
        html = fetch(f"https://finance.naver.com/sise/sise_index_day.naver?code={code}&page={p}")
        df = pd.read_html(io.StringIO(html))[0]
        df.columns = [str(c) for c in df.columns]
        got = 0
        for _, r in df.iterrows():
            d = ymd(r.iloc[0])
            if not d:
                continue
            got += 1
            out[d] = {"close": num(r.iloc[1]), "chgPct": num(r.iloc[3]), "vol": num(r.iloc[4]), "value": num(r.iloc[5])}
        if got == 0:
            break
        time.sleep(0.15)
    return out


def index_ohlc(code, start, end):
    txt = fetch(f"https://api.finance.naver.com/siseJson.naver?symbol={code}&requestType=1"
                f"&startTime={start:%Y%m%d}&endTime={end:%Y%m%d}&timeframe=day", enc="utf-8")
    rows = ast.literal_eval(re.sub(r"\s+", "", txt))
    out = {}
    for r in rows[1:]:
        d = str(r[0]); d = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
        out[d] = {"open": r[1], "high": r[2], "low": r[3], "close": r[4]}
    return out


def investor_flow(sosok, end, pages):
    """투자자별 순매수 (억원): 개인, 외국인, 기관계."""
    out = {}
    for p in range(1, pages + 1):
        html = fetch(f"https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate={end:%Y%m%d}&sosok={sosok}&page={p}")
        df = pd.read_html(io.StringIO(html))[0]
        got = 0
        for _, r in df.iterrows():
            d = ymd(r.iloc[0])
            if not d:
                continue
            got += 1
            out[d] = {"indiv": num(r.iloc[1]), "foreign": num(r.iloc[2]), "inst": num(r.iloc[3])}
        if got == 0:
            break
        time.sleep(0.15)
    return out


def collect(days):
    end = dt.date.today() + dt.timedelta(days=1)
    start = end - dt.timedelta(days=days + 1)
    idx_pages = math.ceil(days * 0.72 / 6) + 2
    flow_pages = math.ceil(days * 0.72 / 10) + 2
    merged = {}
    for key, m in MARKETS.items():
        closes = index_close_table(m["code"], idx_pages)
        ohlc = index_ohlc(m["code"], start, end)
        flow = investor_flow(m["sosok"], end, flow_pages)
        print(f"[{key}] 종가표 {len(closes)}일 · 시고저종 {len(ohlc)}일 · 수급 {len(flow)}일")
        for d in set(closes) | set(ohlc) | set(flow):
            if d < start.isoformat():
                continue
            ent = merged.setdefault(d, {})
            info = {**closes.get(d, {}), **{k: v for k, v in ohlc.get(d, {}).items() if v is not None}}
            if info:
                ent[key] = info
            if d in flow:
                ent.setdefault("flow", {})[key] = flow[d]
    return dict(sorted(merged.items()))


def upsert(rows):
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SECRET_KEY", "")
    if not url or not key:
        sys.exit("SUPABASE_URL 또는 SUPABASE_SECRET_KEY가 없어요. GitHub 저장소 Settings → Secrets and variables → Actions에 넣어 주세요.")
    headers = {"apikey": key, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"}
    if key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {key}"
    payload = [{"date": d, "data": v, "updated_at": dt.datetime.utcnow().isoformat() + "Z"} for d, v in rows.items()]
    for i in range(0, len(payload), 200):
        req = urllib.request.Request(f"{url}/rest/v1/market_days?on_conflict=date", method="POST",
                                     data=json.dumps(payload[i:i + 200], ensure_ascii=False).encode(), headers=headers)
        try:
            urllib.request.urlopen(req, timeout=30).read()
        except urllib.error.HTTPError as e:
            sys.exit(f"Supabase 저장 실패 {e.code}: {e.read().decode(errors='replace')[:500]}")
    print(f"저장 완료: {len(payload)}일")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    rows = collect(a.days)
    if not rows:
        sys.exit("가져온 데이터가 없어요")
    ds = list(rows)
    print(f"기간 {ds[0]} ~ {ds[-1]} · {len(ds)}일")
    for d in ds[-3:]:
        print(d, json.dumps(rows[d], ensure_ascii=False))
    if not a.dry_run:
        upsert(rows)
