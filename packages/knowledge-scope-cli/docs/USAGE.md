# 내 자료로 시작하는 KS 사용 가이드

지금 쓰는 AI 대화에서 내 자료를 참고하고, 답변의 출처를 확인하세요. 연결 ID를 복사하거나 검색 결과 JSON을 읽을 필요 없이 사용 스킬이 처리합니다.

## AI 대화에서 시작하기

Node.js 22 또는 24와 로컬 명령을 실행할 수 있는 스킬 지원 AI 도구가 필요합니다. 프로젝트 터미널에서 한 번 설치하세요. 설치 화면에서 사용할 AI 도구와 설치 범위를 확인합니다.

```bash
npx skills add schift-io/knowledge-scope --skill schift-knowledge-scope
```

그 도구에서 `schift-knowledge-scope` 스킬을 선택하고 이렇게 요청하세요. 폴더 경로는 내 자료 위치로 바꿉니다.

> `$schift-knowledge-scope`로 `./my-documents` 연결해서 환불 규정을 찾아줘. 출처도 보여줘.

스킬이 명령 실행과 자료 연결을 처리합니다. 다음 질문은 **“같은 자료로 배송 기간은?”**이면 됩니다. 자료를 고쳤다면 **“연결한 자료 갱신해줘”**, 다른 대화에서 이어 쓰려면 **사용할 자료나 기존 프로젝트 폴더**를 다시 지정하세요. 일반적인 파일 질문만으로 스킬이 반드시 자동 실행된다는 뜻은 아닙니다.

```text
스킬 설치 → 사용할 자료와 질문 전달 → 답변·출처 확인 → 같은 대화에서 후속 질문
```

처음 실행할 때 npm에서 실행 도구를 내려받아 캐시에 보관할 수 있습니다. 앱 의존성에 설치하거나 전역 설치할 필요는 없습니다. 선택한 원문은 비공개 로컬 스냅샷으로 복사됩니다. 검색 자체는 모델을 호출하지 않지만, 검색한 문구를 대화에서 사용하면 해당 AI 도구의 전송·보관 정책이 적용됩니다. 민감한 자료는 사용 중인 AI 환경에서 처리해도 되는지 먼저 확인하세요.

현재 로컬 입력은 **`.md`·`.txt` 파일/폴더**, 검색은 **키워드 방식**입니다. PDF·Office·웹 주소 자동 수집은 없습니다. 근거가 없으면 답변을 보류합니다. 24시간 최신성 조건은 유지되며, 갱신은 요청할 때만 수행합니다. 대화를 끝내도 저장된 원문은 삭제되지 않습니다.

**배포 구분:** 공개 npm은 `0.2.0`입니다. 스킬은 이 버전의 기존 명령으로 연결·검색·갱신 과정을 대신 처리할 수 있습니다. 아래의 간단한 `connect`·`ask`·`refresh` 명령은 아직 배포되지 않은 소스 체크아웃 기능입니다. npm에 이미 있는 기능으로 안내하지 않습니다.

### 개발 중인 간단한 CLI 직접 확인하기

저장소에서 패키지를 빌드한 뒤, 저장소 루트에서 실행합니다. `connect`는 첫 연결, `ask`는 저장된 자료 검색, `refresh`는 명시적 갱신입니다.

```bash
node packages/knowledge-scope-cli/dist/main.js connect ./my-documents
node packages/knowledge-scope-cli/dist/main.js ask '환불 규정'
node packages/knowledge-scope-cli/dist/main.js refresh
```

기본 프로젝트는 현재 폴더의 `.schift-ks`입니다. 다른 프로젝트는 `--project ./customer-b`로 지정합니다. 같은 자료를 다시 연결하면 재사용하고, 다른 자료로 몰래 교체하지 않습니다. 갱신에 실패하면 이전 연결을 보존하지만 만료된 근거를 유효한 것으로 취급하지 않습니다. 앱 개발용 SDK와 기존 CLI의 정확한 결과 구조가 필요하면 아래를 이어 읽으세요.

### 계속 운영할 때

소스 체크아웃의 `0.3.0` 후보는 macOS/Linux의 한 로컬 사용자 환경을 대상으로 합니다. 프로젝트와 상태는 로컬 파일시스템에 두고, 같은 네트워크 환경에서 실행하세요. 공유 네트워크 드라이브·컨테이너 간 상태 공유·Windows 지원을 가정하지 마세요.

