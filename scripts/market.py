"""매매 복기노트: 코스피·코스닥 일별 시장 데이터를 Daum·네이버 금융에서 모아 Supabase market_days 표에 저장.

python scripts/market.py --days 7            # 최근 7일 (매일 자동 실행)
python scripts/market.py --days 400          # 1년치 채우기
python scripts/market.py --days 10 --dry-run # 저장 없이 출력만
"""
import argparse, ast, datetime as dt, json, os, re, sys, time, urllib.error, urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Referer": "https://finance.daum.net/", "Accept": "application/json, text/plain, */*"}
MARKETS = {"kospi": {"code": "KOSPI"}, "kosdaq": {"code": "KOSDAQ"}}


def fetch(url, enc="euc-kr", tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
                return r.read().decode(enc, errors="replace")
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))






def daum_days(market, start):
    """종가·등락률·거래량(천주)·거래대금(백만원)·투자자별 순매수(억원). 출처: Daum 금융."""
    out, page = {}, 1
    while page <= 40:
        txt = fetch(f"https://finance.daum.net/api/market_index/days?page={page}&perPage=100&market={market}&pagination=true", enc="utf-8")
        rows = json.loads(txt).get("data") or []
        for r in rows:
            d = str(r.get("date", ""))[:10]
            close, chg = r.get("tradePrice"), r.get("changePrice")
            prev = (close - chg) if close is not None and chg is not None else None
            eok = lambda v: None if v is None else round(v / 1e8, 1)
            out[d] = {"close": close, "chg": chg, "chgPct": round(chg / prev * 100, 2) if prev else None,
                      "vol": r.get("accTradeVolume"), "value": r.get("accTradePrice"),
                      "_flow": {"indiv": eok(r.get("individualStraightPurchasePrice")),
                                "foreign": eok(r.get("foreignStraightPurchasePrice")),
                                "inst": eok(r.get("institutionStraightPurchasePrice"))}}
        if not rows or len(rows) < 100 or min(out) < start.isoformat():
            break
        page += 1
        time.sleep(0.3)
    return out


def index_ohlc(code, start, end):
    """시가·고가·저가·종가. 출처: 네이버 금융 차트."""
    txt = fetch(f"https://api.finance.naver.com/siseJson.naver?symbol={code}&requestType=1"
                f"&startTime={start:%Y%m%d}&endTime={end:%Y%m%d}&timeframe=day", enc="utf-8")
    rows = ast.literal_eval(re.sub(r"\s+", "", txt))
    out = {}
    for r in rows[1:]:
        d = str(r[0]); d = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
        out[d] = {"open": r[1], "high": r[2], "low": r[3], "close": r[4]}
    return out


def collect(days):
    end = dt.date.today()
    start = end - dt.timedelta(days=days)
    merged = {}
    for key, m in MARKETS.items():
        daum = daum_days(m["code"], start)
        ohlc = index_ohlc(m["code"], start, end + dt.timedelta(days=1))
        print(f"[{key}] Daum {len(daum)}일 · 시고저종 {len(ohlc)}일")
        for d in set(daum) | set(ohlc):
            if d < start.isoformat() or d > end.isoformat():
                continue
            ent = merged.setdefault(d, {})
            x = dict(daum.get(d, {}))
            flow = x.pop("_flow", None)
            o = ohlc.get(d, {})
            info = {**x, **{k: o[k] for k in ("open", "high", "low") if o.get(k) is not None}}
            if info.get("close") is None and o.get("close") is not None:
                info["close"] = o["close"]
            if info:
                ent[key] = info
            if flow and any(v is not None for v in flow.values()):
                ent.setdefault("flow", {})[key] = flow
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
