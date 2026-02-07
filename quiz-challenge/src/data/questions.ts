import { Question } from '../types';

export const questions: Question[] = [
  // ========================================
  // 한국사 (10문제: 쉬움 3, 보통 4, 어려움 3)
  // ========================================
  {
    id: 1,
    category: "한국사",
    difficulty: "쉬움",
    question: "한글을 창제한 조선의 왕은 누구인가요?",
    options: ["태조", "영조", "성종", "세종대왕"],
    answer: 3,
    explanation: "세종대왕은 1443년 훈민정음(한글)을 창제하여 백성들이 쉽게 글을 읽고 쓸 수 있도록 했습니다."
  },
  {
    id: 2,
    category: "한국사",
    difficulty: "쉬움",
    question: "고구려, 백제, 신라가 존재했던 시대를 무엇이라고 하나요?",
    options: ["통일신라시대", "삼국시대", "고려시대", "조선시대"],
    answer: 1,
    explanation: "삼국시대는 고구려, 백제, 신라가 한반도에서 서로 경쟁하던 시기(기원전 57년~668년)를 말합니다."
  },
  {
    id: 3,
    category: "한국사",
    difficulty: "쉬움",
    question: "대한민국의 광복절은 몇 월 며칠인가요?",
    options: ["3월 1일", "6월 6일", "8월 15일", "10월 3일"],
    answer: 2,
    explanation: "8월 15일 광복절은 1945년 일본으로부터 해방된 날을 기념하는 국경일입니다."
  },
  {
    id: 4,
    category: "한국사",
    difficulty: "보통",
    question: "임진왜란이 발생한 연도는?",
    options: ["1392년", "1592년", "1636년", "1894년"],
    answer: 1,
    explanation: "임진왜란은 1592년 일본의 도요토미 히데요시가 조선을 침략하면서 시작되었습니다."
  },
  {
    id: 5,
    category: "한국사",
    difficulty: "보통",
    question: "고려를 건국한 인물은 누구인가요?",
    options: ["왕건", "이성계", "견훤", "궁예"],
    answer: 0,
    explanation: "왕건은 918년 고려를 건국하고 936년 후삼국을 통일한 고려의 초대 왕입니다."
  },
  {
    id: 6,
    category: "한국사",
    difficulty: "보통",
    question: "조선시대 과거시험 중 문과에 합격한 사람을 무엇이라 불렀나요?",
    options: ["무관", "문관", "급제자", "선비"],
    answer: 2,
    explanation: "과거시험에 합격한 사람을 급제자라고 불렀으며, 문과 급제는 관직 진출의 주요 통로였습니다."
  },
  {
    id: 7,
    category: "한국사",
    difficulty: "보통",
    question: "3·1 운동이 일어난 연도는?",
    options: ["1919년", "1910년", "1945년", "1948년"],
    answer: 0,
    explanation: "3·1 운동은 1919년 3월 1일 일제 강점기에 한국인들이 독립을 외친 대규모 만세 운동입니다."
  },
  {
    id: 8,
    category: "한국사",
    difficulty: "어려움",
    question: "신라의 삼국통일이 완성된 해는?",
    options: ["660년", "668년", "676년", "698년"],
    answer: 2,
    explanation: "신라는 676년 나당전쟁에서 당나라를 물리치고 대동강 이남의 삼국통일을 완성했습니다."
  },
  {
    id: 9,
    category: "한국사",
    difficulty: "어려움",
    question: "흥선대원군이 실시한 정책이 아닌 것은?",
    options: ["서원 철폐", "경복궁 중건", "호포제 실시", "갑오개혁"],
    answer: 3,
    explanation: "갑오개혁은 1894년 김홍집 내각에서 실시한 개혁으로, 흥선대원군의 정책이 아닙니다."
  },
  {
    id: 10,
    category: "한국사",
    difficulty: "어려움",
    question: "발해를 건국한 인물은 누구인가요?",
    options: ["대조영", "왕건", "장보고", "을지문덕"],
    answer: 0,
    explanation: "대조영은 698년 고구려 유민을 이끌고 발해를 건국하여 '해동성국'이라 불리는 나라를 세웠습니다."
  },

  // ========================================
  // 과학 (10문제: 쉬움 3, 보통 4, 어려움 3)
  // ========================================
  {
    id: 11,
    category: "과학",
    difficulty: "쉬움",
    question: "물의 화학식은 무엇인가요?",
    options: ["CO2", "H2O", "O2", "NaCl"],
    answer: 1,
    explanation: "물의 화학식 H2O는 수소(H) 2개와 산소(O) 1개가 결합한 분자를 나타냅니다."
  },
  {
    id: 12,
    category: "과학",
    difficulty: "쉬움",
    question: "지구에서 가장 가까운 항성은?",
    options: ["달", "화성", "태양", "북극성"],
    answer: 2,
    explanation: "태양은 지구에서 약 1억 5천만 km 떨어진 가장 가까운 항성입니다."
  },
  {
    id: 13,
    category: "과학",
    difficulty: "쉬움",
    question: "인간의 정상 체온은 약 몇 도인가요?",
    options: ["35°C", "40°C", "38°C", "36.5°C"],
    answer: 3,
    explanation: "인간의 정상 체온은 약 36.5°C이며, 이를 벗어나면 발열이나 저체온 상태로 봅니다."
  },
  {
    id: 14,
    category: "과학",
    difficulty: "보통",
    question: "원소 주기율표에서 'Fe'는 어떤 원소를 나타내나요?",
    options: ["플루오린", "철", "납", "프랑슘"],
    answer: 1,
    explanation: "Fe는 라틴어 Ferrum에서 유래한 철(Iron)의 원소 기호입니다."
  },
  {
    id: 15,
    category: "과학",
    difficulty: "보통",
    question: "광합성에서 식물이 흡수하는 기체는?",
    options: ["산소", "질소", "이산화탄소", "수소"],
    answer: 2,
    explanation: "식물은 광합성 과정에서 이산화탄소(CO2)를 흡수하고 산소(O2)를 방출합니다."
  },
  {
    id: 16,
    category: "과학",
    difficulty: "보통",
    question: "뉴턴의 운동 법칙 중 '관성의 법칙'은 제 몇 법칙인가요?",
    options: ["제1법칙", "제2법칙", "제3법칙", "제4법칙"],
    answer: 0,
    explanation: "제1법칙(관성의 법칙)은 외력이 작용하지 않으면 물체가 현재 상태를 유지한다는 법칙입니다."
  },
  {
    id: 17,
    category: "과학",
    difficulty: "보통",
    question: "인체에서 면적 기준으로 가장 큰 장기는?",
    options: ["심장", "폐", "간", "피부"],
    answer: 3,
    explanation: "피부는 성인 기준 약 1.5~2㎡의 면적을 가진 인체에서 면적 기준 가장 큰 장기입니다."
  },
  {
    id: 18,
    category: "과학",
    difficulty: "어려움",
    question: "DNA의 이중나선 구조를 발견한 과학자는?",
    options: ["왓슨과 크릭", "멘델", "다윈", "파스퇴르"],
    answer: 0,
    explanation: "제임스 왓슨과 프랜시스 크릭은 1953년 DNA의 이중나선 구조를 발견했습니다."
  },
  {
    id: 19,
    category: "과학",
    difficulty: "어려움",
    question: "절대영도는 섭씨 몇 도인가요?",
    options: ["-100°C", "-173°C", "-273°C", "-373°C"],
    answer: 2,
    explanation: "절대영도는 -273.15°C(0K)로, 이론상 도달 가능한 가장 낮은 온도입니다."
  },
  {
    id: 20,
    category: "과학",
    difficulty: "어려움",
    question: "빛의 속도는 초당 약 몇 km인가요?",
    options: ["약 30만 km", "약 100만 km", "약 300만 km", "약 1000만 km"],
    answer: 0,
    explanation: "빛의 속도는 진공에서 초당 약 299,792km(약 30만 km)입니다."
  },

  // ========================================
  // 지리 (10문제: 쉬움 3, 보통 4, 어려움 3)
  // ========================================
  {
    id: 21,
    category: "지리",
    difficulty: "쉬움",
    question: "대한민국의 수도는 어디인가요?",
    options: ["부산", "인천", "대구", "서울"],
    answer: 3,
    explanation: "서울은 대한민국의 수도이자 약 1천만 명이 거주하는 인구 기준 최대 도시입니다."
  },
  {
    id: 22,
    category: "지리",
    difficulty: "쉬움",
    question: "면적 기준으로 세계에서 가장 넓은 대륙은?",
    options: ["아시아", "북아메리카", "아프리카", "유럽"],
    answer: 0,
    explanation: "아시아는 약 4,458만 ㎢로 면적 기준 세계에서 가장 넓은 대륙이며, 세계 인구의 60%가 거주합니다."
  },
  {
    id: 23,
    category: "지리",
    difficulty: "쉬움",
    question: "일본의 수도는 어디인가요?",
    options: ["오사카", "교토", "도쿄", "후쿠오카"],
    answer: 2,
    explanation: "도쿄는 일본의 수도이자 인구 기준 세계 최대 규모의 도시권 중 하나입니다."
  },
  {
    id: 24,
    category: "지리",
    difficulty: "보통",
    question: "본류 길이 기준으로 한국에서 가장 긴 강은?",
    options: ["낙동강", "한강", "금강", "영산강"],
    answer: 0,
    explanation: "낙동강은 본류 길이 약 510km로 한국에서 가장 긴 강이며, 영남 지방을 관통합니다."
  },
  {
    id: 25,
    category: "지리",
    difficulty: "보통",
    question: "해발 고도 기준으로 세계에서 가장 높은 산은?",
    options: ["K2", "에베레스트", "킬리만자로", "몽블랑"],
    answer: 1,
    explanation: "에베레스트 산은 해발 8,848.86m로 히말라야 산맥에 위치한 세계 최고봉입니다."
  },
  {
    id: 26,
    category: "지리",
    difficulty: "보통",
    question: "호주의 수도는 어디인가요?",
    options: ["시드니", "멜버른", "캔버라", "브리즈번"],
    answer: 2,
    explanation: "캔버라는 호주의 수도로, 시드니와 멜버른 사이에 위치한 계획도시입니다."
  },
  {
    id: 27,
    category: "지리",
    difficulty: "보통",
    question: "아마존 강은 어느 대륙에 있나요?",
    options: ["아프리카", "아시아", "북아메리카", "남아메리카"],
    answer: 3,
    explanation: "아마존 강은 남아메리카 브라질을 중심으로 흐르는 세계 최대 유역 면적의 강입니다."
  },
  {
    id: 28,
    category: "지리",
    difficulty: "어려움",
    question: "터키의 수도는 어디인가요?",
    options: ["이스탄불", "앙카라", "이즈미르", "안탈리아"],
    answer: 1,
    explanation: "앙카라는 1923년부터 터키의 수도입니다. 이스탄불이 최대 도시이지만 수도는 앙카라입니다."
  },
  {
    id: 29,
    category: "지리",
    difficulty: "어려움",
    question: "최대 수심 기준으로 세계에서 가장 깊은 호수는?",
    options: ["카스피해", "빅토리아 호수", "바이칼 호수", "슈피리어 호수"],
    answer: 2,
    explanation: "바이칼 호수는 최대 수심 1,642m로 세계에서 가장 깊은 담수호입니다."
  },
  {
    id: 30,
    category: "지리",
    difficulty: "어려움",
    question: "한국의 독도는 어느 바다에 위치하나요?",
    options: ["황해", "동해", "남해", "동중국해"],
    answer: 1,
    explanation: "독도는 동해에 위치한 대한민국 최동단의 섬으로, 울릉도에서 동남쪽으로 약 87km 떨어져 있습니다."
  },

  // ========================================
  // 예술과문화 (10문제: 쉬움 3, 보통 4, 어려움 3)
  // ========================================
  {
    id: 31,
    category: "예술과문화",
    difficulty: "쉬움",
    question: "'모나리자'를 그린 화가는 누구인가요?",
    options: ["레오나르도 다 빈치", "미켈란젤로", "라파엘로", "피카소"],
    answer: 0,
    explanation: "레오나르도 다 빈치는 16세기 초 모나리자를 그렸으며, 현재 루브르 박물관에 전시되어 있습니다."
  },
  {
    id: 32,
    category: "예술과문화",
    difficulty: "쉬움",
    question: "'운명 교향곡'으로 알려진 곡의 작곡가는?",
    options: ["모차르트", "베토벤", "바흐", "슈베르트"],
    answer: 1,
    explanation: "베토벤의 교향곡 제5번은 '운명 교향곡'이라 불리며, 유명한 '다다다단' 동기로 시작합니다."
  },
  {
    id: 33,
    category: "예술과문화",
    difficulty: "쉬움",
    question: "셰익스피어의 4대 비극에 포함되지 않는 것은?",
    options: ["햄릿", "맥베스", "오셀로", "로미오와 줄리엣"],
    answer: 3,
    explanation: "셰익스피어의 4대 비극은 햄릿, 맥베스, 오셀로, 리어왕이며, 로미오와 줄리엣은 별도의 비극입니다."
  },
  {
    id: 34,
    category: "예술과문화",
    difficulty: "보통",
    question: "'별이 빛나는 밤'을 그린 화가는?",
    options: ["클로드 모네", "에드가 드가", "폴 고갱", "빈센트 반 고흐"],
    answer: 3,
    explanation: "빈센트 반 고흐는 1889년 생레미 정신병원에서 '별이 빛나는 밤'을 그렸습니다."
  },
  {
    id: 35,
    category: "예술과문화",
    difficulty: "보통",
    question: "한국의 전통 음악 '판소리'에서 고수가 연주하는 주된 반주 악기는?",
    options: ["가야금", "거문고", "북", "해금"],
    answer: 2,
    explanation: "판소리는 소리꾼과 북을 치는 고수가 함께 공연하며, 전통적으로 북은 장단을 맞추는 유일한 반주 악기입니다."
  },
  {
    id: 36,
    category: "예술과문화",
    difficulty: "보통",
    question: "'어린 왕자'를 쓴 작가는 누구인가요?",
    options: ["빅토르 위고", "앙투안 드 생텍쥐페리", "알베르 카뮈", "에밀 졸라"],
    answer: 1,
    explanation: "앙투안 드 생텍쥐페리는 1943년 '어린 왕자'를 출간했으며, 이 책은 세계에서 가장 많이 번역된 프랑스 소설 중 하나입니다."
  },
  {
    id: 37,
    category: "예술과문화",
    difficulty: "보통",
    question: "영화 '기생충'의 감독은 누구인가요?",
    options: ["박찬욱", "봉준호", "김기덕", "이창동"],
    answer: 1,
    explanation: "봉준호 감독의 '기생충'은 2020년 아카데미 시상식에서 작품상을 포함한 4관왕을 차지했습니다."
  },
  {
    id: 38,
    category: "예술과문화",
    difficulty: "어려움",
    question: "인상주의 음악의 대표적인 작곡가는?",
    options: ["드뷔시", "차이콥스키", "브람스", "쇼팽"],
    answer: 0,
    explanation: "클로드 드뷔시는 '달빛', '바다' 등으로 유명한 프랑스 인상주의 음악의 대표 작곡가입니다."
  },
  {
    id: 39,
    category: "예술과문화",
    difficulty: "어려움",
    question: "'게르니카'를 그린 화가와 관련된 미술 사조는?",
    options: ["인상주의", "낭만주의", "사실주의", "입체주의"],
    answer: 3,
    explanation: "피카소의 게르니카는 입체주의 화풍으로 스페인 내전의 비극을 표현한 대작입니다."
  },
  {
    id: 40,
    category: "예술과문화",
    difficulty: "어려움",
    question: "피카소가 공동 창시한 20세기 미술 사조는?",
    options: ["인상주의", "초현실주의", "입체주의", "표현주의"],
    answer: 2,
    explanation: "피카소는 조르주 브라크와 함께 1907년경 입체주의(큐비즘)를 창시했습니다."
  },
];

// 카테고리별 문제 필터링 함수
export function getQuestionsByCategory(category: string): Question[] {
  return questions.filter(q => q.category === category);
}

// 난이도별 문제 필터링 함수
export function getQuestionsByDifficulty(difficulty: string): Question[] {
  return questions.filter(q => q.difficulty === difficulty);
}
