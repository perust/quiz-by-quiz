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
- 같은 방의 다음 판은 그 방의 최근 판(최대 120문항, match 수명 동안)에 나온 문항을 후순위로 미룹니다. category의 문항이 많을수록
  «한 판 더»에서 같은 문제가 되풀이되기까지 오래 걸립니다 — 최소치(10문제)면 둘째 판부터 같은 문제가 돌아옵니다.
- 판이 끝나면 그 판의 참가자는 자기가 푼 문항의 질문·보기·정답·해설을 다시 볼 수 있습니다(«문제 다시 보기»). 공개 단계에서 문항마다
  이미 본 것이며, 끝나기 전의 응답과 판에 없던 사람에게는 보내지 않습니다.
- 모든 `id`는 `online-<category>-<숫자>` 형식(예: `online-history-001`, `<category>`는 그 문항의 category)이고 전체 bank에서 유일해야 합니다. 공개 `data/`의 형식(`<category>-NNN`, 예: `history-001`)인 `id`가 하나라도 있으면 API가 시작하지 않습니다. migration 011 후보 API부터 생긴 규칙이므로 배포 전에 확인합니다(아래 «migration 011 전에 bank 확인»).
- 게임의 «이 문제 이상해요»는 온라인 문항의 `id`와 category만 **공개** GitHub 이슈로 보냅니다(«문제 번호만 보내요»). 질문·보기·정답·해설은 싣지 않습니다. 그러니 `id`에 내용을 담지 않습니다 — `online-history-001`처럼 번호만 쓰고 `online-history-hangul-1446` 같은 이름을 짓지 않습니다. 받은 신고는 운영자가 이 비공개 bank에서 `id`로 찾아 처리합니다(`docs/question-bank-maintenance.md`의 «받은 신고 처리»).
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

API는 다음 경우 fail-closed로 시작하지 않습니다.

- `QUESTION_BANK_DIR`가 누락·비어 있거나 컨테이너 안의 공개 `data/` 경로를 가리킬 때(경로 비교)
- 다섯 JSON 파일 가운데 하나라도 없거나 위 형식에 맞지 않을 때
- 어느 파일에든 공개 `data/` 형식(`<category>-NNN`)의 `id`가 하나라도 있을 때. 경로가 아니라 내용을 보므로 호스트가 `data/`의 사본을 `QUIZ_ONLINE_BANK_DIR`에 두어도 시작하지 않습니다. 오류에는 개수와 파일 이름만 남고 질문·보기·정답·해설은 남지 않습니다.

`id`를 바꾼 사본처럼 번호로 알아볼 수 없는 파생본은 서버가 막지 못합니다 — 위 «독립적으로 작성·검수» 규칙이 막아야 합니다. 공개 형식은 아니지만 `online-<category>-<숫자>` 형식도 아닌 `id`는 시작을 막지 않고, 그런 `id`의 개수만 담은 경고 한 줄을 API 로그(`docker logs`)에 남깁니다. 번호 자체는 로그에 남기지 않으니 비공개 bank에서 형식을 확인해 고칩니다.

### migration 011 전에 bank 확인

공개 형식 `id`를 거절하는 것은 migration 011 후보 API부터입니다. 그 전의 API(migration 010)는 `id`가 유일하기만 하면 받았으므로, 지금 잘 쓰이는 bank라도 후보 API는 시작하지 않을 수 있습니다. API를 바꾼 뒤에야 알면 후보 API가 시작하지 않아 되돌릴 때까지 온라인 매치가 멈춥니다. 그러니 실제 bank를 후보 API의 loader로 읽어 보는 검사를 **migration 011보다 먼저**(`deploy/oracle/README.md` «Fail-closed staging order»의 3단계 전, 010 API가 그대로 도는 동안) 돌리고, exit status가 0이 아니면 배포를 멈춥니다.

```bash
docker compose … --profile migration run --build --rm --no-deps \
  -e QUESTION_BANK_DIR=/run/quiz-by-quiz/online-bank \
  --volume "<QUIZ_ONLINE_BANK_DIR의 경로>:/run/quiz-by-quiz/online-bank:ro" \
  quiz-by-quiz-migrate /app/.venv/bin/python -m app.release_check bank
```

- `docker compose …`는 platform base에 이 overlay를 함께 render한 것입니다. 3단계에서 쓸 `quiz-by-quiz-migrate` 이미지를 후보 소스로 빌드하고, 그 일회용 container에 bank만 read-only로 붙여 API가 시작할 때와 같은 loader(`QuestionCatalog.from_directory`)로 읽습니다. API를 띄우거나 DB에 붙지 않고, 출력에는 질문·보기·정답·해설이 없습니다.
- API service로 돌리려고 `quiz-by-quiz-api` 이미지를 미리 빌드하지 않습니다. 그 이미지가 바뀌면 다음 `docker compose up`이 migration 011 전에 010 API를 후보로 바꿀 수 있습니다. API 이미지는 4단계에서 빌드합니다.

공개 형식 `id`가 나오면 그대로 배포하지 않습니다. 번호를 바꾸는 것은 소유자 결정입니다.

- bank 파일이 바뀌므로 승인된 bank hash를 새로 받습니다(README «Fail-closed staging order» 1단계).
- 판은 문항을 `id`로만 남깁니다(`quiz_online.match_questions.question_id`, 판은 2시간 남습니다). 새 번호의 bank로 API를 바꾸면 그때 도는 판은 문항을 catalog에서 찾지 못해 더 진행하지 못하고, 끝난 판은 «문제 다시 보기»만 빠집니다(최종 순위는 남습니다). 도는 판이 없을 때 바꿉니다.
- 이미 받은 «이 문제 이상해요» 신고는 옛 번호를 가리킵니다. 옛 번호와 새 번호의 대응은 이 bank처럼 비공개로 남깁니다.

## 현재 상태

이 저장소에는 의도적으로 실제 online bank가 없습니다. 따라서 비공개·독립 문항 content를 provision하고 검증하기 전에는 공개 API 배포를 진행하면 안 됩니다.
