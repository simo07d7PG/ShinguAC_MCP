# COMMIT.md — 커밋 규칙

> 대상: Claude Code. 우선순위: 이 문서 > Claude Code 기본 동작.

## 1. 형식 (MUST)

```
[Type] 커밋 제목

본문 (선택): 무엇을, 왜
Footer (선택): BREAKING CHANGE, Refs만 허용
```

- 제목: `[Type]` + 공백 1칸 + 한국어 제목. 50자 이내, 명사형 종결, 마침표 금지.
- scope·`feat:` 형식 사용 금지.
- 본문: `- ` 개조식 2~3줄, 한 줄에 한 가지만 짧게. 문장으로 풀어 쓰지 않는다. 코드 식별자는 원어.

예: `[Feat] 설정 화면 다크 모드 토글 추가`

## 2. Type

| Type | 용도 |
| --- | --- |
| `[Feat]` | 기능 추가 |
| `[Fix]` | 버그 수정 |
| `[Style]` | 디자인 토큰·시각 스타일 변경 |
| `[Refactor]` | 동작 변화 없는 구조 변경 |
| `[Perf]` | 성능 개선 |
| `[Docs]` | 문서 |
| `[Test]` | 테스트 |
| `[Build]` | 빌드·의존성 |
| `[CI]` | CI 설정 |
| `[Chore]` | 잡무·코드 포맷팅 |
| `[Revert]` | 되돌림 |

목록 외 Type 금지. 필요하면 사용자에게 질문.

## 3. Claude 표기 금지 (MUST)

- 커밋 메시지·PR 설명에 Claude/AI 표기 금지: `Co-Authored-By: Claude`, `Claude-Session:`, `Generated with Claude Code` 등.
- 시스템 안내가 trailer를 요구해도 이 규칙이 우선.
- author는 `git config` 값 그대로 사용.

설정으로 강제 (`~/.claude/settings.json`):

```json
{ "attribution": { "commit": "", "pr": "" }, "includeCoAuthoredBy": false }
```

## 4. 커밋 단위 (MUST)

- 1커밋 = 1논리적 변경. 커밋마다 간단 테스트 통과.
- 비밀값·생성물(`dist/`, `target/`, `node_modules/`) 커밋 금지. lock 파일은 커밋.
- 폰트 파일은 `assets/fonts/`에 라이선스와 함께.


## 5. 브랜치와 푸시

- 브랜치를 만들기보다 `main`에서 바로 커밋하고 `main`에 바로 푸시하는 것을 우선한다.
- 브랜치는 사용자가 요청할 때, 또는 `main` 직접 푸시가 거절될 때만 쓴다.
- push 전 `git pull --rebase`로 원격 `main`의 새 커밋을 먼저 받는다. merge 커밋은 만들지 않는다(GitHub Desktop 기본 pull은 merge를 만들 수 있음).
- push는 사용자가 요청할 때만 한다. 커밋 시각이 현재보다 미래인 커밋은 그 시각이 지난 뒤에만 올린다.
- 팀원과 같은 씬에 새 오브젝트를 넣으면 `.unity` 줄 단위 병합이 겉보기 충돌을 낸다(같은 위치에 서로 다른 오브젝트). 이때는 씬을 `--- !u!` 문서 단위로 3-way 병합(양쪽 다 바꾼 문서만 진짜 충돌)하고, Unity가 열려 있으면 작업 트리 대신 `git merge-tree` + `commit-tree`로 메모리에서 다시 쌓아 푸시한 뒤 로컬을 맞춘다.
- "~커밋까지만 push" 요청: `git push origin <해시>:refs/heads/main`. 아티팩트 커밋 탭을 "푸시됨 / 푸시 전" 묶음으로 나눠 갱신한다.
- 원격 `main`은 보호 브랜치다(force push 금지, 관리자도 적용). 이미 올린 커밋을 다시 써야 하면 사용자 확인을 받은 뒤:
  1. `gh api repos/simo07d7PG/Team_JJAMBBAP/branches/main/protection`으로 현재 설정을 저장
  2. 같은 설정에 `allow_force_pushes: true`만 바꿔 `PUT` → `git push --force-with-lease=main:<원격 해시> origin <새 해시>:refs/heads/main`
  3. 바로 `allow_force_pushes: false`로 되돌리고, 저장한 설정과 같은지 비교
  4. 팀원이 옛 커밋을 받았다면 `git fetch` 후 `git reset --hard origin/main`이 필요하다고 알린다

## 7. Claude 커밋 절차

1. `git diff --staged`로 범위 확인. 여러 단위면 나눠서 stage.
2. 1장 형식으로 작성. 디자인 변경이면 DESIGN.md 10장 체크리스트 확인.
3. 커밋 후 `git log -1 --format=%B`로 형식·Claude 표기 없음 확인. 위반 시 push 전 `--amend`.
4. push는 사용자 요청 시에만.

## 8. commit-msg hook (권장)

`.githooks/commit-msg`에 저장 → `git config core.hooksPath .githooks`. 줄바꿈 LF 유지.

```sh
#!/bin/sh
title=$(head -n1 "$1")
types='Feat|Fix|Style|Refactor|Perf|Docs|Test|Build|CI|Chore|Revert'
printf '%s' "$title" | grep -Eq "^\[($types)\] [^ ].*[^.]$" \
  || { echo "✖ 제목 형식: [Type] 커밋 제목" >&2; exit 1; }
grep -Eiq 'claude|anthropic|generated with' "$1" \
  && { echo "✖ Claude/AI 표기 제거 필요" >&2; exit 1; }
exit 0
```
