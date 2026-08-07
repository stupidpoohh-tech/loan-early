import { describe, it, expect } from 'vitest';
import {
  addMonths,
  analyze,
  buildSchedule,
  daysBetween,
  feeRateAt,
  fitPayment,
  monthlyRate,
  parseDate,
  reducedPayment,
  simulate,
  type LoanConfig,
  type Method,
} from './loan';

/** 기준 대출 — 명세 §4 */
const cfg: LoanConfig = {
  balance: 29_809_726,
  rate: 17.5,
  payment: 621_780,
  nextDate: '2026-09-25',
  nextNo: 1,
  feeRate: 0.9855,
  feeMode: 'flat',
  // 개시일+3년(면제)이 픽스처의 상환일 범위(최대 2027-08-25) 밖에 있어야
  // 명세 픽스처가 뜻하는 "수수료가 붙는 상황" 이 유지됩니다.
  openDate: '2025-09-25',
  maturity: '2033-07-25',
  feeYears: 3,
};

const i = monthlyRate(cfg.rate);
const base = buildSchedule(cfg.balance, cfg.payment, i);
/** 지금 상환 케이스의 기준일을 고정합니다 */
const today = parseDate('2026-09-01');

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe('기준 스케줄', () => {
  it('회차 수 83', () => {
    expect(base.length).toBe(83);
  });

  it('총이자 21,777,067 · 총납입액 51,586,793', () => {
    expect(sum(base.map((r) => r.interest))).toBe(21_777_067);
    expect(sum(base.map((r) => r.due))).toBe(51_586_793);
  });

  it('마지막 회차 납입액 600,833', () => {
    expect(base[base.length - 1]!.due).toBe(600_833);
  });

  it('0번 행', () => {
    expect(base[0]).toEqual({
      index: 0,
      due: 621_780,
      interest: 434_725,
      principal: 187_055,
      balance: 29_622_671,
    });
  });

  it('원금 합계가 잔액과 같다', () => {
    expect(sum(base.map((r) => r.principal))).toBe(cfg.balance);
  });
});

describe('시나리오 픽스처', () => {
  interface Fixture {
    P: number;
    m: number;
    method: Method;
    recycle: boolean;
    count: number;
    reduced: number | null;
    drop: number | null;
    fee: number;
    less: number;
    net: number;
    breakeven: number;
  }

  const fixtures: Fixture[] = [
    { P: 100_000, m: 0, method: 'pay', recycle: false, count: 83, reduced: 619_564, drop: 2_216, fee: 985, less: 163_089, net: 62_104, breakeven: 45 },
    { P: 100_000, m: 0, method: 'term', recycle: false, count: 83, reduced: null, drop: null, fee: 985, less: 332_565, net: 231_580, breakeven: 82 },
    { P: 1_000_000, m: 0, method: 'pay', recycle: false, count: 83, reduced: 600_795, drop: 20_985, fee: 9_855, less: 1_720_839, net: 710_984, breakeven: 48 },
    { P: 1_000_000, m: 0, method: 'term', recycle: false, count: 78, reduced: null, drop: null, fee: 9_855, less: 3_223_489, net: 2_213_634, breakeven: 79 },
    { P: 1_000_000, m: 0, method: 'pay', recycle: true, count: 78, reduced: 600_795, drop: 20_985, fee: 25_986, less: 3_223_489, net: 2_197_503, breakeven: 79 },
    { P: 1_000_000, m: 6, method: 'pay', recycle: false, count: 77, reduced: 599_931, drop: 21_849, fee: 9_855, less: 1_661_522, net: 651_667, breakeven: 52 },
  ];

  for (const f of fixtures) {
    const label = `P=${f.P.toLocaleString()} m=${f.m} ${f.method}${f.recycle ? '+recycle' : ''}`;
    it(label, () => {
      const s = simulate(cfg, base, f.P, f.m, f.method, f.recycle, { today });
      expect(s.count).toBe(f.count);
      if (f.reduced !== null) expect(s.reduced).toBe(f.reduced);
      if (f.drop !== null) expect(s.drop).toBe(f.drop);
      expect(s.fee).toBe(f.fee);
      expect(s.less).toBe(f.less);
      expect(s.net).toBe(f.net);
      expect(s.breakeven).toBe(f.breakeven);
    });

    it(`${label} — 누적 손익의 마지막 원소가 net`, () => {
      const s = simulate(cfg, base, f.P, f.m, f.method, f.recycle, { today });
      expect(s.cum[s.cum.length - 1]).toBe(f.net);
    });
  }
});

