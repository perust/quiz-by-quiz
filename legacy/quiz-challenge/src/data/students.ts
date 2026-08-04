import { StudentProfile } from '../types';

export const students: StudentProfile[] = [
  {
    id: "김민준",
    name: "김민준",
    registeredAt: "2026.02.05 09:00",
    results: [
      {
        date: "2026.02.05 09:30",
        totalScore: 34,
        categoryScores: { "한국사": 9, "과학": 8, "지리": 9, "예술과문화": 8 },
        grade: { label: "A", emoji: "🌟", title: "박학다식", minScore: 32 },
      },
      {
        date: "2026.02.07 14:20",
        totalScore: 37,
        categoryScores: { "한국사": 10, "과학": 9, "지리": 9, "예술과문화": 9 },
        grade: { label: "A", emoji: "🌟", title: "박학다식", minScore: 32 },
      },
    ],
  },
  {
    id: "이서연",
    name: "이서연",
    registeredAt: "2026.02.05 09:00",
    results: [
      {
        date: "2026.02.05 10:00",
        totalScore: 28,
        categoryScores: { "한국사": 7, "과학": 6, "지리": 8, "예술과문화": 7 },
        grade: { label: "B", emoji: "📚", title: "준수함", minScore: 24 },
      },
    ],
  },
  {
    id: "박지호",
    name: "박지호",
    registeredAt: "2026.02.06 11:00",
    results: [
      {
        date: "2026.02.06 11:30",
        totalScore: 21,
        categoryScores: { "한국사": 5, "과학": 7, "지리": 4, "예술과문화": 5 },
        grade: { label: "C", emoji: "📖", title: "노력필요", minScore: 16 },
      },
    ],
  },
];
