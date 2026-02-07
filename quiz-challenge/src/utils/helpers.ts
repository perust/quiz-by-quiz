import { Category, Grade } from '../types';

// Fisher-Yates 셔플 알고리즘
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// 등급 정의
const grades: Grade[] = [
  { label: "S", emoji: "👑", title: "상식왕", minScore: 38 },
  { label: "A", emoji: "🌟", title: "박학다식", minScore: 32 },
  { label: "B", emoji: "📚", title: "준수함", minScore: 24 },
  { label: "C", emoji: "📖", title: "노력필요", minScore: 16 },
  { label: "D", emoji: "📝", title: "기초부터", minScore: 0 },
];

// 점수 → 등급 변환
export function getGrade(score: number): Grade {
  for (const grade of grades) {
    if (score >= grade.minScore) {
      return grade;
    }
  }
  return grades[grades.length - 1];
}

// 날짜 포맷팅
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}.${month}.${day} ${hours}:${minutes}`;
}

// 카테고리별 색상 반환
export function getCategoryColor(category: Category): string {
  const colors: Record<Category, string> = {
    "한국사": "#EF4444",
    "과학": "#3B82F6",
    "지리": "#22C55E",
    "예술과문화": "#A855F7",
  };
  return colors[category];
}

// 카테고리별 Tailwind 클래스 반환
export function getCategoryColorClass(category: Category): string {
  const classes: Record<Category, string> = {
    "한국사": "bg-red-500",
    "과학": "bg-blue-500",
    "지리": "bg-green-500",
    "예술과문화": "bg-purple-500",
  };
  return classes[category];
}

// 카테고리별 이모지 반환
export function getCategoryIcon(category: Category): string {
  const icons: Record<Category, string> = {
    "한국사": "🏛️",
    "과학": "🔬",
    "지리": "🌍",
    "예술과문화": "🎨",
  };
  return icons[category];
}

// 모든 카테고리 목록
export const allCategories: Category[] = ["한국사", "과학", "지리", "예술과문화"];
