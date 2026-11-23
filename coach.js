/* 미모사 원칙 코치 (규칙 기반)
 * 프로젝트에 올린 미모사 강의 공지·특강·Q&A 정리에서 뽑은 행동강령을
 * 내 매매 기록의 숫자 조건에 연결한다. 문장은 자료를 바탕으로 정리한 것이며 미모사 본인의 말이 아니다.
 */
(function () {
  "use strict";

  const SRC = {
    desk: "책상에 붙여 놓는 원칙과 마인드",
    imp: "매매할 때 중요하게 생각하는 내용",
    size: "마음 편한 비중에 관한 기준",
    mkt: "좋은 시장과 어려운 시장에서의 비중 차이",
    re: "손절 이후 재상승 때 다시 접근하는 마인드",
    jong: "5강 중요 설명 · 종가베팅 기본 매매 틀",
    jong2: "종가베팅의 모호함으로 어려움을 겪는 분들께",
    last: "마지막 공지사항",
    qa3: "3강 Q&A 정리",
    qa4: "4강 Q&A 정리",
    qa5: "5강 Q&A 정리",
    qa6: "6강 Q&A 정리",
    sp: "컬러미모사 특강"
  };

  const won = n => (n > 0 ? "+" : "") + Math.round(n).toLocaleString("ko-KR") + "원";
  const wonAbs = n => Math.round(Math.abs(n)).toLocaleString("ko-KR") + "원";
  const pct = (n, d = 0) => (n * 100).toFixed(d) + "%";
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const median = a => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  const hasMis = (t, ...names) => (t.mistakes || []).some(m => names.some(n => m.includes(n)));

  function group(list) {
    const n = list.length, wins = list.filter(t => t.c.win), losses = list.filter(t => !t.c.win);
    const pnl = sum(list, t => t.c.pnl);
    const avgW = wins.length ? sum(wins, t => t.c.pnl) / wins.length : 0;
    const avgL = losses.length ? sum(losses, t => t.c.pnl) / losses.length : 0;
    return { n, pnl, exp: n ? pnl / n : 0, wr: n ? wins.length / n : 0, avgW, avgL,
      payoff: wins.length && losses.length && avgL ? avgW / Math.abs(avgL) : null,
      lossSum: sum(losses, t => t.c.pnl), avgBuy: n ? sum(list, t => t.c.buyAmt) / n : 0 };
  }

  function context(trades, market) {
    const done = trades.filter(t => t.c && t.date)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
    const all = group(done);
    const byDay = new Map();
    for (const t of done) { if (!byDay.has(t.date)) byDay.set(t.date, []); byDay.get(t.date).push(t); }
    const days = [...byDay.values()];
    const mk = d => market && market.get ? market.get(d) : null;
    return { done, all, byDay, days, mk };
  }

  /* 규칙: 조건에 맞으면 {tone, title, mine, principle, src} 를 돌려준다 */
  const RULES = [
    function sample(x) {
      if (x.all.n >= 30) return null;
      return { tone: "info", w: 1, title: "아직은 표본을 쌓는 시기예요",
        mine: `완료된 매매 ${x.all.n}건. 30건이 넘어야 숫자가 실력을 말해주기 시작해요.`,
        principle: "주린이 시절에는 소액이나 1주로 몇 달 이상 꾸준히 연습해 주세요. 그 과정에서 매매 기준과 원칙이 뚜렷해집니다.",
        src: [SRC.jong, SRC.imp] };
    },

    function averagingDown(x) {
      const g = x.done.filter(t => hasMis(t, "물타기"));
      if (!g.length) return null;
      const s = group(g), share = x.all.lossSum ? s.lossSum / x.all.lossSum : 0;
      return { tone: "warn", w: (s.pnl < 0 ? 9 : 5) + share * 10, title: s.pnl < 0 ? "물타기가 계좌를 갉아먹고 있어요" : "물타기가 지금은 운 좋게 버텨 주고 있어요",
        mine: `물타기 ${g.length}번, 그 매매들 순손익 ${won(s.pnl)}. 전체 손실의 ${pct(share)}가 여기서 나왔어요.`,
        principle: "평단을 낮추려는 물타기는 손익비를 망가뜨리는 최악의 습관입니다. 반등 없이 흘러내리면 계좌가 박살나요. 추세가 꺾이면 바로 손절하고, 손절 기회를 놓쳤더라도 평단 낮추기 없이 반등 때 물량을 정리해 주세요.",
        src: [SRC.qa5] };
    },

    function stopLoss(x) {
      const losses = x.done.filter(t => !t.c.win);
      const late = x.done.filter(t => hasMis(t, "손절 지연"));
      const judged = losses.filter(t => t.stopKept === "O" || t.stopKept === "X");
      const rate = judged.length ? judged.filter(t => t.stopKept === "O").length / judged.length : null;
      const avgL = x.all.avgL, big = avgL ? losses.filter(t => t.c.pnl < avgL * 3) : [];
      const bigSum = sum(big, t => t.c.pnl);
      if (!late.length && !(rate != null && rate < 0.9) && big.length < 2) return null;
      const parts = [];
      if (late.length) parts.push(`'손절 지연' ${late.length}번 (순손익 ${won(group(late).pnl)})`);
      if (rate != null) parts.push(`손절 준수율 ${pct(rate)}`);
      if (big.length >= 2) parts.push(`평균 손실의 3배가 넘는 큰 손실 ${big.length}번, 합계 ${won(bigSum)}`);
      return { tone: "warn", w: 8 + (late.length + big.length) / 3, title: "손절이 늦어지고 있어요",
        mine: parts.join(" · "),
        principle: "손절가를 이탈하면 주가가 어디까지 빠질지 아무도 모릅니다. 다시 오를 거라는 확신이 없으니 일단 손절하는 게 맞아요. 비중이 커서 한 번에 던지기 힘들거나 확신이 있더라도, 손절 라인을 이탈하면 최소 절반은 바로 잘라 주세요. 칼손절이 계좌를 지키는 정석입니다.",
        src: [SRC.re, SRC.qa6] };
    },

    function chasing(x) {
      const g = x.done.filter(t => hasMis(t, "고점 추격", "급등 추격"));
      if (g.length < 2) return null;
      const s = group(g);
      if (s.pnl >= 0) return null;
      return { tone: "warn", w: 6 + g.length / 3, title: "급등 중에 따라 들어가고 있어요",
        mine: `고점·급등 추격 ${g.length}번, 승률 ${pct(s.wr)}, 순손익 ${won(s.pnl)}.`,
        principle: "급등 중에 매수하면 안 됩니다. 사람들이 매도하는 자리에서 매수하면 안 돼요. 25% 이상 급등한 종목은 남은 먹을 폭보다 하락 위험이 훨씬 큽니다. 깊게 빠졌다가 매물 소화 없이 V자로 바로 돌파하는 자리도 피하고, 차곡차곡 매물을 소화하며 올라오는 돌파만 노려 주세요.",
        src: [SRC.desk, SRC.qa3, SRC.qa4] };
    },

    function overtrading(x) {
      if (x.days.length < 5) return null;
      const per = x.all.n / x.days.length;
      const busy = x.days.filter(d => d.length >= 5), calm = x.days.filter(d => d.length <= 2);
      const busyP = sum(busy, d => sum(d, t => t.c.pnl)), calmP = sum(calm, d => sum(d, t => t.c.pnl));
      const busyAvg = busy.length ? busyP / busy.length : 0, calmAvg = calm.length ? calmP / calm.length : 0;
      if (per < 2.5 && !(busy.length >= 3 && busyAvg < 0)) return null;
      return { tone: busyAvg < calmAvg ? "warn" : "info", w: 5 + (busyAvg < 0 ? 3 : 0),
        title: "매매 횟수가 많아요",
        mine: `매매한 날 하루 평균 ${per.toFixed(1)}건. ` +
          (busy.length ? `5건 넘게 매매한 날 ${busy.length}일은 하루 평균 ${won(busyAvg)}, ` : "") +
          (calm.length ? `1~2건만 한 날 ${calm.length}일은 하루 평균 ${won(calmAvg)}.` : ""),
        principle: "데이트레이딩은 매일 어떻게든 수익을 내는 기술이 아니에요. 매매하기 좋은 종목이 있을 때 수익을 내는 방법입니다. 새는 돈을 막아야 자산이 쌓여요. 가끔 매매하더라도 확실한 종목이 있을 때만 하면 큰 수익금이 가능합니다.",
        src: [SRC.last, SRC.desk] };
    },

    function revenge(x) {
      const first = [], after = [];
      for (const d of x.days) {
        let lost = false;
        d.forEach((t, i) => { if (i === 0) first.push(t); else if (lost) after.push(t); if (!t.c.win) lost = true; });
      }
      if (after.length < 5) return null;
      const a = group(after), f = group(first);
      if (a.exp >= 0 || a.exp >= f.exp) return null;
      return { tone: "warn", w: 7, title: "손실 뒤에 바로 만회하려는 매매가 보여요",
        mine: `같은 날 손실이 난 뒤 이어서 한 매매 ${after.length}건: 승률 ${pct(a.wr)}, 건당 ${won(a.exp)}. 그날 첫 매매는 건당 ${won(f.exp)}.`,
        principle: "돈을 벌겠다, 손실을 메꾸겠다는 생각으로 트레이딩하면 손실 확률이 커집니다. 평소 일일 수익금에 맞춰 스트레스가 쌓이는 금액을 일일 최대 손실로 정해 두고, 그 금액에 닿으면 바로 매매를 멈춰 주세요. 비중베팅이 실패한 날 재진입까지 실패하면 그날은 종료합니다.",
        src: [SRC.qa4, SRC.qa5, SRC.re] };
    },

    function marketWeather(x) {
      const tagged = x.done.filter(t => x.mk(t.date)?.kosdaq?.chgPct != null);
      if (tagged.length < 15) return null;
      const down = tagged.filter(t => x.mk(t.date).kosdaq.chgPct <= -1);
      const up = tagged.filter(t => x.mk(t.date).kosdaq.chgPct >= 1);
      if (down.length < 5 || up.length < 5) return null;
      const d = group(down), u = group(up);
      const sizeRatio = u.avgBuy ? d.avgBuy / u.avgBuy : 1;
      if (d.exp < 0 && sizeRatio > 0.8) {
        return { tone: "warn", w: 7 + Math.min(3, down.length / 10), title: "시장이 빠지는 날에도 비중을 그대로 싣고 있어요",
          mine: `코스닥이 1% 넘게 빠진 날 ${down.length}건: 건당 ${won(d.exp)}, 평균 매수금액 ${wonAbs(d.avgBuy)}. 1% 넘게 오른 날 ${up.length}건: 건당 ${won(u.exp)}, 평균 매수금액 ${wonAbs(u.avgBuy)}.`,
          principle: "매매하기 좋은 시장이 아니라면 비중을 최소로 줄여서 매매합니다. 어떤 종목이 강할지 예상이 안 되는 시장에서는 잃어도 아무 타격이 없을 정도로, 시장을 구경한다는 생각으로 총 매수 금액 자체를 줄여 주세요. 매수 절제가 안 되면 다른 계좌에 소액만 세팅해도 괜찮습니다.",
          src: [SRC.mkt, SRC.desk] };
      }
      if (sizeRatio <= 0.7) {
        return { tone: "good", w: 3, title: "어려운 날 비중을 줄이고 있어요",
          mine: `코스닥이 빠진 날 평균 매수금액이 오른 날의 ${pct(sizeRatio)} 수준이에요.`,
          principle: "시장이 안 좋다는 것 자체가 매매 성공 확률이 떨어진다는 뜻이에요. 지금처럼 어려운 날 비중을 낮추는 습관을 계속 지켜 주세요.",
          src: [SRC.mkt] };
      }
      return null;
    },

    function sizing(x) {
      if (x.all.n < 15) return null;
      const med = median(x.done.map(t => t.c.buyAmt));
      const heavy = x.done.filter(t => t.c.buyAmt >= med * 2);
      const flagged = x.done.filter(t => hasMis(t, "과도한 비중", "미수", "레버리지"));
      const h = group(heavy), fl = group(flagged);
      const heavyBad = heavy.length >= 3 && h.pnl < 0;
      if (!heavyBad && !(flagged.length && fl.pnl < 0)) return null;
      const parts = [];
      if (heavyBad) parts.push(`평소(중간값 ${wonAbs(med)})의 2배 넘게 산 매매 ${heavy.length}건, 순손익 ${won(h.pnl)}`);
      if (flagged.length) parts.push(`'과도한 비중·미수' 표시 ${flagged.length}건, 순손익 ${won(fl.pnl)}`);
      return { tone: "warn", w: 7, title: "비중을 키운 매매에서 크게 잃고 있어요",
        mine: parts.join(" · "),
        principle: "마음 편한 비중은 잃어도 괜찮은 금액, 매매할 때 이성이 마비되지 않는 금액이에요. 예수금 대비 몇 %로 정하는 게 아니라, 손절할 때 마음 편하게 대응할 수 있는 금액만으로 해 주세요. 거래대금이 완전히 집중되는 주도주가 나오기 전까지 비중베팅은 함부로 하면 안 됩니다.",
        src: [SRC.size, SRC.re, SRC.mkt] };
    },

    function payoff(x) {
      const p = x.all.payoff;
      if (p == null || x.all.n < 20 || p >= 1) return null;
      const early = x.done.filter(t => hasMis(t, "이른 익절")).length;
      return { tone: "warn", w: 6 + (1 - p) * 4, title: "벌 때는 적게, 잃을 때는 크게 잃는 구조예요",
        mine: `손익비 ${p.toFixed(2)} (이길 때 평균 ${won(x.all.avgW)}, 질 때 평균 ${won(x.all.avgL)}), 승률 ${pct(x.all.wr)}.` + (early ? ` '너무 이른 익절' ${early}번.` : ""),
        principle: "손실은 기계적으로 짧게 자르고, 수익은 연속성 있게 올라가는 강한 종목에서 키워야 해요. 돌파 승률이 높다면 첫 캔들에 50%, 잔손절이 많다면 33%로 분할 진입한 뒤 시세가 나올 때 비중을 채워 손익비를 완성합니다. 큰 수익금은 압도적으로 거래대금이 몰리는 강한 종목과 테마에서만 나와요.",
        src: [SRC.qa5, SRC.desk] };
    },

    function typeFocus(x) {
      const by = new Map();
      for (const t of x.done) if (t.type) { if (!by.has(t.type)) by.set(t.type, []); by.get(t.type).push(t); }
      const gs = [...by.entries()].map(([k, v]) => ({ k, ...group(v) })).filter(g => g.n >= 8);
      if (gs.length < 2) return null;
      gs.sort((a, b) => b.exp - a.exp);
      const best = gs[0], worst = gs[gs.length - 1];
      if (best.exp <= 0 && worst.exp >= 0) return null;
      const out = [];
      if (best.exp > 0) out.push(`'${best.k}' ${best.n}건 건당 ${won(best.exp)} (승률 ${pct(best.wr)})`);
      if (worst.exp < 0 && worst.k !== best.k) out.push(`'${worst.k}' ${worst.n}건 건당 ${won(worst.exp)}`);
      return { tone: best.exp > 0 ? "good" : "warn", w: 5, title: best.exp > 0 ? `'${best.k}'이(가) 내 무기예요` : "어떤 매매 유형에서도 아직 기대값이 플러스가 아니에요",
        mine: out.join(" · ") + ".",
        principle: "내가 평소에 수익 내던 매매에서만 수익을 낼 수 있어요. 내 매매법이 잘 통하지 않는 시장이라면 억지로 다른 기법으로 갈아타기보다 비중을 줄이거나 쉬면서, 주력 매매법이 잘 통하는 장세가 올 때까지 계좌를 지켜 주세요.",
        src: [SRC.desk, SRC.qa5] };
    },

    function newListing(x) {
      const g = x.done.filter(t => (t.type || "").includes("신규주"));
      if (g.length < 6) return null;
      const s = group(g);
      if (s.exp >= 0) return null;
      return { tone: "warn", w: 5, title: "신규주에서 손실이 나고 있어요",
        mine: `신규주 ${g.length}건: 승률 ${pct(s.wr)}, 건당 ${won(s.exp)}, 합계 ${won(s.pnl)}.`,
        principle: "신규주는 대응이 되는 분들만 해 주세요. -5% 이상 하락이 쉽게 나오니 그걸 감안해서 매수 금액을 정해야 하고, 속도를 따라갈 대응력이 안 된다면 신규주는 안 해도 됩니다. 무리해서 속도를 맞추려다 잘하던 매매 습관까지 망가질 수 있어요.",
        src: [SRC.qa4, SRC.imp] };
    },

    function closingBet(x) {
      const g = x.done.filter(t => (t.type || "").includes("종가"));
      if (g.length < 5) return null;
      const s = group(g);
      if (s.exp > 0) return { tone: "good", w: 3, title: "종가베팅이 잘 맞고 있어요",
        mine: `종가베팅 ${g.length}건: 승률 ${pct(s.wr)}, 건당 ${won(s.exp)}.`,
        principle: "거래대금이 크게 터지는 종목이 일봉상 연속으로 상승하면 비중을 올리는 구간이에요. 단, -4~5% 손실을 감당할 수 있는 정도까지만 올려 주세요.",
        src: [SRC.jong] };
      return { tone: "info", w: 4, title: "종가베팅 기준을 다시 점검해 보세요",
        mine: `종가베팅 ${g.length}건: 승률 ${pct(s.wr)}, 건당 ${won(s.exp)}.`,
        principle: "종가베팅은 '다음 날 시장에서 가장 관심을 많이 받을 종목은 무엇인가'를 찾는 초단기 투자예요. 큰 거래대금, 좋은 뉴스, 신고가 여부 같은 매수 근거로 1~2종목만 추리고, 분봉 추세가 아래로 꺾인 종목은 하지 않습니다. 돈을 벌겠다는 목적보다 근거를 찾는 연습을 1주로 해 주세요.",
        src: [SRC.jong, SRC.jong2] };
    },

    function smallCaps(x) {
      const g = x.done.filter(t => hasMis(t, "비주도주", "근거 없는", "잡주"));
      if (g.length < 3) return null;
      const s = group(g);
      if (s.pnl >= 0) return null;
      return { tone: "warn", w: 6, title: "주도주가 아닌 종목, 근거 없는 진입이 보여요",
        mine: `'비주도주·근거 없는 진입' ${g.length}건: 승률 ${pct(s.wr)}, 순손익 ${won(s.pnl)}.`,
        principle: "시가총액이 작고 대금이 적은 종목은 기술적 분석의 신뢰도가 없어요. 아무리 소액 연습이라도 1분당 거래대금이 40억 원 전후 이상 꾸준히 터지는 주도주로만 훈련해야 매매 습관이 제대로 잡힙니다. 매매할 주도주가 없을 때는 수익을 낼 수 없는 시장임을 인정하고 관망해 주세요.",
        src: [SRC.qa3, SRC.qa6] };
    },

    function gradeProcess(x) {
      const graded = x.done.filter(t => t.grade);
      if (graded.length < 10) return null;
      const bad = graded.filter(t => +t.grade <= 2), good = graded.filter(t => +t.grade >= 4);
      const b = group(bad), g = group(good);
      if (bad.length < 3) return null;
      const share = x.all.lossSum ? Math.min(1, Math.max(0, b.lossSum / x.all.lossSum)) : 0;
      return { tone: b.pnl < 0 ? "info" : "good", w: 4, title: "스스로 '하·최악'이라 한 매매만 없었어도",
        mine: `하·최악 ${bad.length}건 순손익 ${won(b.pnl)}` + (good.length ? `, 상·최상 ${good.length}건 순손익 ${won(g.pnl)}` : "") + `. 평가한 매매 중 손실의 ${pct(share)}가 하·최악에서 나왔어요.`,
        principle: "기준에 완벽히 부합하는 정말 좋은 종목이 나올 때만 매매를 완벽하게 하려고 노력해야 수익금이 자연스럽게 따라옵니다. 반복되는 나쁜 매매는 횟수와 손실금을 적어서 모니터 옆에 붙여 두고, 하나씩 지워 나가 주세요.",
        src: [SRC.qa4, SRC.sp] };
    },

    function journaling(x) {
      if (x.all.n < 10) return null;
      const j = x.done.filter(t => (t.reason || "").trim() || (t.memo || "").trim() || (t.photos || []).length).length;
      const r = j / x.all.n;
      if (r >= 0.5) return null;
      return { tone: "info", w: 3, title: "복기가 비어 있는 매매가 많아요",
        mine: `완료된 매매 ${x.all.n}건 중 근거·메모·차트가 있는 매매 ${j}건 (${pct(r)}).`,
        principle: "결과를 알고 본 이상적인 타점 말고, 당시 현실적으로 가능했던 판단으로 복기해 주세요. 손실 난 매매뿐 아니라 수익 난 매매도 '더 벌 수 있었던 방법'까지 봐야 손익비가 커집니다. 큰 손실로 스트레스가 심한 날은 복기보다 잠을 자고 컨디션부터 회복하세요.",
        src: [SRC.sp, SRC.qa5] };
    },

    function recentSlump(x) {
      if (!x.done.length) return null;
      const lastDate = x.done[x.done.length - 1].date;
      const cut = new Date(new Date(lastDate + "T00:00:00").getTime() - 30 * 864e5).toISOString().slice(0, 10);
      const recent = x.done.filter(t => t.date > cut);
      if (recent.length < 8) return null;
      const r = group(recent);
      if (r.pnl >= 0) return null;
      const kd = recent.map(t => x.mk(t.date)?.kosdaq?.chgPct).filter(v => v != null);
      const weak = kd.length ? kd.reduce((a, b) => a + b, 0) / kd.length < 0 : false;
      return { tone: "info", w: 4, title: "최근 한 달은 쉬어가는 구간일 수 있어요",
        mine: `최근 30일 ${recent.length}건 순손익 ${won(r.pnl)}, 승률 ${pct(r.wr)}.` + (weak ? " 그 기간 코스닥도 평균적으로 하락한 날이 많았어요." : ""),
        principle: "어떤 매매법으로든 수익 내기 어려운 시장이 있어요. 그럴 때는 매매를 최소화하거나 관망해서 계좌를 지키고, 생활비는 밖에서 벌면서 소액으로 연습해 주세요. 계좌는 계단식으로 꾸준히 오르지 않아요. 매매가 잘 되는 시장이 다시 올 때 쭉 올라갑니다.",
        src: [SRC.last, SRC.mkt] };
    }
  ];

  function profile(x) {
    if (!x.all.n) return "";
    const per = x.days.length ? x.all.n / x.days.length : 0;
    const types = new Map();
    for (const t of x.done) if (t.type) types.set(t.type, (types.get(t.type) || 0) + 1);
    const topType = [...types.entries()].sort((a, b) => b[1] - a[1])[0];
    const mis = new Map();
    for (const t of x.done) if (!t.c.win) for (const m of t.mistakes || []) mis.set(m, (mis.get(m) || 0) + t.c.pnl);
    const topMis = [...mis.entries()].sort((a, b) => a[1] - b[1])[0];
    const s = [];
    s.push(`매매한 날 하루 평균 ${per.toFixed(1)}건, 1회 평균 ${wonAbs(x.all.avgBuy)}어치를 사고 있어요.`);
    if (topType) s.push(`가장 많이 한 매매는 '${topType[0]}'(${pct(topType[1] / x.all.n)})예요.`);
    s.push(`승률 ${pct(x.all.wr)}에 이길 때 평균 ${won(x.all.avgW)}, 질 때 평균 ${won(x.all.avgL)}이라 매매 1번에 평균 ${won(x.all.exp)}이 남는 구조예요.`);
    if (topMis && x.all.lossSum) s.push(`손실 매매에서 가장 많이 붙은 실수는 '${topMis[0]}'이고, 그 매매들의 손실이 ${wonAbs(topMis[1])}이에요.`);
    return s.join(" ");
  }

  function analyze(trades, market) {
    const x = context(trades, market);
    const items = [];
    for (const r of RULES) { try { const it = r(x); if (it) items.push(it); } catch (e) { /* 규칙 하나가 실패해도 나머지는 보여준다 */ } }
    const order = { warn: 0, info: 1, good: 2 };
    items.sort((a, b) => order[a.tone] - order[b.tone] || b.w - a.w);
    return { n: x.all.n, profile: profile(x), items };
  }

  window.TJCoach = { analyze };
})();
