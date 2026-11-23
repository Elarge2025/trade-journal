"""매매 복기노트: 매매한 종목의 '전 거래일 ~ 매매일' 뉴스 제목을 네이버 금융에서 모아 Supabase news 표에 저장.

python scripts/news.py                # 아직 뉴스가 없는 매매만 (매시 자동 실행)
python scripts/news.py --force        # 전부 다시
python scripts/news.py --dry-run      # 저장 없이 출력만
python scripts/news.py --test 005930 2026-11-20   # 한 종목·날짜만 확인
"""
import argparse, datetime as dt, html, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
KST = dt.timezone(dt.timedelta(hours=9))
MAX_ITEMS = 40
MAX_PAGES = 80


def fetch(url, enc="utf-8", referer="https://m.stock.naver.com/", tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": referer, "Accept": "application/json, text/html, */*"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.read().decode(enc, errors="replace")
        except urllib.error.HTTPError as e:
            if e.code in (400, 404) or i == tries - 1:
                raise
        except Exception:
            if i == tries - 1:
                raise
        time.sleep(1.5 * (i + 1))


# ---------- Supabase ----------
def sb_headers(extra=None):
    key = os.environ.get("SUPABASE_SECRET_KEY", "")
    if not key:
        sys.exit("SUPABASE_SECRET_KEY가 없어요. GitHub 저장소 Settings → Secrets and variables → Actions에 넣어 주세요.")
    h = {"apikey": key, "Content-Type": "application/json"}
    if key.startswith("eyJ"):
        h["Authorization"] = f"Bearer {key}"
    h.update(extra or {})
    return h


def sb_url():
    return os.environ.get("SUPABASE_URL", "").rstrip("/")


def sb_get(path):
    out, start = [], 0
    while True:
        req = urllib.request.Request(f"{sb_url()}/rest/v1/{path}", headers=sb_headers({"Range": f"{start}-{start + 999}"}))
        try:
            rows = json.loads(urllib.request.urlopen(req, timeout=30).read())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            if e.code == 404 or "does not exist" in body or "Could not find" in body:
                return None
            sys.exit(f"Supabase 읽기 실패 {e.code}: {body}")
        out += rows
        if len(rows) < 1000:
            return out
        start += 1000


def sb_upsert(rows):
    for i in range(0, len(rows), 100):
        req = urllib.request.Request(f"{sb_url()}/rest/v1/news?on_conflict=key", method="POST",
                                     data=json.dumps(rows[i:i + 100], ensure_ascii=False).encode(),
                                     headers=sb_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}))
        try:
            urllib.request.urlopen(req, timeout=30).read()
        except urllib.error.HTTPError as e:
            sys.exit(f"Supabase 저장 실패 {e.code}: {e.read().decode(errors='replace')[:500]}")


# ---------- 종목코드 ----------
def clean_code(c):
    """'A005930' → '005930', 신형 코드 '0035S0'도 그대로."""
    c = re.sub(r"[^0-9A-Z]", "", str(c or "").upper())
    if len(c) == 7 and c[0] in "AJQ":
        c = c[1:]
    return c if len(c) == 6 and c[0].isdigit() else ""


_ac_cache = {}
def lookup_code(name):
    if name in _ac_cache:
        return _ac_cache[name]
    code = ""
    for url in (f"https://ac.stock.naver.com/ac?q={urllib.parse.quote(name)}&target=stock",
                f"https://m.stock.naver.com/front-api/search/autoComplete?query={urllib.parse.quote(name)}&target=stock"):
        try:
            data = json.loads(fetch(url))
        except Exception as e:
            print(f"  · 종목코드 검색 실패 ({url.split('/')[2]}): {e}")
            continue
        cands = []
        def walk(o):
            if isinstance(o, dict):
                c = clean_code(o.get("code") or o.get("itemCode") or o.get("reutersCode") or "")
                n = o.get("name") or o.get("stockName") or o.get("itemName")
                if c and n:
                    cands.append((c, str(n)))
                for v in o.values():
                    walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)
        walk(data)
        exact = [c for c, n in cands if n.replace(" ", "") == name.replace(" ", "")]
        if exact or cands:
            code = (exact or [cands[0][0]])[0]
            break
    _ac_cache[name] = code
    return code


# ---------- 뉴스 ----------
def to_dt(s):
    """'202611201530' / '2026.11.20 15:30' / '2026-11-20T15:30:00' → 'YYYY-MM-DD HH:MM'"""
    d = re.sub(r"\D", "", str(s or ""))
    if len(d) < 12:
        return None
    return f"{d[:4]}-{d[4:6]}-{d[6:8]} {d[8:10]}:{d[10:12]}"


def news_mobile(code, page):
    """네이버 증권 모바일 종목 뉴스 (JSON)."""
    data = json.loads(fetch(f"https://m.stock.naver.com/api/news/stock/{code}?pageSize=100&page={page}"))
    items = []
    def walk(o):
        if isinstance(o, dict):
            if o.get("title") and (o.get("datetime") or o.get("dateTime")) and (o.get("articleId") or o.get("officeId")):
                oid, aid = o.get("officeId"), o.get("articleId")
                items.append({"t": to_dt(o.get("datetime") or o.get("dateTime")), "title": html.unescape(re.sub(r"<[^>]+>", "", str(o["title"]))).strip(),
                              "press": o.get("officeName") or "",
                              "url": f"https://n.news.naver.com/mnews/article/{oid}/{aid}" if oid and aid else ""})
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(data)
    return items


def news_desktop(code, page):
    """네이버 금융 종목 뉴스 (HTML, 예비용)."""
    txt = fetch(f"https://finance.naver.com/item/news_news.naver?code={code}&page={page}&sm=title_entity_id.basic&clusterId=",
                enc="euc-kr", referer=f"https://finance.naver.com/item/news.naver?code={code}")
    items = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", txt, re.S):
        a = re.search(r'<a href="([^"]*article_id=(\d+)[^"]*office_id=(\d+)[^"]*)"[^>]*class="tit"[^>]*>(.*?)</a>', tr, re.S) \
            or re.search(r'<a href="([^"]*article_id=(\d+)[^"]*office_id=(\d+)[^"]*)"[^>]*>(.*?)</a>', tr, re.S)
        d = re.search(r'class="date"[^>]*>\s*([\d.:\s]+)<', tr)
        if not a or not d:
            continue
        p = re.search(r'class="info"[^>]*>(.*?)<', tr, re.S)
        items.append({"t": to_dt(d.group(1)), "title": html.unescape(re.sub(r"<[^>]+>", "", a.group(4))).strip(),
                      "press": html.unescape(p.group(1)).strip() if p else "",
                      "url": f"https://n.news.naver.com/mnews/article/{a.group(3)}/{a.group(2)}"})
    return items


_news_cache = {}
def code_news(code, since):
    """since(YYYY-MM-DD) 이후 뉴스를 최신순으로. 같은 종목은 한 번만 거슬러 올라감."""
    got = _news_cache.get(code)
    if got and got["oldest"] <= since:
        return got["items"], got["src"]
    items, src, oldest = [], "", "9999"
    for name, fn in (("naver-m", news_mobile), ("naver-pc", news_desktop)):
        items, oldest, ok = [], "9999", False
        try:
            for page in range(1, MAX_PAGES + 1):
                batch = [x for x in fn(code, page) if x["t"]]
                if not batch:
                    oldest = "0000"  # 끝까지 봤음
                    break
                ok = True
                items += batch
                oldest = min(oldest, min(x["t"][:10] for x in batch))
                if oldest < since:
                    break
                time.sleep(0.25)
        except Exception as e:
            print(f"  · {name} 실패: {e}")
        if ok:
            src = name
            break
    _news_cache[code] = {"items": items, "src": src, "oldest": oldest if src else "9999"}
    return items, src


def prev_trading_day(date, market_dates):
    earlier = [d for d in market_dates if d < date]
    if earlier and (dt.date.fromisoformat(date) - dt.date.fromisoformat(earlier[-1])).days <= 6:
        return earlier[-1]
    d = dt.date.fromisoformat(date) - dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d.isoformat()


def pick(items, frm, to):
    seen, out = set(), []
    for x in sorted(items, key=lambda x: x["t"], reverse=True):
        if not (frm <= x["t"][:10] <= to):
            continue
        k = re.sub(r"\W", "", x["title"])[:40]
        if k in seen:
            continue
        seen.add(k)
        out.append(x)
    return out[:MAX_ITEMS]


def run(a):
    now = dt.datetime.now(KST)
    if a.test:
        code, date = clean_code(a.test[0]) or lookup_code(a.test[0]), a.test[1]
        frm = prev_trading_day(date, [])
        items, src = code_news(code, frm)
        got = pick(items, frm, date)
        print(f"{a.test[0]} → 코드 {code} · {frm}~{date} · 출처 {src} · {len(got)}건")
        for x in got[:15]:
            print(" ", x["t"], x["press"], x["title"], x["url"])
        return

    trades = sb_get("trades?select=doc") or []
    fills = sb_get("fills?select=doc") or []
    market = sorted(r["date"] for r in (sb_get("market_days?select=date") or []))
    have = sb_get("news?select=key,data")
    if have is None:
        sys.exit("Supabase에 news 표가 없어요. setup.sql의 news 부분을 SQL Editor에서 먼저 실행해 주세요.")
    have = {r["key"]: r["data"] for r in have}

    codes = {}
    for f in fills:
        d = f["doc"]
        if d.get("name") and clean_code(d.get("code")):
            codes[d["name"]] = clean_code(d["code"])
    for t in trades:
        d = t["doc"]
        if d.get("name") and clean_code(d.get("code")):
            codes.setdefault(d["name"], clean_code(d["code"]))

    want = {}
    for t in trades:
        d = t["doc"]
        date, name = (d.get("date") or "")[:10], (d.get("name") or "").strip()
        if not re.match(r"\d{4}-\d{2}-\d{2}$", date) or not name:
            continue
        key = f"{date}|{name}"
        old = have.get(key)
        fresh_needed = date >= (now.date() - dt.timedelta(days=1)).isoformat()  # 최근 이틀은 새 기사가 붙을 수 있어 다시
        if a.force or not old or (fresh_needed and old.get("fetchedAt", "") < (now - dt.timedelta(minutes=50)).isoformat()) \
                or (old.get("status") == "error" and old.get("fetchedAt", "") < (now - dt.timedelta(hours=12)).isoformat()):
            want[key] = (date, name)
    print(f"매매 {len(trades)}건 · 뉴스 있음 {len(have)} · 이번에 가져올 것 {len(want)}")

    rows = []
    for key, (date, name) in sorted(want.items(), reverse=True)[: a.limit]:
        code = codes.get(name) or lookup_code(name)
        frm = prev_trading_day(date, market)
        data = {"name": name, "code": code, "from": frm, "to": date, "fetchedAt": now.isoformat(), "items": []}
        if not code:
            data["status"] = "nocode"
            print(f"- {key}: 종목코드를 못 찾음")
        else:
            items, src = code_news(code, frm)
            data["items"], data["src"] = pick(items, frm, date), src
            data["status"] = "ok" if src else "error"
            print(f"- {key} ({code}) {frm}~{date}: {len(data['items'])}건 [{src or '실패'}]")
        rows.append({"key": key, "data": data, "updated_at": now.isoformat()})

    if a.dry_run:
        for r in rows[:3]:
            print(json.dumps(r["data"], ensure_ascii=False)[:600])
        return
    if rows:
        sb_upsert(rows)
    print(f"저장 완료: {len(rows)}건")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--test", nargs=2, metavar=("CODE_OR_NAME", "DATE"))
    run(ap.parse_args())
