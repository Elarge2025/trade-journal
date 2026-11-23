"""매매 복기노트: 매매한 종목의 '전 거래일 ~ 매매일' 뉴스 제목을 네이버 금융에서 모아 Supabase news 표에 저장.

python scripts/news.py                # 아직 뉴스가 없는 매매만 (매시 자동 실행)
python scripts/news.py --force        # 전부 다시
python scripts/news.py --dry-run      # 저장 없이 출력만
python scripts/news.py --test 005930 2026-11-20   # 한 종목·날짜만 확인
"""
import argparse, datetime as dt, html, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
KST = dt.timezone(dt.timedelta(hours=9))
MAX_ITEMS = 60
MAX_PAGES = 300


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


def sb_upsert(rows, table="news", conflict="key"):
    for i in range(0, len(rows), 100):
        req = urllib.request.Request(f"{sb_url()}/rest/v1/{table}?on_conflict={conflict}", method="POST",
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


TITLE_K = ("title", "titleText", "headline")
TIME_K = ("datetime", "dateTime", "createdAt", "publishedAt", "regDate", "writtenAt", "date", "pubDate")
PRESS_K = ("officeName", "cpKorName", "cpName", "press", "source", "providerName")
SUM_K = ("body", "summary", "description", "content", "subContent")
IMG_K = ("imageOriginLink", "thumbnailUrl", "imageUrl", "thumbnail", "image")


def plain(x, n=None):
    t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(x or "")))).strip()
    return t[:n] if n else t


def parse_items(data, url_of):
    """JSON 어디에 있든 '제목 + 시각'이 있는 기사 객체를 모음."""
    items = []
    def walk(o):
        if isinstance(o, dict):
            tk = next((k for k in TITLE_K if isinstance(o.get(k), str) and o.get(k).strip()), None)
            dk = next((k for k in TIME_K if o.get(k)), None)
            t = to_dt(o.get(dk)) if dk else None
            if tk and t:
                it = {"t": t, "title": html.unescape(re.sub(r"<[^>]+>", "", o[tk])).strip(),
                      "press": next((str(o[k]) for k in PRESS_K if o.get(k)), ""), "url": url_of(o)}
                sm = next((plain(o[k], 220) for k in SUM_K if isinstance(o.get(k), str) and o.get(k).strip()), "")
                im = next((str(o[k]) for k in IMG_K if isinstance(o.get(k), str) and o.get(k).startswith("http")), "")
                if sm:
                    it["sum"] = sm
                if im:
                    it["img"] = im
                items.append(it)
                return
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(data)
    return items


def naver_url(o):
    oid, aid = o.get("officeId"), o.get("articleId")
    return f"https://n.news.naver.com/mnews/article/{oid}/{aid}" if oid and aid else (o.get("url") or o.get("linkUrl") or "")


def daum_url(o):
    nid = o.get("newsId") or o.get("id")
    return f"https://v.daum.net/v/{nid}" if nid and re.match(r"^\d{10,}$", str(nid)) else (o.get("url") or o.get("linkUrl") or o.get("mobileUrl") or "")


SOURCES = [
    ("naver-m", lambda code, page: parse_items(json.loads(fetch(
        f"https://m.stock.naver.com/api/news/stock/{code}?pageSize=20&page={page}")), naver_url)),
    ("naver-api", lambda code, page: parse_items(json.loads(fetch(
        f"https://api.stock.naver.com/news/stock/{code}?pageSize=20&page={page}")), naver_url)),
]


def probe(code):
    """테스트용: 각 출처 첫 페이지 응답을 그대로 보여줌."""
    for name, fn in SOURCES:
        try:
            got = fn(code, 1)
            print(f"[{name}] {len(got)}건" + (f" · 최신 {got[0]['t']} {got[0]['title'][:40]} [{got[0]['press']}]" if got else ""))
            if not got:
                for u in (f"https://m.stock.naver.com/api/news/stock/{code}?pageSize=20&page=1", f"https://m.stock.naver.com/api/stock/{code}/basic"):
                    try:
                        print(f"   원문 {u.split('.com')[1]}: {fetch(u)[:300]!r}")
                    except Exception as e:
                        print(f"   원문 {u.split('.com')[1]}: {e}")
        except urllib.error.HTTPError as e:
            print(f"[{name}] HTTP {e.code}: {e.read().decode(errors='replace')[:200]!r}")
        except Exception as e:
            print(f"[{name}] 실패: {e!r}"[:300])