describe('추가 성질', () => {
  // 이전에는 recycle=false 만 봤습니다. 'pay' + recycle 조합에서 reduced 가 0이라
  // 월 납입액 전체가 추가 상환으로 오인돼, 상환액이 0인데 수수료 486,279원이
  // 붙던 버그가 이 빈틈으로 빠져나갔습니다.
  it('P=0 이면 net=0, less=0 — 차액 재투입을 켜도, 지연을 줘도 마찬가지', () => {
    for (const method of ['pay', 'term'] as const) {
      for (const recycle of [false, true]) {
        for (const m of [0, 3]) {
          const s = simulate(cfg, base, 0, m, method, recycle, { today });
          const at = `${method}/recycle=${recycle}/m=${m}`;
          expect(s.less, at).toBe(0);
          expect(s.fee, at).toBe(0);
          expect(s.invested, at).toBe(0);
          expect(s.net, at).toBe(0);
          expect(s.feeEstimated, at).toBe(false);
        }
      }
    }
  });

  it('상환액이 있을 때는 차액 재투입 수수료가 정상적으로 가산된다', () => {
    const plain = simulate(cfg, base, 1_000_000, 0, 'pay', false, { today });
    const recycled = simulate(cfg, base, 1_000_000, 0, 'pay', true, { today });
    expect(plain.feeEstimated).toBe(false);
    expect(recycled.feeEstimated).toBe(true);
    expect(recycled.fee).toBeGreaterThan(plain.fee);
  });

  it('완납이면 재투입할 차액이 없어 추정 수수료가 붙지 않는다', () => {
    const s = simulate(cfg, base, cfg.balance, 0, 'pay', true, { today });
    expect(s.count).toBe(0);
    expect(s.feeEstimated).toBe(false);
    expect(s.fee).toBe(Math.floor(cfg.balance * (cfg.feeRate / 100)));
  });

  it("method='pay' 는 회차를 유지하고 납입액을 낮춘다", () => {
    const s = simulate(cfg, base, 1_000_000, 0, 'pay', false, { today });
    expect(s.count).toBe(base.length);
    expect(s.reduced).toBeLessThan(cfg.payment);
    // 새 스케줄의 납입액 합 = 기존 남은 납입액 합 − 덜 내는 돈
    expect(sum(s.rows.map((r) => r.due))).toBe(s.baseRest - s.less);
  });

  it("method='term' 은 납입액을 유지하고 회차를 줄인다", () => {
    const s = simulate(cfg, base, 1_000_000, 0, 'term', false, { today });
    expect(s.count).toBeLessThan(base.length);
    expect(s.monthsSaved).toBe(base.length - s.count);
    for (const r of s.rows.slice(0, -1)) expect(r.due).toBe(cfg.payment);
  });

  it('같은 금액이면 term 의 net 이 pay 보다 크다', () => {
    const pay = simulate(cfg, base, 1_000_000, 0, 'pay', false, { today });
    const term = simulate(cfg, base, 1_000_000, 0, 'term', false, { today });
    expect(term.net).toBeGreaterThan(pay.net);
  });

  it('지연이 커질수록 net 이 단조 감소한다 — 부과기간 안에서', () => {
    // 수수료가 일정한 구간의 성질입니다. 면제를 넘는 순간은 위 '미뤄 갚는 쪽이 이득' 이 다룹니다.
    for (const method of ['pay', 'term'] as const) {
      let prev = Infinity;
      for (let m = 0; m <= 12; m++) {
        const s = simulate(cfg, base, 1_000_000, m, method, false, { today });
        expect(s.net).toBeLessThan(prev);
        prev = s.net;
      }
    }
  });

  it('상환액이 클수록 net 이 단조 증가한다', () => {
    let prev = -Infinity;
    for (const P of [0, 100_000, 500_000, 1_000_000, 3_000_000, 5_000_000]) {
      const s = simulate(cfg, base, P, 0, 'term', false, { today });
      expect(s.net).toBeGreaterThan(prev);
      prev = s.net;
    }
  });

  it('본전 이전은 음수, 본전부터는 음수가 아니다', () => {
    const s = simulate(cfg, base, 1_000_000, 0, 'pay', false, { today });
    expect(s.breakeven).not.toBeNull();
    const b = s.breakeven!;
    expect(s.cum[b]!).toBeGreaterThanOrEqual(0);
    expect(s.cum[b - 1]!).toBeLessThan(0);
  });

  it('재산정 납입액은 올림이라 회차가 늘지 않는다', () => {
    // 내림이면 잔돈이 남아 rest 회를 넘어갑니다.
    for (const P of [50_000, 123_456, 777_777, 2_500_000, 9_999_999]) {
      const s = simulate(cfg, base, P, 0, 'pay', false, { today });
      expect(s.count).toBeLessThanOrEqual(base.length);
    }
  });
});

