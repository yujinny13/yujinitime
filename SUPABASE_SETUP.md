# Supabase 설정 — 회사컴 ↔ 집컴 동기

## 1단계: Supabase SQL Editor 열기

1. https://supabase.com/dashboard 접속
2. 프로젝트 `mopeirfaxfojkrkswntf` (wealthy-life와 같은 거) 클릭
3. 왼쪽 메뉴 `SQL Editor` → `New query`

## 2단계: 아래 SQL 한 번 실행

```sql
-- yujinitime용 테이블 (wealthy-life의 user_state와 분리)
create table if not exists public.yujinitime_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);

-- RLS 활성화 (본인 데이터만 보고/쓰게)
alter table public.yujinitime_state enable row level security;

-- 본인 행만 SELECT
create policy "own row select"
  on public.yujinitime_state for select
  using (auth.uid() = user_id);

-- 본인 행만 INSERT
create policy "own row insert"
  on public.yujinitime_state for insert
  with check (auth.uid() = user_id);

-- 본인 행만 UPDATE
create policy "own row update"
  on public.yujinitime_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

`Run` 버튼 클릭.

## 3단계: yujinitime.vercel.app 들어가서 로그인

- 이메일 입력 → 매직 링크 받기
- 메일에서 링크 클릭
- 자동으로 사이트 들어가짐 (회사컴 ↔ 집컴 자동 동기 시작)

## 끝!

이제 어디서나 같은 데이터. 우측 상단에 `✓ 동기 완료` 뜨면 OK.
