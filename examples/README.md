# 예시

- `mcp.json`: Claude Code 프로젝트 루트의 `.mcp.json`에 넣을 설정. `<ABSOLUTE_PATH>`를 이 저장소의 절대경로로 바꾸고 `npm run build`로 `dist/`를 만든 뒤 사용한다.
- CLI로 등록: `claude mcp add shingu -e SHINGU_ID=학번 -e SHINGU_PW=비밀번호 -- node <절대경로>/dist/index.js`