describe('엣지 케이스', () => {
  it('월 납입액이 한 달 이자보다 적으면 스케줄이 비고 안내가 뜬다', () => {
    const a = analyze({ ...cfg, payment: 400_000 });
    expect(a.problem).toBe('payment-too-small');
    expect(a.base).toEqual([]);
    expect(a.firstInterest).toBe(434_725);
  });

  it('잔액·이율·납입액이 0 또는 음수면 계산하지 않는다', () => {
    expect(analyze({ ...cfg, balance: 0 }).problem).toBe('invalid');
    expect(analyze({ ...cfg, rate: 0 }).problem).toBe('invalid');
    expect(analyze({ ...cfg, payment: -1 }).problem).toBe('invalid');
  });

  it('상환액이 잔액 이상이면 완납이고, 넘는 금액에는 수수료를 물리지 않는다', () => {
    const s = simulate(cfg, base, 99_999_999, 0, 'term', false, { today });
    expect(s.clamped).toBe(true);
    expect(s.amount).toBe(cfg.balance);
    expect(s.balanceAfter).toBe(0);
    expect(s.count).toBe(0);
    expect(s.fee).toBe(Math.floor(cfg.balance * (cfg.feeRate / 100)));
    expect(s.less).toBe(s.baseRest);
  });

  it('소액 term 상환은 회차가 안 줄고 마지막 회차 금액만 줄어든다', () => {
    const s = simulate(cfg, base, 100_000, 0, 'term', false, { today });
    expect(s.monthsSaved).toBe(0);
    expect(s.rows[s.rows.length - 1]!.due).toBeLessThan(base[base.length - 1]!.due);
  });

  it('지연 회차가 잔액을 넘어도 무너지지 않는다', () => {
    const s = simulate(cfg, base, 1_000_000, 999, 'pay', false, { today });
    expect(s.delayMonths).toBe(base.length - 1);
    expect(Number.isFinite(s.net)).toBe(true);
  });

  it('최대 지연은 min(12, 회차-2)', () => {
    expect(analyze(cfg).maxDelay).toBe(12);
    expect(analyze({ ...cfg, balance: 2_000_000 }).maxDelay).toBe(2);
  });
});

describe('날짜', () => {
  it('31일은 짧은 달에서 말일로 보정된다', () => {
    expect(addMonths(parseDate('2026-01-31'), 1).getDate()).toBe(28);
    expect(addMonths(parseDate('2026-01-31'), 3).getDate()).toBe(30);
    expect(addMonths(parseDate('2026-01-31'), 2).getDate()).toBe(31);
  });

  it('보정 후 다음 달로 넘어가도 원래 일자를 되찾는다', () => {
    // 누적 addMonths 가 아니라 항상 기준일에서 k 개월을 더하기 때문입니다.
    const d0 = parseDate('2026-01-31');
    expect(addMonths(d0, 13).getDate()).toBe(28);
    expect(addMonths(d0, 12).getDate()).toBe(31);
  });

  it('로컬 타임존 기준이라 하루가 밀리지 않는다', () => {
    const d = parseDate('2026-03-01');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(1);
  });

  it('daysBetween 은 일수 차이', () => {
    expect(daysBetween(parseDate('2026-01-01'), parseDate('2026-01-31'))).toBe(30);
    expect(daysBetween(parseDate('2026-01-31'), parseDate('2026-01-01'))).toBe(-30);
  });
});

