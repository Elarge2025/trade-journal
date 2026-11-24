"""매매 복기노트: 매매한 종목의 '매매 당시 시가총액'을 구해 Supabase stock_caps 표에 저장 (종목 유형 자동 분류용).

당시 시총 ≈ 상장주식수 × 그날 종가.  상장주식수 = 네이버 증권의 현재 시총 ÷ 현재가 (또는 상장주식수 항목).
python scripts/caps.py               # 아직 시총이 없는 매매만 (매시 자동)
python scripts/caps.py --test 휴림로봇
"""
import argparse, datetime as dt, json, os, re, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import news  # noqa: E402

KST = dt.timezone(dt.timedelta(hours=9))


def eok(v):
    """'3조 2,155억' / '8,234억원' / '1.2조' → 억 단위 숫자."""
    s = str(v or "").replace(",", "").replace(" ", "")
    m = re.fullmatch(r"(?:([\d.]+)조)?(?:([\d.]+)억)?원?", s)
    if not m or not (m.group(1) or m.group(2)):
        return None
    return float(m.group(1) or 0) * 10000 + float(m.group(2) or 0)


def num(v):
    s = re.sub(r"[^\d.]", "", str(v or ""))
    try:
        return float(s) if s else None
    except ValueError:
        return None


def walk(o, out):
    if isinstance(o, dict):
        out.append(o)
        for v in o.values():
            walk(v, out)
    elif isinstance(o, list):
        for v in o:
            walk(v, out)


def shares_of(code, debug=False):
    """상장주식수와 현재 시총(억)을 네이버 증권에서."""
    price, mv, shares = None, None, None
    try:
        b = json.loads(news.fetch(f"https://m.stock.naver.com/api/stock/{code}/basic"))
        price = num(b.get("closePrice"))
        mv = eok(b.get("marketValue")) or mv
    except Exception as e:
        if debug: print("  basic 실패:", e)
    try:
        raw = news.fetch(f"https://m.stock.naver.com/api/stock/{code}/integration")
        objs = []; walk(json.loads(raw), objs)
        for o in objs:
            key = str(o.get("code") or o.get("key") or "")
            label = str(o.get("key") or o.get("name") or o.get("title") or "")
            val = o.get("value")
            if val is None:
                continue
            if key in ("marketValue",) or "시총" in label or "시가총액" in label:
                mv = eok(val) or mv
            if key in ("listedStockCnt", "listedStockCount") or "상장주식" in label:
                shares = num(val) or shares
        if debug:
            print("  integration 항목:", [(o.get("code") or o.get("key"), o.get("value")) for o in objs if "value" in o][:20])
    except Exception as e:
        if debug: print("  integration 실패:", e)
    if not shares and mv and price:
        shares = mv * 1e8 / price
    return shares, mv, price


def closes(code, start, end):
    txt = news.fetch(f"https://api.finance.naver.com/siseJson.naver?symbol={code}&requestType=1"
                     f"&startTime={start:%Y%m%d}&endTime={end:%Y%m%d}&timeframe=day", referer="https://finance.naver.com/")
    out = {}
    for d, c in re.findall(r'\[\s*"(\d{8})"\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)', txt):
        out[f"{d[:4]}-{d[4:6]}-{d[6:]}"] = float(c)
    return out


def run(a):
    if a.test:
        code = news.clean_code(a.test) or news.lookup_code(a.test)
        print("종목코드:", code)
        sh, mv, p = shares_of(code, debug=True)
        print(f"현재가 {p} · 현재 시총 {mv}억 · 상장주식수 {sh:,.0f}" if sh else f"현재가 {p} · 현재 시총 {mv}억 · 상장주식수 못 구함")
        end = dt.date.today(); cl = closes(code, end - dt.timedelta(days=12), end)
        for d, c in list(cl.items())[-5:]:
            print(f"  {d} 종가 {c:,.0f} → 시총 {sh * c / 1e8:,.0f}억" if sh else f"  {d} 종가 {c:,.0f}")
        return

    trades = news.sb_get("trades?select=doc") or []
    have = news.sb_get("stock_caps?select=name,data")
    if have is None:
        print("stock_caps 표가 없어 시총 계산은 건너뜀 (setup.sql 맨 아래 실행 필요)")
        return
    have = {r["name"]: r["data"] for r in have}
    codes = {}
    for f in news.sb_get("fills?select=doc") or []:
        d = f["doc"]
        if d.get("name") and news.clean_code(d.get("code")):
            codes[d["name"]] = news.clean_code(d["code"])
    want = {}
    for t in trades:
        d = t["doc"]; name = (d.get("name") or "").strip(); date = (d.get("date") or "")[:10]
        if not name or not re.match(r"\d{4}-\d{2}-\d{2}$", date):
            continue
        codes.setdefault(name, news.clean_code(d.get("code")))
        if a.force or date not in ((have.get(name) or {}).get("caps") or {}):
            want.setdefault(name, set()).add(date)
    print(f"시총 계산할 종목 {len(want)}개")
    now = dt.datetime.now(KST)
    rows = []
    for name, dates in sorted(want.items()):
        old = have.get(name) or {}
        code = codes.get(name) or old.get("code") or news.lookup_code(name)
        data = {**old, "code": code, "caps": dict(old.get("caps") or {})}
        if not code:
            data["status"] = "nocode"; print(f"- {name}: 종목코드 못 찾음")
        else:
            try:
                sh = old.get("shares")
                if not sh or (old.get("sharesAt") or "") < (now - dt.timedelta(days=30)).isoformat():
                    sh, mv, p = shares_of(code)
                    data.update({"shares": sh, "sharesAt": now.isoformat(), "mvNow": mv})
                if not sh:
                    raise RuntimeError("상장주식수를 못 구함")
                ds = sorted(dates)
                cl = closes(code, dt.date.fromisoformat(ds[0]) - dt.timedelta(days=10), dt.date.fromisoformat(ds[-1]))
                known = sorted(cl)
                for d in ds:
                    prev = [k for k in known if k <= d]
                    if prev:
                        data["caps"][d] = round(sh * cl[prev[-1]] / 1e8)
                data["status"] = "ok"
                shown = ", ".join(f"{d} {data['caps'].get(d, '?')}억" for d in ds[:4])
                print(f"- {name} ({code}): {shown}{' …' if len(ds) > 4 else ''}")
            except Exception as e:
                data["status"] = "error"; data["error"] = str(e)[:200]; print(f"- {name} ({code}) 실패: {e}")
        data["fetchedAt"] = now.isoformat()
        rows.append({"name": name, "data": data, "updated_at": now.isoformat()})
        if len(rows) >= 20:
            news.sb_upsert(rows, table="stock_caps", conflict="name"); rows = []
        time.sleep(0.2)
    if rows:
        news.sb_upsert(rows, table="stock_caps", conflict="name")
    print("시총 저장 완료")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--test")
    run(ap.parse_args())
