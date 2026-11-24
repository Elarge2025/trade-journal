"""매매 복기노트: 섹터 탭에 넣은 종목들의 현재가·등락률과 최근 뉴스를 Supabase stock_live 표에 저장.

python scripts/sector.py              # 25분 지난 종목만 갱신 (매시 10분·40분 자동)
python scripts/sector.py --force
python scripts/sector.py --test 휴림로봇
"""
import argparse, datetime as dt, json, os, re, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import news  # noqa: E402  (같은 폴더의 news.py: fetch, 종목코드 찾기, 네이버 뉴스 읽기, Supabase 도우미)

KST = dt.timezone(dt.timedelta(hours=9))


def num(v):
    if v is None:
        return None
    s = re.sub(r"[^\d.\-]", "", str(v))
    try:
        return float(s) if s not in ("", "-", ".") else None
    except ValueError:
        return None


def price(code):
    """네이버 증권 모바일 종목 기본 정보 → 현재가·전일 대비·등락률."""
    d = json.loads(news.fetch(f"https://m.stock.naver.com/api/stock/{code}/basic"))
    p = num(d.get("closePrice"))
    pct = num(d.get("fluctuationsRatio"))
    diff = num(d.get("compareToPreviousClosePrice"))
    kind = ((d.get("compareToPreviousPrice") or {}).get("name") or "").upper()
    if kind in ("FALLING", "LOWER_LIMIT") and diff and diff > 0:
        diff = -diff
    if kind in ("FALLING", "LOWER_LIMIT") and pct and pct > 0:
        pct = -pct
    ex = d.get("stockExchangeType") or {}
    return {"price": p, "diff": diff, "chgPct": pct, "prevClose": (p - diff) if p is not None and diff is not None else None,
            "asOf": d.get("localTradedAt") or "", "marketStatus": d.get("marketStatus") or "",
            "market": ex.get("nameKor") or ex.get("name") or "", "name": d.get("stockName") or ""}


def candles(code):
    """최근 7거래일 일봉 [날짜, 시가, 고가, 저가, 종가, 거래량]."""
    end = dt.datetime.now(KST).date()
    start = end - dt.timedelta(days=25)
    txt = news.fetch(f"https://api.finance.naver.com/siseJson.naver?symbol={code}&requestType=1"
                     f"&startTime={start:%Y%m%d}&endTime={end:%Y%m%d}&timeframe=day", referer="https://finance.naver.com/")
    rows = re.findall(r'\[\s*"(\d{8})"\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)', txt)
    return [[f"{d[:4]}-{d[4:6]}-{d[6:]}", float(o), float(h), float(l), float(c), float(v)] for d, o, h, l, c, v in rows][-7:]


def latest_news(code):
    for name, fn in news.SOURCES:
        try:
            got = [x for x in fn(code, 1) if x["t"]]
            if got:
                return sorted(got, key=lambda x: x["t"], reverse=True)[:20]
        except Exception as e:
            print(f"  · {name} 뉴스 실패: {e}")
    return []


def one(name, code):
    out = {"code": code, "fetchedAt": dt.datetime.now(KST).isoformat()}
    if not code:
        out["status"] = "nocode"
        return out
    try:
        out.update(price(code))
    except Exception as e:
        print(f"  · {name} 시세 실패: {e}")
    try:
        out["candles"] = candles(code)
    except Exception as e:
        print(f"  · {name} 일봉 실패: {e}")
    out["news"] = latest_news(code)
    out["status"] = "ok"
    return out


def run(a):
    if a.test:
        code = news.clean_code(a.test) or news.lookup_code(a.test)
        d = one(a.test, code)
        print(json.dumps({k: v for k, v in d.items() if k != "news"}, ensure_ascii=False))
        for x in d.get("news", [])[:5]:
            print(" ", x["t"], x["press"], x["title"])
        return
    rows = news.sb_get("sectors?select=doc")
    if rows is None:
        print("sectors 표가 없어 섹터 갱신은 건너뜀 (setup.sql 맨 아래 실행 필요)")
        return
    stocks = {}
    for r in rows:
        for s in (r["doc"] or {}).get("stocks") or []:
            n = (s.get("name") or "").strip()
            if n:
                stocks.setdefault(n, news.clean_code(s.get("code")))
    if not stocks:
        print("섹터에 넣은 종목이 아직 없음")
        return
    have = news.sb_get("stock_live?select=name,updated_at")
    if have is None:
        print("stock_live 표가 없어 섹터 갱신은 건너뜀 (setup.sql 맨 아래 실행 필요)")
        return
    have = {r["name"]: r["updated_at"] for r in have}
    codes = {}
    for f in news.sb_get("fills?select=doc") or []:
        d = f["doc"]
        if d.get("name") and news.clean_code(d.get("code")):
            codes[d["name"]] = news.clean_code(d["code"])
    now = dt.datetime.now(dt.timezone.utc)
    stale = (now - dt.timedelta(minutes=25)).isoformat()
    todo = [n for n in stocks if a.force or n not in have or have[n] < stale]
    print(f"섹터 종목 {len(stocks)}개 · 이번에 갱신 {len(todo)}개")
    out = []
    for n in todo:
        code = stocks[n] or codes.get(n) or news.lookup_code(n)
        d = one(n, code)
        print(f"- {n} ({code or '코드 없음'}): {d.get('price')} {d.get('chgPct')}% · 뉴스 {len(d.get('news') or [])}건")
        out.append({"name": n, "data": d, "updated_at": now.isoformat()})
        if len(out) % 20 == 0:
            news.sb_upsert(out[-20:], table="stock_live", conflict="name")
        time.sleep(0.2)
    rest = out[len(out) - len(out) % 20:] if len(out) % 20 else []
    if rest:
        news.sb_upsert(rest, table="stock_live", conflict="name")
    print(f"섹터 종목 저장 {len(out)}개")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--test")
    run(ap.parse_args())