_news_cache = {}
def code_news(code, since):
    """since(YYYY-MM-DD) 이후 뉴스. 네이버는 너무 깊은 페이지를 거부해서, 거기까지 못 가면 reached=False."""
    got = _news_cache.get(code)
    if got and (got["oldest"] <= since or not got["reached"]):
        return got["items"], got["src"], got["oldest"] < since
    items, src, oldest = [], "", "9999"
    for name, fn in SOURCES:
        part, ok, prev = [], False, oldest
        try:
            for page in range(1, MAX_PAGES + 1):
                batch = [x for x in fn(code, page) if x["t"]]
                if not batch:
                    oldest = "0000"  # 끝까지 봤음
                    if page == 1:
                        ok = "empty"
                    break
                ok = True
                part += batch
                oldest = min(oldest, min(x["t"][:10] for x in batch))
                if oldest < since:
                    break
                time.sleep(0.2)
        except Exception as e:
            print(f"  · {name} {len(part) // 20 + 1}쪽에서 멈춤: {e}")
        if ok == "empty":
            if name == SOURCES[-1][0] and not src:
                src = name + ":empty"
            oldest = prev
            continue
        if ok:
            items += part
            src = src or name
        if oldest < since:
            break
    _news_cache[code] = {"items": items, "src": src, "oldest": oldest, "reached": oldest < since}
    return items, src, oldest < since


# ---------- 참고한 기사 본문 ----------
def meta(txt, *names):
    for n in names:
        m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]*content=["\']([^"\']*)' % re.escape(n), txt, re.I) \
            or re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']%s["\']' % re.escape(n), txt, re.I)
        if m and m.group(1).strip():
            return html.unescape(m.group(1)).strip()
    return ""


def block_text(h):
    h = re.sub(r"(?is)<(script|style|noscript|button|figcaption)[^>]*>.*?</\1>", " ", h)
    h = re.sub(r"(?is)<em[^>]*class=[\"'][^\"']*img_desc[^\"']*[\"'][^>]*>.*?</em>", " ", h)
    h = re.sub(r"(?i)<br\s*/?>", "\n", h)
    h = re.sub(r"(?i)</(p|div|h\d|li|tr)>", "\n", h)
    t = html.unescape(re.sub(r"<[^>]+>", " ", h))
    lines = [re.sub(r"[ \t\u00a0]+", " ", ln).strip() for ln in t.split("\n")]
    out, blank = [], 0
    for ln in lines:
        if ln:
            out.append(ln); blank = 0
        elif out and not blank:
            out.append(""); blank = 1
    return "\n".join(out).strip()


def fetch_article(url):
    """기사 페이지에서 제목·요약·대표 사진·본문을 뽑음. 네이버 뉴스는 본문(dic_area), 그 외는 <p> 모음."""
    txt = fetch(url, referer="https://www.naver.com/")
    if "charset=euc-kr" in txt[:3000].lower() and "\ufffd" in txt:
        txt = fetch(url, enc="euc-kr", referer="https://www.naver.com/")
    data = {"title": meta(txt, "og:title", "twitter:title"), "desc": meta(txt, "og:description", "description", "twitter:description"),
            "img": meta(txt, "og:image", "twitter:image"), "press": meta(txt, "og:article:author", "twitter:creator", "og:site_name")}
    m = re.search(r'data-date-time="([\d\- :]+)"', txt)
    if m:
        data["t"] = m.group(1)[:16]
    body = ""
    m = re.search(r'(?is)<article[^>]*id="dic_area"[^>]*>(.*?)</article>', txt) or re.search(r'(?is)id="dic_area"[^>]*>(.*?)</div>\s*</div>', txt)
    if m:
        body = block_text(m.group(1))
    if not body:
        scope = re.search(r"(?is)<article[^>]*>(.*?)</article>", txt)
        ps = [plain(p) for p in re.findall(r"(?is)<p[^>]*>(.*?)</p>", scope.group(1) if scope else txt)]
        body = "\n\n".join(p for p in ps if len(p) > 30)
    data["body"] = body[:20000]
    return data


def run_articles(now, trades, dry):
    have = sb_get("articles?select=url,data")
    if have is None:
        print("articles 표가 없어 본문 가져오기는 건너뜀 (setup.sql 맨 아래 실행 필요)")
        return
    have = {r["url"]: r["data"] for r in have}
    urls = []
    for t in trades:
        for r in t["doc"].get("newsRefs") or []:
            u = (r.get("url") or "").strip()
            old = have.get(u)
            if u.startswith("http") and u not in urls and (not old or (old.get("status") == "error" and old.get("fetchedAt", "") < (now - dt.timedelta(hours=12)).isoformat())):
                urls.append(u)
    print(f"참고한 기사 본문: 이번에 가져올 것 {len(urls)}")
    rows = []
    for u in urls[:150]:
        try:
            d = fetch_article(u)
            d["status"] = "ok" if d["body"] or d["desc"] else "nobody"
            print(f"- {u} · 본문 {len(d['body'])}자")
        except Exception as e:
            d = {"status": "error", "error": str(e)[:200]}
            print(f"- {u} · 실패: {e}")
        d["fetchedAt"] = now.isoformat()
        rows.append({"url": u, "data": d, "updated_at": now.isoformat()})
        time.sleep(0.3)
    if rows and not dry:
        sb_upsert(rows, table="articles", conflict="url")


