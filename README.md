# 매매 복기노트

개인 매매일지 사이트. 매매 기록, 차트 사진 복기, 승률·손익비·기대값 통계, 실수 유형별 오답노트.

- 화면: `index.html` (빌드 없는 정적 페이지, GitHub Pages로 배포)
- 저장: Supabase (로그인 · 테이블 `trades` `weeks` `settings` · 비공개 버킷 `charts`)
- 연결 정보: `config.js` (Supabase URL과 anon key)
- 데이터베이스 설정: `setup.sql`

## 데이터 구조
- `trades.doc`: date, name, type, mood, reason, buy, sell, qty, stop, stopKept(O/X), mistakes[], memo, lesson, photos[{asset(저장소 경로), title, note}], createdAt, updatedAt
- `weeks.doc`: week, worst, goal, kept, memo
- `settings.doc`: fee, tax, types[], moods[], mistakes[]

모든 테이블과 사진은 Row Level Security로 로그인한 본인만 읽고 쓸 수 있음.
