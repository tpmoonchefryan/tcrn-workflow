<div align="center">

# TCRN Workflow

### 에이전트가 "다 했습니다"라고 말합니다. 이 프레임워크는 직접 검증할 수 있는 증거를 내놓게 합니다

**AI 에이전트 딜리버리를 위한 거버넌스 프레임워크. 주장하는 모든 능력이 기계로 반증 가능한 판정 기준에 묶여 있습니다. 기준이 성립하지 않으면 빌드가 레드가 됩니다.**

[简体中文](./README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · 한국어 · [Français](./README.fr.md)

![status](https://img.shields.io/badge/status-1.0.1-blue?style=flat-square) ![gates](https://img.shields.io/badge/verify%3Ap1-15%20gates-brightgreen?style=flat-square) ![claims](https://img.shields.io/badge/proven%20claims-7-brightgreen?style=flat-square) ![deps](https://img.shields.io/badge/runtime%20deps-0-success?style=flat-square)

![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![node](https://img.shields.io/badge/node-24.16.0-informational?style=flat-square) ![pnpm](https://img.shields.io/badge/pnpm-11.3.0-informational?style=flat-square) ![network](https://img.shields.io/badge/network-none-important?style=flat-square) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex-blueviolet?style=flat-square)

[지금 당신의 상황](#지금-당신의-상황) · [왜 믿을 수 있는가](#왜-믿을-수-있는가) · [누구를 위한 것인가](#누구를-위한-것인가) · [무엇을 얻는가](#무엇을-얻는가) · [3분 만에 시작하기](#3분-만에-시작하기) · [현재 상태](#현재-상태) · [전체 문서](#전체-문서)

`Verified claims: 7 (hygiene 7 · inertness 0 · runtime 0)`

</div>

<table>
<tr>
<td align="center" width="25%">

### 15
개 P1 게이트<br><sub>명령 하나. 예상 밖의 일이 있으면 멈춤</sub>

</td>
<td align="center" width="25%">

### 7
개 판정 기준<br><sub>모두 레드 레그 보유, 모두 실측 완료</sub>

</td>
<td align="center" width="25%">

### 61
개 가드<br><sub>하나씩 망가뜨려 해당 테스트의 레드를 요구</sub>

</td>
<td align="center" width="25%">

### 0
개 런타임 의존성<br><sub>네트워크 없음, 데이터베이스 없음</sub>

</td>
</tr>
</table>

> [!TIP]
> **이 README를 믿을 필요는 없습니다**. 설치하고 명령 하나를 실행하면, 자신의 7개 주장을 전부 오프라인으로 증명해 보입니다.

---

## 지금 당신의 상황

에이전트가 파일 30개를 고치고 테스트가 전부 그린이라고 알려왔습니다.

선택지는 두 개입니다. 하나씩 검토한다면 에이전트를 쓰는 의미가 없고, 믿는다면 그것은 도박입니다. 누군가 "이거 배포해도 됩니까"라고 물을 때 그 자리에서 내놓을 수 있는 것이, 10분짜리 대화가 될지 하루짜리 일이 될지를 결정합니다.

TCRN Workflow는 세 번째 선택지를 제공합니다.

| 확인하고 싶은 것 | ✗ 지금 가진 것 | ✓ 도입 후 가지는 것 |
| :--- | :--- | :--- |
| **테스트가 정말 돌았는가** | 채팅 창의 한 줄 | `pnpm verify:p1` — 15개 게이트를 순서대로 실행, 예상 밖의 일이 있으면 그 자리에서 정지 |
| **누가 언제 무엇을 바꿨는가** | 채팅 기록을 되짚기 | 해시로 연결된 추가 전용 이벤트 체인. 이력의 어느 한 건이라도 바꾸면 이후 해시가 전부 어긋남 |
| **보호 장치가 아직 작동하는가** | 작동하리라는 가정 | `pnpm guard-check` — 61개 가드를 소스에서 하나씩 망가뜨리고 각각의 테스트가 레드가 되기를 요구 |
| **손에 든 바이트가 배포된 바이트인가** | 태그를 확인 | 산출물을 바이트 단위로 재구축해 공개된 다이제스트와 대조 |

---

## 왜 믿을 수 있는가

이 프레임워크는 같은 기준을 자기 자신에게 먼저 적용합니다.

`pnpm guard-check`는 **등록된 61개 가드를 소스에서 하나씩 제거하거나 망가뜨리고**, 그 가드를 덮는 테스트가 레드가 되기를 요구합니다. 61개가 전부 레드가 되어야 이번 회차가 통과입니다.

이것이 증명하는 것은 "이런 검사를 작성했다"가 아니라 "이 검사들이 지금도 실제로 막고 있다"입니다. 망가진 채 아무도 알아채지 못한 검사는 검사가 없는 것과 같습니다.

이 기준은 **7개 주장 전부**를 덮습니다. 각 주장은 `verification-map.yaml`에서 안정적인 리즌 코드, 오프라인으로 실행되는 증명, 그리고 레드 레그 — 어떤 변경이 레드를 만드는지 명시하고 그 실패를 실제로 관측한 것 — 에 묶여 있습니다. 7개 전부, 예외 없습니다.

<details>
<summary><b>7개 판정 기준의 구성</b></summary>

<br>

| 분류 | 개수 | 담당 범위 |
| :--- | ---: | :--- |
| `framework-hygiene` | 7 | 프레임워크 자체의 위생: 깨끗한 이력, 소스 허용 목록, 라이선스와 취약점 정책, 오프라인 경계 |
| `inertness-proof` | 0 | 비활성 증명: 호스트 어댑터는 설치 후 명시적으로 활성화가 승인될 때까지 아무 일도 하지 않음 |
| `runtime-capability` | 0 | 런타임 능력: 이벤트 체인, 리스, 뷰, 널리지 코어, 컨텍스트 라우터, 릴리스 세트 |

전체 목록은 `verification-map.yaml`에 있으며, 각 항목이 `id`, `command`, `fixturePaths`와 레드 레그를 가집니다.

</details>

> [!IMPORTANT]
> 판정 기준의 적용 범위를 바꾸고 다시 증명하지 않으면 빌드가 실패합니다. 이것은 스타일 취향이 아니라 강제되는 규칙입니다.

---

## 누구를 위한 것인가

| ✓ 맞는 경우 | ✗ 맞지 않는 경우 |
| :--- | :--- |
| 에이전트에게 결과가 따르는 일을 시킵니다: 프로덕션 코드, 기록이 남아야 하는 딜리버리, 여러 에이전트가 이어받아 누가 무엇을 결정했는지 아무도 기억하지 못하는 상황. | 설치하면 바로 쓰는 무설정 채팅 어시스턴트를 원합니다. |
| 리뷰어에게 건네는 것이 믿어달라고 해야 하는 대화 기록이 아니라, 다시 돌릴 수 있는 산출물이어야 합니다. | 클라우드 동기화, 호스팅 대시보드, 팀 협업 뷰가 필요합니다. |
| 전부 로컬에 두기를 요구합니다: 데이터베이스 없음, 데몬 없음, 네트워크 없음, 텔레메트리 없음. | 작업이 아직 탐색 단계이고, 추가 전용 감사 추적이 지금은 가치가 아니라 부담입니다. |

---

## 무엇을 얻는가

| 얻는 것 | 실제 내용 |
| :--- | :--- |
| **파일만으로 이루어진 워크스페이스** | Initiative → Epic → Story → Subtask 그래프 전체가 정규 형식 JSON과 해시 체인입니다. `cat`과 `sha256sum`으로 감사할 수 있고, 내보내기는 바이트 단위로 재현 가능합니다. |
| **명령 하나로 15개 게이트** | `pnpm verify:p1`이 포맷, lint, 타입, 빌드, 119개 테스트 파일, 트러스트 매트릭스, 아카이브와 SBOM과 라이선스와 취약점 정책, 소스 허용 목록, 오프라인 경계, 프라이버시 스캔, CI 하드닝, 판정 기준 원장, 깨끗한 이력을 차례로 실행합니다. |
| **7개 기계 판독 가능한 판정 기준** | framework-hygiene 7개, inertness-proof 0개, runtime-capability 0개. 전부 레드 레그를 가지고 관측 가능한 리즌 코드에 묶여 있습니다. |
| **스스로 유효함을 증명하는 가드** | 61개 가드. `pnpm guard-check`가 하나씩 망가뜨리고 해당 테스트의 레드를 요구합니다. |
| **137개 거버넌스 CLI 동사** | 전부 로컬 실행. 모든 쓰기는 기준 버전을 선언하며, 누가 먼저 썼다면 거부됩니다. 조용한 덮어쓰기는 없습니다. |
| **런타임 의존성 제로** | `package.json`의 `dependencies`와 `optionalDependencies`가 모두 비어 있습니다. 개발 모드에서는 프로세스 수준 네트워크 가드가 추가됩니다. 텔레메트리는 제로입니다. |

---

## 3분 만에 시작하기

고정 버전 툴체인이 필요합니다: **Node 24.16.0**과 **pnpm 11.3.0**. 의존성 라이프사이클 스크립트는 계속 꺼져 있어, 설치 중에 서드파티 코드가 전혀 실행되지 않습니다.

```sh
# 1. 고정 버전 개발 의존성 설치 (명시적, 잠금, 스크립트 없음)
pnpm install --offline --frozen-lockfile --ignore-scripts

# 2. 프레임워크가 스스로 증명하게 하기 (15개 게이트, 완전 오프라인)
pnpm verify:p1

# 3. 빌드한 뒤 거버넌스 CLI 사용
pnpm build
node scripts/tcrn-workflow.mjs commands
```

<details>
<summary><b>자주 쓰는 거버넌스 명령</b></summary>

<br>

전부 로컬 실행이며, 네트워크도 데이터베이스도 필요 없습니다.

```sh
# 워크스페이스를 검증하고 결정적 뷰를 생성
node scripts/tcrn-workflow.mjs validate --workspace <경로>

# 버전 검증이 붙은 쓰기로 작업 레코드 생성
node scripts/tcrn-workflow.mjs work-create --workspace <경로> --expected-version <버전> ...

# 주제로 작업 레코드 검색
node scripts/tcrn-workflow.mjs work-list --workspace <경로> --search "<키워드>"
```

</details>

> [!NOTE]
> 능력 목록의 권위는 `commands`의 출력이지, 어떤 문서도 아닙니다. 문서는 코드보다 뒤처질 수 있지만 명령 카탈로그는 그렇지 않습니다.

---

## 현재 상태

수리된 버전은 **1.0.1**입니다. 수리된 각 버전은 불변 태그와 재현 가능한 산출물 한 벌이며, `CHANGELOG.md`가 전체 원장입니다.

공개, 푸시, 태깅은 각각 독립된 관문이며 로컬 테스트에서 추론되지 않습니다. 외부 사용자는 함께 제공되는 `tcrn-workflow-helper`로 릴리스 바이트를 검증합니다. 그 부트스트랩 다이제스트는 별도로 공개되어 독립적으로 확인할 수 있습니다.

알려진 경계는 Wiki의 "알려진 제한" 페이지에 있습니다: 워크스페이스당 라이터 1개, 이벤트 규모 상한, 복구는 원래 경로만 지원. 이것들은 설계 결정이지 할 일 목록이 아닙니다.

## 전체 문서

아키텍처 개요, 명령 레퍼런스, 판정 기준과 게이트, 리포지토리 레이아웃, 알려진 제한, FAQ는 모두 이 리포지토리의 GitHub Wiki에 있습니다. 리포지토리 페이지 상단의 **Wiki** 탭에서 열 수 있습니다.

[기여하기](./CONTRIBUTING.md) · [보안 정책](./SECURITY.md) · [프라이버시](./PRIVACY.md) · [행동 강령](./CODE_OF_CONDUCT.md) · [지원](./SUPPORT.md)

## 라이선스

Apache-2.0. [LICENSE](./LICENSE)와 [NOTICE](./NOTICE)를 참조하세요.