강제 종료 뒤에는 같은 명령을 다시 실행합니다. 잠금 오류가 계속되면 파일을 지우지 말고 [복구 절차](OPERATIONS.md#recover-after-interruption)를 따르세요. `.project.lock`·`state.lock` 디렉터리는 정상적으로 남는 보호 표식입니다. 과거 npm 버전의 잠금 파일과는 다릅니다.

갱신은 이전 자료를 자동 삭제하지 않습니다. 보관량 정리와 백업·복원은 [운영 가이드](OPERATIONS.md)에서 별도로 처리합니다. 스킬은 질문이나 대화 종료를 자료 삭제·프로그램 업그레이드 요청으로 해석하지 않습니다. 아래 개발자 예시는 배포된 `0.2.0`을 유지하며, 후보 버전의 복구·정리 기능이 이미 npm에 있다고 가정하지 않습니다.

## 개발자용: 배포된 0.2.0 CLI·SDK

다음은 AI 스킬 없이 CLI/SDK를 직접 통합하는 경로입니다. 스킬 사용자에게 이 단계를 반복할 필요는 없습니다. 공개 샘플로 자료 연결·검색·출처를 확인한 뒤 같은 연결을 앱에서 재사용합니다.

## 1. 샘플로 첫 결과 얻기

Node.js 20 이상이 필요합니다. 아래는 macOS/Linux 터미널 기준입니다. `ks-start`가 이미 있다면 다른 새 이름을 사용하세요.

```bash
mkdir ks-start
cd ks-start
npm install @schift-io/knowledge-scope@0.2.0
npx --no-install schift-ks quickstart ./support-project \
  --source ./node_modules/@schift-io/knowledge-scope/examples/local-documents/support-handbook.md \
  --query '환불 규정'
```

패키지 설치에는 인터넷이 필요하지만, 이 샘플의 자료 수집·검색은 로컬에서 수행됩니다. 원문을 클라우드나 모델로 보내지 않습니다. 실행 중에는 명령이 끝날 때까지 기다리세요. 목적지 폴더는 자동 생성되므로 `support-project`를 미리 만들지 마세요.

출력에서 다음을 확인합니다.

- `installationId`: 다음 질문에서 사용할 연결 ID. 복사해 두세요.
- `tenant`: 기본값은 `local-tenant`. SDK 호출에서도 같은 값을 사용합니다.
- `result.status`: `ready`이면 검사에 통과한 근거가 있습니다.
- `result.candidates`: 샘플의 14일 환불 규정 문구와 출처가 포함됩니다.

샘플은 가상 정책이며 실제 고객 데이터나 정확도 벤치마크가 아닙니다. `status: completed`는 명령 종료를 뜻할 뿐, 근거가 충분하다는 뜻이 아닙니다. 반드시 **안쪽 `result.status`**를 확인하세요.

샘플은 작은 문서여서 22줄 전체가 하나의 근거로 반환됩니다. 환불 문단만 골라 반환된다고 가정하지 마세요. [실제 실행 결과와 관계없는 질문 사례](DEMO.md)를 함께 확인할 수 있습니다.

## 2. 결과를 어떻게 해석하나?

`ready`는 선언된 출처·권한 방식·최신성·필수 근거 조건을 통과했다는 뜻입니다. 질문을 의미적으로 이해했다거나, 그 문구로 만든 최종 답변이 옳다는 보장은 아닙니다. 로컬 검색은 키워드 방식이므로 원문에 있는 단어로 질문하세요.

출처의 `schift://local-documents/...#Lx-Ly`는 가져온 스냅샷과 줄 범위를 식별합니다. 브라우저에서 열리는 공개 URL이 아닙니다. 파일명·줄 범위·내용 해시로 근거를 추적할 수 있습니다. `sourcePath`는 원본 경로이며, 그 파일이 나중에 수정되어도 이미 반환된 스냅샷의 내용은 바뀌지 않습니다.

`insufficient_evidence`이면 앱에서 답변을 보류하거나 추가 자료를 요청하세요. 질문 표현, 연결한 자료, 24시간 최신성 조건을 확인하세요. 검사를 우회하거나 빈 결과를 모델의 추측으로 채우지 마세요.

## 3. 같은 자료에 다시 질문하기

`<installation-id>`를 1단계 출력의 실제 ID로 바꿉니다.

```bash
npx --no-install schift-ks query '<installation-id>' --query '배송 기간'
```

샘플에서는 영업일 3~5일 배송 문구를 기대할 수 있습니다. `query`는 해당 연결의 tenant를 읽어 사용합니다. 폴더 이름으로 다른 프로젝트를 추측하거나 자동 선택하지 않습니다.

터미널이나 앱을 재시작해도 같은 로컬 사용자·상태 디렉터리와 ID를 사용하면 연결을 다시 쓸 수 있습니다. 새 터미널에서는 `ks-start`로 돌아와 실행하세요. 기본 상태 위치는 `~/.schift/knowledge-scope`입니다. `SCHIFT_KS_HOME`을 설정했다면 CLI와 SDK 모두 같은 값을 유지해야 합니다.

ID를 잊었다면 `support-project/installation.json`에서 확인하세요. 저장된 파일은 생성 당시 기록이므로 현재 활성 여부나 revision은 다음 명령으로 확인합니다.

```bash
npx --no-install schift-ks inspect '<installation-id>'
npx --no-install schift-ks doctor '<installation-id>'
```

기본 `doctor`는 설정 검사입니다. `evidenceVerified: false`이면 실제 검색 성공을 확인한 것이 아닙니다. 검색 확인이 필요하면 `query`를 실행하세요.

## 4. 내 자료로 바꾸기

`ks-start/my-documents` 폴더에 승인된 UTF-8 `.md`·`.txt` 자료만 넣습니다. 원본을 직접 고치거나 이동할 필요는 없습니다.

```bash
npx --no-install schift-ks quickstart ./my-project \
  --source ./my-documents --query '환불 규정'
```

폴더 대신 파일 하나를 지정해도 됩니다. 개인정보·비밀키가 섞인 전체 홈 디렉터리나 전체 저장소를 무심코 지정하지 마세요. 폴더 안에서는 다른 확장자를 건너뛰지만, `.txt`에 담긴 비밀정보까지 자동으로 찾아 제거하지는 않습니다.

가져오기 한도는 100파일, 파일당 1 MiB, 전체 텍스트 8 MiB, 4,000청크입니다. 한 줄은 2,000자 이하입니다. 폴더 탐색은 2,000항목·16단계까지이며 숨김 항목과 `node_modules`는 제외됩니다. 심볼릭 링크·하드 링크·특수 파일·수집 중 바뀐 파일은 거절됩니다.

### 무엇이 생성되고, 무엇을 공유하면 안 되나?

```text
my-project/
├── pack/
│   ├── scope.json
│   ├── scope.lock.json
│   └── schemas/{input,result}.json
├── bindings.json
├── input.json
└── installation.json

~/.schift/knowledge-scope/   ← 별도의 비공개 로컬 상태
```

| 위치 | 내용과 취급 |
| --- | --- |
| `pack/scope.json` | 검색 선언과 근거 조건. 원문이 아니라 스냅샷 참조가 들어갑니다. |
| `pack/schemas/*.json` | 검색 입력·결과의 허용 형식. |
| `pack/scope.lock.json` | 선언과 참조 스키마의 무결성 확인값. |
| `bindings.json` | 이 환경에서 쓸 자료 참조와 접근 범위. 환경별 연결 정보이므로 비공개로 보관합니다. |
| `input.json` | 첫 질문과 실행 범위. 질문 자체에 민감정보가 있을 수 있습니다. |
| `installation.json` | 생성된 연결의 ID·revision 등 기록. 다른 컴퓨터에서 이것만 복사해도 작동하는 것은 아닙니다. |
| 로컬 상태 | 원문 복사본인 `local-documents` 스냅샷, 연결 상태, 별도 인증 키. 공개 저장소에 올리지 않습니다. |

Pack은 연결된 자료를 자동으로 가져오는 배포 묶음이 아닙니다. 다른 환경에서는 그 환경의 자료와 연결을 준비해야 합니다. Pack도 프로젝트 이름·검색 조건 등 공개해도 되는지 검토한 뒤 공유하세요. 로컬 홈 경로·토큰·원문·Candidate 출력·전체 상태 폴더는 공개 이슈나 채팅에 붙이지 마세요.

### 자료를 수정했거나 24시간이 지났다면

기존 연결은 원본을 실시간으로 읽지 않습니다. 기본 생성 정책은 가져온 시점부터 24시간까지 스냅샷을 허용합니다. 타임스탬프를 수정하지 말고 새 작업 폴더로 다시 가져오세요.

```bash
npx --no-install schift-ks quickstart ./my-project-refreshed \
  --source ./my-documents --query '환불 규정'
```

앱에서 새 ID로 교체하세요. **새로 가져와도 이전 연결은 자동 해제되지 않습니다.** 이전 연결을 더는 쓰지 않으려면 현재 revision을 확인하고 명시적으로 해제합니다.

```bash
npx --no-install schift-ks inspect '<old-installation-id>'
npx --no-install schift-ks unmount '<old-installation-id>' --expected-revision <current-revision>
```

해제는 연결을 비활성화하는 작업이며 **보관된 원문 스냅샷을 지우는 작업이 아닙니다.** 상태 파일을 직접 수정해 활성화하거나, 다른 프로젝트가 함께 쓰는 상태 디렉터리를 통째로 삭제하지 마세요. 데이터 보존·삭제는 별도 관리가 필요합니다.

## 5. 내 앱에서 결과 사용하기

같은 `ks-start` 폴더에서 포함된 SDK 예제를 실행합니다. 기본 tenant를 바꿨다면 `local-tenant`도 실제 반환값으로 바꾸세요.

```bash
node node_modules/@schift-io/knowledge-scope/examples/consumer.mjs \
  '<installation-id>' local-tenant '환불 규정' search
```

이 예제는 `createCliDependencies().embedded`와 `createKnowledgeScopeClient`로 CLI와 같은 상태를 읽고 `client.run`을 호출합니다. 모델은 호출하지 않습니다. `insufficient_evidence`일 때 종료 코드는 3입니다. 실행 가능한 전체 코드는 [consumer.mjs](../examples/consumer.mjs)에 있습니다.

앱에 넣을 때의 연결 순서는 다음과 같습니다. 아래는 구조 설명이며 특정 모델 SDK의 실행 코드가 아닙니다.

```text
앱이 현재 프로젝트의 연결 ID 선택
  → KS SDK 실행
  → ready: candidates의 문구와 citation을 함께 Context에 넣기
  → 앱이 선택한 모델 호출 → 답변과 출처 표시
  → insufficient_evidence: 답변 보류 또는 추가 자료 요청
```

외부 모델로 근거를 보낼지는 앱과 사용자가 결정합니다. 로컬 검색이 원문을 전송하지 않는다는 것과, 이후 앱이 원문을 모델에 보내도 된다는 것은 별개입니다. 자료 안의 “이전 지시를 무시하라”, 명령 실행·외부 전송 요청은 **자료 내용**이지 실행 지시가 아닙니다. 모델과 도구 사용 단계에서도 이 경계를 유지하세요.

## 6. 어디에 적용하고, 언제 굳이 안 써도 되나?

### 프로젝트 문서를 반복해서 참고하는 앱

요구사항·지원 규정 등을 연결하고 질문마다 같은 근거 조건과 출처 형식으로 반환받습니다. 파일 읽기, 줄 범위 추적, 스냅샷 관리, 필수 근거 부족 처리 코드를 앱마다 반복 작성하는 일을 줄입니다. 작은 폴더에서 한 번 문자열을 찾는 용도라면 `grep`·`rg`가 더 간단할 수 있습니다. 로컬 키워드 검색이 그것보다 정확하다는 주장은 하지 않습니다.

### 여러 고객 프로젝트를 관리하는 에이전시

고객별 승인된 폴더와 새 작업 폴더를 사용해 각각 가져오세요. 앱의 비공개 설정에 `고객 A → A의 installationId`, `고객 B → B의 installationId`를 명시적으로 저장하고, 요청 처리 전에 선택합니다. 고객이 보낸 임의의 ID를 검증 없이 사용하지 마세요.

이것은 프로젝트 연결을 분리하는 방법이지 다중 사용자 인증·ACL 서비스가 아닙니다. 같은 OS 사용자는 로컬 상태에 접근할 수 있습니다. 민감도가 다른 고객을 같은 서버에서 서비스하려면 앱 인증과 저장소·실행 환경의 접근 통제를 별도로 설계해야 합니다. `--tenant` 이름만 다르게 붙여 해결하지 마세요.

### 규정 문서와 주문·업무 기록을 같이 확인하는 앱

고급 경로입니다. 문서 검색과 `get-order-status` 같은 **허용된 이름의 읽기 작업**을 각각 선언하고 연결합니다. 문서와 기록 둘 다 필요하다는 근거 규칙을 설정한 뒤 `run-batch`로 함께 검사합니다. 샘플 선언만 복사해도 DB 연결이 생기지는 않습니다.

별도 검색 서비스·Connector 설정 또는 SDK의 named-record 실행 포트 구현이 필요합니다. 기본 CLI는 DB 비밀번호나 접속 문자열을 받아 자동 설정하지 않고, 임의 SQL을 실행하지 않습니다. 여러 소스가 같은 시점의 트랜잭션이라는 보장도 없습니다. 구체적인 계약은 [복합 소스 도입 가이드](PILOT.md#extend-to-documents-plus-live-records)를 참고하세요.

## 7. 대화에서 자료를 선택한다는 뜻

스킬 설치는 AI 도구가 사용 지침을 발견하게 하는 일이며, 자료를 모든 대화에 활성화하는 일이 아닙니다. 새 대화·분기에서는 자료를 다시 선택합니다. 기존 프로젝트를 이름으로 지정하면 스킬이 연결 상태를 확인한 뒤 재사용합니다.

스킬은 대화 안에 재사용에 필요한 최소 연결 정보만 유지합니다. 전역 세션 목록이나 전체 대화 로그의 새 영구 저장소를 만들지 않습니다. 프로젝트를 바꾸면 이전 근거를 더는 사용하지 않지만, 이미 남은 대화 메시지를 지우지는 못합니다.

이 동작은 스킬의 절차이지 런타임 격리가 아닙니다. 자동 시작·종료 후크는 없으며 대화를 끝내도 연결이나 서버 권한이 해제되지 않습니다. 실제 권한은 실행 계층이 검사합니다. Schift Search 어댑터는 보장하지 못하는 `namespace`·`subject`·`session` 범위 지정을 거절합니다. 사용 스킬은 Let Skill 컴파일러나 MCP 서버가 아닙니다.

## 8. 현재 지원 범위

| 필요한 일 | 0.2.0에서 가능한 경로 |
| --- | --- |
| `.md`·`.txt` 파일/폴더 검색 | 계정 없는 로컬 키워드 검색과 스냅샷 출처. |
| 의미 검색·임베딩·reranking | 로컬 경로에는 없음. 별도 검색 기반이 필요합니다. |
| PDF·Office·웹 URL 수집 | 번들에 없음. 별도 승인된 변환·수집 후 텍스트로 연결합니다. |
| 이미 인덱싱된 Schift Search | 주소·토큰·조직·인덱스를 준비한 [hosted 경로](../README.md#hosted-search-advanced). |
| 자료 자동 동기화·문서별 실시간 ACL | 로컬 경로에는 없음. 원본 편집 후 새로 가져와야 합니다. |
| Codex/Claude 등에 MCP 등록 | 번들 MCP 어댑터 없음. 사용 스킬과 혼동하지 마세요. |
| TypeScript/JavaScript 앱 | Node.js 실행 SDK·CLI 제공. |
| Python 앱 | 계약·순수 검증 구현 제공. 별도 Python 검색 실행 SDK는 아님. |

## 9. 막혔을 때

성공 결과는 stdout, 오류 JSON은 stderr에 나옵니다. 오류의 `code`와 비밀정보를 뺀 상황만 공유하세요.

| 상태·코드 | 다음 행동 |
| --- | --- |
| `directory_exists` | 기존 폴더는 보존됩니다. 새 목적지 이름을 사용하세요. |
| `local_source_invalid` | 읽을 수 있는 UTF-8 `.md`·`.txt`인지, 링크가 아닌지 확인하세요. |
| `local_limit_exceeded` | 파일 수·크기·긴 줄·폴더 깊이를 줄이세요. |
| `local_snapshot_invalid` | 스냅샷을 임의 수정하지 말고 승인된 원본을 새 작업 폴더로 가져오세요. |
| `installation_not_found` | ID와 로컬 사용자, `SCHIFT_KS_HOME`이 이전 실행과 같은지 확인하세요. |
| `installation_not_mounted` | 해제된 연결입니다. 의도적으로 새 연결을 준비하세요. |
| `scope_invalid` | 다른 tenant로 우회하지 말고 요청과 승인된 연결 범위를 맞추세요. |
| `mount_conflict` | `inspect`로 최신 revision을 확인한 뒤 의도한 작업만 재시도하세요. |
| `invalid_configuration` | 고급 provider 설정이 필요합니다. 로컬 샘플과 구분하세요. |
| `insufficient_evidence` | 오류 코드가 아니라 결과 상태입니다. 근거·질문 표현·최신성을 확인하고 답변은 보류하세요. |

Quickstart가 중간에 실패했다면 출력의 `artifactsComplete`와 `recovery`를 먼저 확인하세요. `false`일 때는 생성 파일이 완전하다고 가정해 mount하지 마세요. 원본은 변경하지 않지만 부분 작업 폴더나 로컬 스냅샷이 남을 수 있습니다.

전체 명령·스키마·보안 계약은 [CLI/SDK 레퍼런스](../README.md), 고객 도입 검증 항목은 [PILOT](PILOT.md)에 있습니다.