def prev_trading_day(date, market_dates):
    earlier = [d for d in market_dates if d < date]
    if earlier and (dt.date.fromisoformat(date) - dt.date.fromisoformat(earlier[-1])).days <= 6:
        return earlier[-1]
    d = dt.date.fromisoformat(date) - dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d.isoformat()


def pick(items, frm, to):
    """기사가 많으면 '전 거래일 장 마감 뒤 ~ 매매일 장중'을 먼저 고르고, 나머지로 채움. 결과는 최신순."""
    seen, cand = set(), []
    for x in sorted(items, key=lambda x: x["t"], reverse=True):
        if not (frm <= x["t"][:10] <= to):
            continue
        k = re.sub(r"\W", "", x["title"])[:40]
        if k in seen:
            continue
        seen.add(k)
        cand.append(x)
    core = lambda x: f"{frm} 15:30" <= x["t"] <= f"{to} 15:30"
    chosen = [x for x in cand if core(x)][:MAX_ITEMS]
    chosen += [x for x in cand if not core(x)][: MAX_ITEMS - len(chosen)]
    return sorted(chosen, key=lambda x: x["t"], reverse=True)


def run(a):
    now = dt.datetime.now(KST)
    if a.article:
        d = fetch_article(a.article)
        print(json.dumps({k: (v[:300] + "…" if isinstance(v, str) and len(v) > 300 else v) for k, v in d.items()}, ensure_ascii=False, indent=1))
        return
    if a.test:
        code, date = clean_code(a.test[0]) or lookup_code(a.test[0]), a.test[1]
        print(f"종목코드: {code or '못 찾음'}")
        probe(code)
        frm = prev_trading_day(date, [])
        items, src, reached = code_news(code, frm)
        got = pick(items, frm, date)
        print(f"{a.test[0]} → 코드 {code} · {frm}~{date} · 출처 {src} · {len(got)}건" + ("" if reached else " · 이 날짜까지 다 못 거슬러 감"))
        for x in got[:15]:
            print(" ", x["t"], x["press"], x["title"], x["url"])
        return

    trades = sb_get("trades?select=doc") or []
    fills = sb_get("fills?select=doc") or []
    market = sorted(r["date"] for r in (sb_get("market_days?select=date") or []))
    run_articles(now, trades, a.dry_run)  # 내가 고른 기사 본문 먼저 (빨리 끝남)
    if a.articles_only:
        return
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

    rows, saved = [], 0
    for key, (date, name) in sorted(want.items(), reverse=True)[: a.limit]:
        code = codes.get(name) or lookup_code(name)
        frm = prev_trading_day(date, market)
        data = {"name": name, "code": code, "from": frm, "to": date, "fetchedAt": now.isoformat(), "items": []}
        if not code:
            data["status"] = "nocode"
            print(f"- {key}: 종목코드를 못 찾음")
        else:
            items, src, reached = code_news(code, frm)
            data["items"], data["src"] = pick(items, frm, date), src
            data["status"] = "error" if not src else "empty" if src.endswith(":empty") else "ok" if reached else "partial"
            print(f"- {key} ({code}) {frm}~{date}: {len(data['items'])}건 [{src or '실패'}]")
        rows.append({"key": key, "data": data, "updated_at": now.isoformat()})
        if not a.dry_run and len(rows) - saved >= 10:  # 10건마다 바로 저장 (중간에 멈춰도 그때까지는 남음)
            sb_upsert(rows[saved:]); saved = len(rows); print(f"  … {saved}건 저장")

    if a.dry_run:
        for r in rows[:3]:
            print(json.dumps(r["data"], ensure_ascii=False)[:600])
        return
    if rows[saved:]:
        sb_upsert(rows[saved:])
    print(f"저장 완료: {len(rows)}건")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--articles-only", action="store_true")
    ap.add_argument("--article", help="기사 주소 하나만 확인")
    ap.add_argument("--test", nargs=2, metavar=("CODE_OR_NAME", "DATE"))
    run(ap.parse_args())
