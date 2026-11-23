"""매매 복기노트: 미국 지수와 '종목별 미국 관련주'(설정 usMap)의 일별 종가·등락률을 Supabase us_prices 표에 저장.

python scripts/us.py            # 새 종목은 2년치, 기존 종목은 6시간 지나면 최근 한 달 갱신
python scripts/us.py --test TSLA
"""
import argparse, csv, datetime as dt, io, json, os, re, sys, time, urllib.error, urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
INDEXES = {"^IXIC": "나스닥", "^GSPC": "S&P500", "^SOX": "필라델피아 반도체"}
STOOQ = {"^IXIC": "^ndq", "^GSPC": "^spx", "^SOX": "^sox"}
SYM_RE = re.compile(r"^\^?[A-Z0-9.\-]{1,12}$")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json, text/csv, */*"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", errors="replace")


def yahoo(sym, rng):
    data = json.loads(fetch(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.request.quote(sym)}?range={rng}&interval=1d"))
    res = data["chart"]["result"][0]
    off = res["meta"].get("gmtoffset", -18000)
    closes = res["indicators"]["quote"][0]["close"]
    out = {}
    for ts, c in zip(res.get("timestamp") or [], closes):
        if c is None:
            continue
        out[dt.datetime.utcfromtimestamp(ts + off).date().isoformat()] = round(c, 4)
    name = res["meta"].get("shortName") or res["meta"].get("longName") or ""
    return out, name


def stooq(sym):
    s = STOOQ.get(sym) or (sym.lower().replace(".", "-") + ".us")
    txt = fetch(f"https://stooq.com/q/d/l/?s={urllib.request.quote(s)}&i=d")
    out = {}
    for r in csv.DictReader(io.StringIO(txt)):
        try:
            out[r["Date"]] = round(float(r["Close"]), 4)
        except Exception:
            pass
    return out, ""


def closes(sym, rng):
    for name, fn in (("yahoo", lambda: yahoo(sym, rng)), ("stooq", lambda: stooq(sym))):
        try:
            got, nm = fn()
            if got:
                return got, nm, name
            print(f"  · {sym} {name}: 비어 있음")
        except Exception as e:
            print(f"  · {sym} {name} 실패: {e}")
    return {}, "", ""


def with_chg(cl):
    out, prev = {}, None
    for d in sorted(cl):
        c = cl[d]
        out[d] = [c, round((c / prev - 1) * 100, 2) if prev else None]
        prev = c
    return out


# ---------- Supabase ----------
def hdr(extra=None):
    key = os.environ.get("SUPABASE_SECRET_KEY", "")
    if not key:
        sys.exit("SUPABASE_SECRET_KEY가 없어요")
    h = {"apikey": key, "Content-Type": "application/json"}
    if key.startswith("eyJ"):
        h["Authorization"] = f"Bearer {key}"
    h.update(extra or {})
    return h


def sb(path, body=None, extra=None):
    url = os.environ.get("SUPABASE_URL", "").rstrip("/") + "/rest/v1/" + path
    req = urllib.request.Request(url, method="POST" if body is not None else "GET",
                                 data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None, headers=hdr(extra))
    try:
        r = urllib.request.urlopen(req, timeout=30).read()
        return json.loads(r) if r else None
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")[:300]
        if "does not exist" in msg or "Could not find" in msg:
            sys.exit("Supabase에 us_prices 표가 없어요. setup.sql 맨 아래 부분을 SQL Editor에서 실행해 주세요.")
        sys.exit(f"Supabase 오류 {e.code}: {msg}")


def run(a):
    if a.test:
        got, nm, src = closes(a.test, "1mo")
        print(f"{a.test} ({nm}) · 출처 {src} · {len(got)}일")
        for d, v in list(with_chg(got).items())[-5:]:
            print(" ", d, v)
        return
    now = dt.datetime.now(dt.timezone.utc)
    syms = dict(INDEXES)
    for r in sb("settings?select=doc") or []:
        for name, lst in ((r.get("doc") or {}).get("usMap") or {}).items():
            for s in lst or []:
                s = str(s).strip().upper()
                if SYM_RE.match(s):
                    syms.setdefault(s, "")
    have = {r["sym"]: r for r in sb("us_prices?select=sym,data,updated_at") or []}
    rows = []
    for s, label in syms.items():
        old = have.get(s)
        if old and old["updated_at"] > (now - dt.timedelta(hours=6)).isoformat() and not a.force:
            continue
        rng = "1mo" if old and (old.get("data") or {}).get("d") and not a.force else "2y"
        got, nm, src = closes(s, rng)
        if not got:
            if not old:
                rows.append({"sym": s, "data": {"d": {}, "name": label, "status": "error"}, "updated_at": now.isoformat()})
            continue
        merged = {d: v[0] for d, v in ((old or {}).get("data", {}).get("d") or {}).items()} if rng == "1mo" else {}
        merged.update(got)
        data = {"d": with_chg(merged), "name": label or nm or (old or {}).get("data", {}).get("name", ""), "src": src, "status": "ok"}
        print(f"- {s} {data['name']}: {len(merged)}일 [{src}] 최근 {max(merged)} {data['d'][max(merged)]}")
        rows.append({"sym": s, "data": data, "updated_at": now.isoformat()})
        time.sleep(0.3)
    if rows:
        sb("us_prices?on_conflict=sym", rows, {"Prefer": "resolution=merge-duplicates,return=minimal"})
    print(f"미국 시세 저장: {len(rows)}종목 (전체 {len(syms)})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--test")
    ap.add_argument("--force", action="store_true")
    run(ap.parse_args())