describe('수수료', () => {
  // 면제 시점(2027-01-25)이 시험 날짜들과 맞물리도록 개시일을 고정합니다
  const pro: LoanConfig = { ...cfg, feeMode: 'prorata', feeRate: 1.2, feeYears: 3, openDate: '2024-01-25' };

  it('flat 은 부과기간 안에서는 상환일과 무관하게 같다', () => {
    expect(feeRateAt(parseDate('2026-01-01'), cfg)).toBeCloseTo(0.009855, 12);
    expect(feeRateAt(parseDate('2028-01-01'), cfg)).toBeCloseTo(0.009855, 12);
  });

  it('부과기간이 지나면 flat 도 면제된다 — 딱 3년 되는 날부터', () => {
    // 개시일 2025-09-25 + 3년 = 2028-09-25
    expect(feeRateAt(parseDate('2028-09-24'), cfg)).toBeCloseTo(0.009855, 12);
    expect(feeRateAt(parseDate('2028-09-25'), cfg)).toBe(0);
  });

  it('부과기간이 0이면 flat 도 무기한', () => {
    expect(feeRateAt(parseDate('2035-01-01'), { ...cfg, feeYears: 0 })).toBeCloseTo(0.009855, 12);
  });

  it('면제가 코앞인 저금리 대출은 미뤄 갚는 쪽이 이득', () => {
    // 금리가 낮으면 몇 달치 이자 손해 < 수수료 절약 이 성립합니다.
    // 이 역전이 '언제 갚을까' 축이 존재하는 이유입니다.
    const low: LoanConfig = { ...cfg, rate: 3.5, feeRate: 1.4, openDate: '2023-11-25' }; // 면제 2026-11-25
    const b = buildSchedule(low.balance, low.payment, monthlyRate(low.rate));
    const now = simulate(low, b, 10_000_000, 0, 'term', false, { today });
    const wait = simulate(low, b, 10_000_000, 3, 'term', false, { today }); // 상환일 2026-11-25
    expect(now.fee).toBe(140_000);
    expect(wait.fee).toBe(0);
    expect(wait.net).toBeGreaterThan(now.net);
  });

  it('prorata 는 만기가 가까울수록 낮아진다', () => {
    const early = feeRateAt(parseDate('2024-07-25'), pro);
    const late = feeRateAt(parseDate('2026-07-25'), pro);
    expect(early).toBeGreaterThan(late);
    expect(late).toBeGreaterThan(0);
  });

  it('부과기간이 지나면 0', () => {
    // 개시일 2024-01-25 + 3년 = 2027-01-25
    expect(feeRateAt(parseDate('2027-01-24'), pro)).toBeGreaterThan(0);
    expect(feeRateAt(parseDate('2027-01-25'), pro)).toBe(0);
    expect(feeRateAt(parseDate('2028-01-01'), pro)).toBe(0);
  });

  it('부과기간이 0이면 무기한', () => {
    const forever = { ...pro, feeYears: 0 };
    expect(feeRateAt(parseDate('2030-01-01'), forever)).toBeGreaterThan(0);
  });

  it('개시일과 만기가 뒤집혀도 flat 으로 떨어진다', () => {
    const broken = { ...pro, openDate: '2033-07-25', maturity: '2024-01-25' };
    expect(feeRateAt(parseDate('2026-01-01'), broken)).toBeCloseTo(0.012, 12);
  });

  it('prorata 에서 수수료가 0이면 net 이 그만큼 커진다', () => {
    const b = buildSchedule(pro.balance, pro.payment, monthlyRate(pro.rate));
    const dur = simulate(pro, b, 1_000_000, 0, 'term', false, { today: parseDate('2026-01-01') });
    const after = simulate(pro, b, 1_000_000, 0, 'term', false, { today: parseDate('2028-01-01') });
    expect(dur.fee).toBeGreaterThan(0);
    expect(after.fee).toBe(0);
    expect(after.net).toBe(dur.net + dur.fee);
  });
});

describe('fitPayment', () => {
  it('닫힌 식이 회차를 넘기는 경우를 바로잡는다', () => {
    // 이자 반올림이 회차마다 쌓이면 마지막에 몇 원이 남아 한 회차가 더 붙습니다.
    const r = monthlyRate(15);
    const closed = reducedPayment(29_809_726, 36, r);
    expect(buildSchedule(29_809_726, closed, r).length).toBe(37);

    const fitted = fitPayment(29_809_726, 36, r);
    expect(buildSchedule(29_809_726, fitted, r).length).toBe(36);
    expect(fitted).toBeGreaterThan(closed);
    // 몇 원 차이일 뿐이어야 합니다
    expect(fitted - closed).toBeLessThan(10);
  });

  it('상한을 넘지 않는다', () => {
    expect(fitPayment(30_000_000, 84, monthlyRate(15), 500_000)).toBe(500_000);
  });

  it('여러 조합에서 회차가 정확히 맞는다', () => {
    for (const balance of [10_000_000, 30_000_000, 29_809_726, 12_345_678]) {
      for (const rate of [3, 5, 7.5, 10, 15, 17.5, 24]) {
        for (const n of [12, 24, 36, 60, 84, 120]) {
          const r = monthlyRate(rate);
          expect(buildSchedule(balance, fitPayment(balance, n, r), r).length).toBe(n);
        }
      }
    }
  });
});

describe('reducedPayment', () => {
  it('원금이 그대로면 원래 납입액과 거의 같다', () => {
    const p = reducedPayment(cfg.balance, base.length, i);
    expect(Math.abs(p - cfg.payment)).toBeLessThan(cfg.payment * 0.01);
  });

  it('무이자면 원금을 회차로 나눈 값', () => {
    expect(reducedPayment(1_200_000, 12, 0)).toBe(100_000);
  });

  it('잘못된 입력은 0', () => {
    expect(reducedPayment(0, 12, i)).toBe(0);
    expect(reducedPayment(1_000_000, 0, i)).toBe(0);
  });
});
