## autopilot-impl (shingu-mcp v1) - 2026-10-26
- [x] AC-M1 "7개 도구" 표기 — 사용자 결정으로 `get_attendance` 제외 → 도구 7개(조회 6 + refresh 1)로 스펙·계획 정정 (2026-10-26)
- [x] 중복 로그인 정책 — 실측: **허용형**(새 로그인 후에도 기존 세션 유지). WI-3은 분기 불필요, README는 "끊길 수 있음" 보수적 안내 유지 (docs/portal-pages.md §1)
- [x] `get_grades(semester?)` 학기 코드 — 포털은 `yy`(4자리) + `haggi`(COR08 코드 "1"/"2"...). 도구 입력은 `YYYY-H` 문자열 (docs/portal-pages.md §3.5)
- [x] `get_timetable(week?)` — 시간표는 학기 고정. `week`는 날짜 라벨용으로만 유지 (docs/portal-pages.md §3.2)
- [x] 사용자 `.env` 실계정 — 제공 완료, 정찰(WI-4) 리더가 수행. 원본 HTML은 tests/fixtures/raw/ (gitignore), 마스킹 픽스처 생성은 WI-4 후반 작업으로 남음
- [ ] 출석(`attendance`) 범주 제거에 따른 스펙 AC-S4/AC-M1, 계획 WI-5/6e/8/9 문구 정정 (리더 진행 중)
