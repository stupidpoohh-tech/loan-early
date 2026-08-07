import { describe, expect, it } from 'vitest';
import { months, num, short, signed } from './format';

describe('short — 접힌 요약 막대가 이 형식에 기대고 있습니다', () => {
  it('만 단위 미만은 그대로', () => {
    expect(short(123)).toBe('123');
    expect(short(9_999)).toBe('9,999');
  });

  it('만 단위, 100만 미만은 소수 한 자리', () => {
    expect(short(578_903)).toBe('57.9만');
    expect(short(50_000)).toBe('5만');
  });

  it('100만 이상은 만 단위 반올림 — 1862.8만 같은 표기를 막습니다', () => {
    expect(short(18_627_809)).toBe('1,863만');
    expect(short(30_000_000)).toBe('3,000만');
    expect(short(1_234_567)).toBe('123만');
  });

  it('억 단위', () => {
    expect(short(100_000_000)).toBe('1억');
    expect(short(120_000_000)).toBe('1.2억');
  });
});

describe('signed', () => {
  it('0은 부호 없이', () => {
    expect(signed(0)).toBe('0원');
  });

  it('음수는 하이픈이 아니라 U+2212', () => {
    expect(signed(-1_000)).toBe('−1,000원');
    expect(signed(1_000)).toBe('+1,000원');
  });
});

describe('months', () => {
  it('년·개월 조합', () => {
    expect(months(84)).toBe('7년');
    expect(months(64)).toBe('5년 4개월');
    expect(months(3)).toBe('3개월');
  });
});

describe('num', () => {
  it('천 단위 쉼표', () => {
    expect(num(1_234_567)).toBe('1,234,567');
  });
});
