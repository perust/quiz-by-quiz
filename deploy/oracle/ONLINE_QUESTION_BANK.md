# 온라인 전용 문제은행 운영 계약

`quiz-by-quiz`의 GitHub Pages `data/` 디렉터리는 브라우저에 공개되며 `answerIndex`와 해설을 포함합니다. **온라인 매치 API는 그 디렉터리, 그 사본, 또는 질문·보기·정답이 동일한 파생본을 사용하면 안 됩니다.** 그렇게 하면 API가 응답에서 정답을 숨겨도 참가자가 Pages artifact나 공개 Git 저장소에서 답을 미리 찾을 수 있습니다.

## 필요한 content

운영자는 Git 저장소 밖의 비공개 디렉터리에 아래 다섯 JSON 파일을 둡니다.

```text
<private-bank>/
├── history.json
├── science.json
├── geography.json
├── general.json
└── art.json
```

각 파일은 `server/app/question_catalog.py`가 검증하는 배열 형식입니다.

```json
[
  {
    "id": "online-history-001",
    "category": "history",
    "question": "질문",
    "choices": ["보기 1", "보기 2", "보기 3", "보기 4"],
    "answerIndex": 0,
    "explanation": "해설",
    "difficulty": "normal",
    "tags": []
  }
]
```

- 모든 category에 **최소 10문제**가 필요합니다. category match는 10문제, 전체 match는 category별 5문제를 고정합니다.
- 모든 `id`는 전체 bank에서 유일해야 합니다.
- 질문·보기·정답·해설은 공개 Pages `data/`와 독립적으로 작성·검수해야 합니다. 단순 ID 변경, 보기 순서 변경, 번역만 한 사본은 공개 자료와 대조될 수 있으므로 허용하지 않습니다.
- bank는 온라인 API container만 read-only로 읽습니다. Git, GitHub Pages artifact, Docker build context, 브라우저 응답에 전체 파일을 넣지 않습니다.

## Oracle host provision

Compose는 `QUIZ_ONLINE_BANK_DIR`을 요구하고 이를 API container의 `/run/quiz-by-quiz/online-bank`로 read-only bind mount합니다. 실제 경로와 문항 content는 다음 배포 직전에 운영자가 별도로 준비합니다.

권장 권한은 container의 non-root UID/GID `10001:10001`만 읽을 수 있게 하는 것입니다.

```bash
sudo install -d -o 10001 -g 10001 -m 0750 /srv/quiz-by-quiz/online-bank
sudo install -o 10001 -g 10001 -m 0640 <local-file> /srv/quiz-by-quiz/online-bank/history.json
# 나머지 네 category도 같은 방식으로 배치
```

배포 환경 파일에는 경로만 넣습니다. DB URL, DB password, browser session secret을 이 파일이나 Git에 넣지 않습니다.

```dotenv
QUIZ_ONLINE_BANK_DIR=/srv/quiz-by-quiz/online-bank
```

컨테이너 기동 전 실제 mounted directory 안에서 catalog 검증을 실행해야 합니다. `QUESTION_BANK_DIR`가 누락·비어 있거나 공개 `data/`를 가리키면 API는 fail-closed로 시작하지 않습니다.

## 현재 상태

이 저장소에는 의도적으로 실제 online bank가 없습니다. 따라서 비공개·독립 문항 content를 provision하고 검증하기 전에는 공개 API 배포를 진행하면 안 됩니다.
