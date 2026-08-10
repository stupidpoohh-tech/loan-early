/**
 * v2 화면 — 여기서부터 새로 짓습니다.
 *
 * 계산 엔진(loan.ts)과 포맷터(format.ts)는 완성돼 있고 테스트 60개가 지킵니다.
 * npm run build 는 타입 검사 → 테스트 → 번들 순서이므로, 엔진을 깨뜨리면
 * 어떤 화면을 만들든 배포가 막힙니다.
 *
 * 아래는 엔진이 연결돼 있음을 보여주는 스모크 렌더입니다. 지우고 시작하세요.
 */
import { analyze, type LoanConfig } from './loan';
import { won } from './format';

const example: LoanConfig = {
  balance: 30_000_000,
  rate: 15,
  payment: 578_903, // 84회에 딱 떨어지는 값 — 어중간한 마지막 회차가 안 생깁니다
  nextDate: '2026-09-25',
  nextNo: 1,
  feeRate: 1,
  feeMode: 'flat',
  openDate: '2025-08-25',
  maturity: '2033-08-25',
  feeYears: 3,
};

const a = analyze(example);
const app = document.querySelector('#app');
if (app) {
  app.textContent = `엔진 연결 확인 — 예시 대출 ${a.count}회, 남은 총이자 ${won(a.totalInterest)}`;
}
