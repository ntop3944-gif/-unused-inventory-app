<img width="1794" height="928" alt="image" src="https://github.com/user-attachments/assets/023a4185-9df0-47b3-9dc2-5dc732129c1c" />
# 불용재고 관리현황 — 서버 공유판 (Cloudflare Workers)

VRCS 참고 예시처럼, 기존 `불용재고_관리현황_대시보드.html`을 **Cloudflare Workers + KV**로 옮겨
"서버 저장 · 팀 공유 · 이력관리 · 링크 공유 · 로그인"을 갖춘 독립 웹앱으로 만든 버전입니다.

## 이번 버전에서 바뀐 점
- **로그인**: 최초 접속 시 아이디/비밀번호 입력 화면(계정은 아래 "계정 관리" 참고)
- **서버 저장**: 사전검토 트래커·데이터 검증 체크리스트가 Cloudflare KV에 저장되어, Claude 없이
  이 URL을 아는 누구나(로그인 후) 열면 동일한 최신 상태를 봅니다
- **이력(히스토리) · 공유** 탭 신설: 현재 상태를 이름 붙여 저장 → 목록에서 불러오기/링크복사/삭제
- **공유 URL**: `?snapshot=이력ID`로 링크를 열면 그 시점 상태를 **읽기전용**으로 볼 수 있습니다
  (로그인 없이도 열람 가능 — 읽기전용이라 수정은 막혀 있습니다)
- **파일 첨부(신규)**: 사전검토 트래커 카드마다 회의록·승인도 등 PDF·이미지를 첨부할 수 있습니다.
  - 카드 제목 옆에 📎 개수 배지가 표시됩니다
  - 삭제는 업로더 본인 또는 **관리자(admin) 역할** 계정만 가능합니다
  - 파일 1개당 약 10MB까지 (Cloudflare KV 저장 한도 고려)
  - 이력(스냅샷) 저장 시 첨부파일 실물은 복사하지 않고, 트래커 상태만 저장합니다
    (첨부파일은 항상 "현재" 트래커 항목에 붙어있는 최신본 기준으로 열람됩니다)

기존 대시보드의 나머지 기능(개요·재활용현황·발생원인분석·등급처분관리·품목상세 등)은 그대로입니다.

다음 단계(이번 버전에는 미포함, 필요하시면 이어서 작업 가능):
- 레터헤드·페이지번호를 갖춘 **정식 인쇄/PDF 포맷** 출력
- 역할(관리자/개발자/사용자)별 **화면 항목 열람권한 세분화** (지금은 "삭제 권한"에만 관리자 역할이 적용되어 있고,
  화면 항목 자체를 역할별로 숨기는 기능은 아직 없습니다)

## 배포 방법 (Cloudflare 계정 필요)

### 1) 준비
```bash
npm install -g wrangler
wrangler login          # 브라우저가 열리며 Cloudflare 계정 인증
```

### 2) KV 네임스페이스 생성
```bash
cd unused-inventory-app
wrangler kv namespace create TRACKER_KV
```
출력되는 `id = "..."` 값을 `wrangler.toml`의
```
[[kv_namespaces]]
binding = "TRACKER_KV"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```
부분에 붙여넣으세요.

### 3) 배포
```bash
wrangler deploy
```
배포가 끝나면 `https://unused-inventory-dashboard.<계정서브도메인>.workers.dev` 같은 URL이 발급됩니다.
(VRCS 예시의 `broad-smoke-2ac3.pjyboss6202.workers.dev`와 같은 방식입니다.)

### 4) 계정 관리
최초 배포 시 서버가 자동으로 아래 임시 계정을 하나 만듭니다.
```
아이디: admin
비밀번호: change-me-now
```
**반드시 로그인 직후 비밀번호를 바꿔주세요.** 계정 목록은 KV에 JSON으로 저장되며, 아래 명령으로 직접 갱신할 수 있습니다.
```bash
wrangler kv key put --binding=TRACKER_KV "auth:users" \
  '{"admin":{"password":"새비밀번호","name":"관리자","role":"admin"},
    "jjs":{"password":"팀장님비밀번호","name":"정진석","role":"admin"},
    "kiy":{"password":"...","name":"김일영","role":"member"}}'
```
팀원 6명분 계정을 이 JSON 하나에 원하는 만큼 추가하시면 됩니다.
`role`을 `"admin"`으로 주면 다른 사람이 올린 첨부파일도 삭제할 수 있고, `"member"`(또는 생략)면
본인이 올린 첨부파일만 삭제할 수 있습니다.

## 로컬에서 미리보기 (선택)
```bash
wrangler dev
```
로컬 브라우저에서 `http://localhost:8787`로 접속해 배포 전 동작을 확인할 수 있습니다.
(로컬 KV는 배포 환경과 분리되어 있어, 로컬 테스트 데이터가 실제 서버에 영향을 주지 않습니다.)

