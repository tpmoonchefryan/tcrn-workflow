<div align="center">

# TCRN Workflow

### 에이전트의 "완료했습니다"를 직접 검증할 수 있는 증거로 바꿉니다

**AI 에이전트 딜리버리를 위한 거버넌스 프레임워크. 주장하는 모든 기능이 기계로 반증 가능한 주장입니다.**

[简体中文](./README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · 한국어 · [Français](./README.fr.md)

![status](https://img.shields.io/badge/status-1.0.1-blue) ![gates](https://img.shields.io/badge/verify%3Ap1-24%20gates-brightgreen) ![claims](https://img.shields.io/badge/proven%20claims-122-brightgreen) ![deps](https://img.shields.io/badge/runtime%20deps-0-success)

![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![node](https://img.shields.io/badge/node-24.16.0-informational) ![pnpm](https://img.shields.io/badge/pnpm-11.3.0-informational) ![network](https://img.shields.io/badge/network-none-important) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex-blueviolet)

[무엇을 해결하는가](#무엇을-해결하는가) · [누구를 위한 것인가](#누구를-위한-것인가) · [무엇을 얻는가](#무엇을-얻는가) · [3분 만에 시작하기](#3분-만에-시작하기) · [실제 예시](#실제-예시) · [현재 상태](#현재-상태) · [전체 문서](#전체-문서)

`Verified claims: 122 (hygiene 20 · inertness 13 · runtime 89)`

</div>

---

## 무엇을 해결하는가

에이전트는 테스트가 통과했다고 말합니다. 당신 손에 있는 것은 채팅 창의 한 줄뿐입니다.

TCRN Workflow는 그 한 줄을 검증 가능한 세 가지로 바꿉니다.

- **주장 원장.** 프레임워크가 주장하는 모든 기능은 `verification-map.yaml`의 주장과 대응하며, 안정적인 사유 코드에 묶이고, 오프라인으로 실행되는 테스트로 증명됩니다.
- **변조가 드러나는 이벤트 체인.** 워크스페이스의 모든 변경은 연결된 레코드입니다. 각 항목은 바로 앞 항목에 해시로 묶이고, 추가만 가능하며, 이력은 다시 쓸 수 없습니다.
- **재현 가능한 릴리스.** 모든 버전을 바이트 단위로 다시 만들어 공개된 다이제스트와 대조할 수 있습니다.

주장의 범위를 바꾸고 다시 증명하지 않으면 빌드가 실패합니다. 권고가 아니라 강제입니다.

## 누구를 위한 것인가

| | |
| --- | --- |
| **적합합니다** | 결과가 따르는 일에 에이전트를 씁니다. 운영 코드, 기록이 남아야 하는 딜리버리, 누가 결정했는지 아무도 기억하지 못하는 에이전트 간 인계. 믿어야만 하는 대화 기록이 아니라, 검토자가 확인할 수 있는 산출물을 원합니다. 모든 것이 자기 컴퓨터에 남기를 원합니다. 데이터베이스 없음, 데몬 없음, 네트워크 없음, 텔레메트리 없음. |
| **적합하지 않습니다** | 설정이 필요 없는 채팅 도우미를 원하거나, 클라우드 동기화나 호스팅 대시보드가 필요하거나, 작업이 탐색적이어서 추가 전용 감사 기록이 가치보다 마찰이 되는 경우. |

## 무엇을 얻는가

| 얻는 것 | 구체적으로 |
| --- | --- |
| **파일만으로 이루어진 워크스페이스** | Initiative → Epic → Story → Subtask 전체 작업 그래프가 정규화된 JSON과 해시 체인입니다. `cat`과 `sha256sum`으로 감사할 수 있고, 내보내기는 바이트 단위로 재현됩니다. |
| **명령 하나로 24개 게이트** | `pnpm verify:p1`이 포맷, lint, 타입 검사, 빌드, 134개 테스트 파일, 신뢰 매트릭스, 아카이브와 SBOM과 라이선스와 취약점 정책, 소스 허용 목록, 오프라인 경계, 프라이버시 검사, CI 강화, 주장 원장, 깨끗한 이력 증명을 차례로 실행합니다. 예상 밖의 일이 하나라도 있으면 멈춥니다. |
| **기계가 읽는 122개 주장** | `verification-map.yaml`이 122개 주장을 관측 가능한 사유 코드에 묶습니다. 프레임워크 위생 20, 비활성 증명 13, 런타임 능력 89. 122개 모두 레드 레그를 가지며, 무엇을 바꾸면 빨간불이 되는지 적혀 있고 그 빨간불은 실측되었습니다. |
| **여전히 작동함을 스스로 보이는 가드** | `pnpm guard-check`는 등록된 61개 가드를 하나씩 소스에서 망가뜨리고, 대응하는 테스트가 빨간불이 되기를 요구합니다. |
| **통제되는 137개 CLI 동사** | 모두 로컬에서 동작합니다. 모든 쓰기는 어느 버전을 기준으로 하는지 선언하며, 다른 쪽이 먼저 썼다면 조용히 덮어쓰지 않고 거절합니다. |
| **런타임 의존성 0** | `package.json`의 `dependencies`와 `optionalDependencies`가 모두 비어 있습니다. 개발 모드에서는 프로세스 수준 네트워크 가드도 설치되며 텔레메트리는 0입니다. |

## 3분 만에 시작하기

고정된 툴체인이 필요합니다. Node 24.16.0과 pnpm 11.3.0. 의존성 생명주기 스크립트는 항상 꺼져 있어, 설치 과정에서 서드파티 코드가 실행되지 않습니다.

```sh
# 1. 고정된 개발 의존성 설치. 잠금 파일 고정, 스크립트 미실행
pnpm install --offline --frozen-lockfile --ignore-scripts

# 2. 프레임워크가 스스로를 증명하게 한다. 24개 게이트, 완전 오프라인
pnpm verify:p1

# 3. 빌드한 다음 통제되는 CLI를 사용한다
pnpm build
node scripts/tcrn-workflow.mjs commands
```

자주 쓰는 통제 명령. 모두 로컬이며 네트워크도 데이터베이스도 필요 없습니다.

```sh
# 워크스페이스를 검증하고 결정적 뷰를 생성한다
node scripts/tcrn-workflow.mjs validate --workspace <경로>

# 버전 검사가 붙은 쓰기로 작업 레코드를 만든다
node scripts/tcrn-workflow.mjs work-create --workspace <경로> --expected-version <버전> ...

# 주제로 작업 레코드를 검색한다
node scripts/tcrn-workflow.mjs work-list --workspace <경로> --search "<키워드>"
```

## 실제 예시

`pnpm guard-check`는 등록된 61개 가드를 하나씩 소스에서 제거하거나 망가뜨린 뒤, 그 가드에 대응하는 테스트가 빨간불이 되기를 요구합니다. 61개가 모두 빨간불이 되어야 이 회차가 통과합니다.

이것이 증명하는 것은, 그 보호 장치들이 과거에 작성되었다는 사실이 아니라 지금도 작동한다는 사실입니다. 망가져도 아무도 알아차리지 못하는 검사는 검사가 없는 것과 같습니다.

## 현재 상태

현재 승인된 릴리스는 1.0.1입니다. 승인된 각 버전은 불변 태그와 재현 가능한 산출물 묶음이며, `CHANGELOG.md`가 전체 원장입니다.

배포, 푸시, 태깅은 각각 별개의 관문이며 로컬 테스트에서 추론되지 않습니다. 외부 사용자는 함께 제공되는 `tcrn-workflow-helper`로 릴리스 바이트를 검증합니다. 헬퍼 자체의 부트스트랩 다이제스트는 별도로 공개되어 독립적으로 확인할 수 있습니다.

알려진 경계는 wiki의 "알려진 한계" 페이지에 있습니다. 워크스페이스당 쓰기 주체 하나, 이벤트 수 상한, 동일 경로로만 복원. 이는 설계 결정이며 남은 할 일이 아닙니다.

## 전체 문서

아키텍처, 명령 레퍼런스, 주장과 게이트, 저장소 구조, 알려진 한계, 솔직한 답변은 이 저장소의 GitHub wiki에 있습니다. 저장소 페이지 상단의 Wiki 탭으로 들어갑니다.

[기여](./CONTRIBUTING.md) · [보안](./SECURITY.md) · [프라이버시](./PRIVACY.md) · [행동 강령](./CODE_OF_CONDUCT.md) · [지원](./SUPPORT.md)

## 라이선스

Apache-2.0. [LICENSE](./LICENSE)와 [NOTICE](./NOTICE)를 참조하세요.
