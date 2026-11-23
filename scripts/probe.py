import urllib.request, sys
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
T = [
 ("naver index day", "https://finance.naver.com/sise/sise_index_day.naver?code=KOSPI&page=1", "https://finance.naver.com/"),
 ("naver index day nhn", "https://finance.naver.com/sise/sise_index_day.nhn?code=KOSPI&page=1", "https://finance.naver.com/"),
 ("naver siseJson", "https://api.finance.naver.com/siseJson.naver?symbol=KOSPI&requestType=1&startTime=20261110&endTime=20261123&timeframe=day", "https://finance.naver.com/"),
 ("naver investor", "https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=20261120&sosok=01&page=1", "https://finance.naver.com/"),
 ("naver m price", "https://m.stock.naver.com/api/index/KOSPI/price?pageSize=5&page=1", "https://m.stock.naver.com/"),
 ("naver m investor", "https://m.stock.naver.com/api/index/KOSPI/trend", "https://m.stock.naver.com/"),
 ("daum days", "https://finance.daum.net/api/market_index/days?page=1&perPage=5&market=KOSPI&pagination=true", "https://finance.daum.net/"),
 ("daum investor", "https://finance.daum.net/api/investor/days?page=1&perPage=5&market=KOSPI&pagination=true", "https://finance.daum.net/"),
]
for name, url, ref in T:
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA, "Referer": ref, "Accept": "application/json, text/html, */*"}), timeout=20)
        b = r.read(); 
        try: t = b.decode("utf-8")
        except: t = b.decode("euc-kr", errors="replace")
        print(f"### {name}: {r.status} len={len(b)}\n{t[:900]}\n")
    except Exception as e:
        body = ""
        try: body = e.read()[:300]
        except: pass
        print(f"### {name}: FAIL {e} {body}\n")
