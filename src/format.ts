/** 원화·날짜 포맷터. 숫자는 전부 tabular-nums 로 그려서 자릿수가 흔들리지 않게 합니다. */

const KR = 'ko-KR';

export function num(n: number): string {
  return Math.round(n).toLocaleString(KR);
}

export function won(n: number): string {
  return `${num(n)}원`;
}

/** 부호를 앞에 붙입니다. 음수는 하이픈이 아니라 −(U+2212) 를 씁니다. */
export function signed(n: number): string {
  const r = Math.round(n);
  if (r === 0) return '0원';
  return `${r > 0 ? '+' : '−'}${num(Math.abs(r))}원`;
}

/** 칩 라벨용 축약 — 1,000,000 → 100만 */
export function short(n: number): string {
  if (n >= 100_000_000) {
    const eok = n / 100_000_000;
    return `${Number.isInteger(eok) ? eok : eok.toFixed(1)}억`;
  }
  if (n >= 10_000) {
    const man = n / 10_000;
    return `${Number.isInteger(man) ? num(man) : man.toFixed(1)}만`;
  }
  return num(n);
}

export function ym(d: Date): string {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function ymd(d: Date): string {
  return `${ym(d)}.${String(d.getDate()).padStart(2, '0')}`;
}

/** 개월 → "6년 11개월" */
export function months(n: number): string {
  const y = Math.floor(n / 12);
  const m = n % 12;
  if (y === 0) return `${m}개월`;
  if (m === 0) return `${y}년`;
  return `${y}년 ${m}개월`;
}

/** 소수 비율 → "0.986%" */
export function pct(r: number): string {
  return `${(r * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** 순이득 ÷ 넣는 돈 */
export function ratio(net: number, invested: number): string {
  if (invested <= 0) return '—';
  return `${(net / invested).toFixed(2)}배`;
}
