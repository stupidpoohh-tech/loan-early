/**
 * 조기상환 계산 엔진.
 *
 * 이 파일은 DOM 을 참조하지 않습니다. 순수 함수만 두고, 화면은 main.ts 가 맡습니다.
 * 계산이 틀리면 제품이 무의미하므로 모든 규칙은 loan.test.ts 의 픽스처로 고정합니다.
 *
 * 반올림 규칙 (픽스처가 요구하는 대로):
 *   - 이자는 원 단위 반올림          round(잔액 × 월이율)
 *   - 중도상환수수료는 원 미만 절사   floor(상환원금 × 수수료율)
 *     실제로 청구되는 금액이라 금융사 관행대로 절사합니다.
 *   - 차액 재상환분 수수료는 반올림   round(...)
 *     매달 같은 금액을 넣는다는 가정 위의 추정치라 절사할 실물이 없습니다.
 *   - 재산정 납입액은 원 단위 올림    ceil(...)  ← 내림하면 만기가 밀립니다
 */

export type FeeMode = 'flat' | 'prorata';
export type Method = 'term' | 'pay';

export interface LoanConfig {
  /** 남은 원금 (원, 정수) */
  balance: number;
  /** 연 이율 (%, 예: 17.5) */
  rate: number;
  /** 월 납입액 (원, 정수) */
  payment: number;
  /** 다음 납입일 'YYYY-MM-DD' */
  nextDate: string;
  /** 다음 회차 번호 (표시용) */
  nextNo: number;
  /** 중도상환수수료율 (%, 예: 1.0) */
  feeRate: number;
  feeMode: FeeMode;
  /** 대출개시일 — prorata 일 때만 사용 */
  openDate: string;
  /** 만기일 — prorata 일 때만 사용 */
  maturity: string;
  /** 수수료 부과기간(년). 0이면 무기한 */
  feeYears: number;
}

export interface Row {
  /** 0부터 */
  index: number;
  due: number;
  interest: number;
  principal: number;
  /** 납입 후 잔액 */
  balance: number;
}

/** 스케줄을 못 만드는 이유. 'ok' 가 아니면 결과 영역을 비웁니다. */
export type Problem = 'ok' | 'invalid' | 'payment-too-small';

export interface Analysis {
  problem: Problem;
  base: Row[];
  count: number;
  totalInterest: number;
  totalPaid: number;
  /** 첫 달 이자 — 'payment-too-small' 안내에 씁니다 */
  firstInterest: number;
  maturityDate: Date | null;
  maxDelay: number;
}

export interface Scenario {
  /** 실제로 상환에 쓰인 원금. 남은 잔액을 넘겨 입력하면 잔액으로 잘립니다 */
  amount: number;
  /** 입력값이 잔액을 넘어 잘렸는가 */
  clamped: boolean;
  delayMonths: number;
  method: Method;
  recycle: boolean;
  /** 상환 시점의 잔액 */
  balanceAt: number;
  /** 상환 직후 잔액 */
  balanceAfter: number;
  /** 상환 후 남는 회차 */
  rows: Row[];
  count: number;
  /** 재산정 납입액 (해당 없으면 0) */
  reduced: number;
  /** 월 인하폭 */
  drop: number;
  feeRate: number;
  fee: number;
  /** recycle 수수료는 추정치입니다 */
  feeEstimated: boolean;
  /** 앞으로 덜 내는 총액 */
  less: number;
  /** 넣는 돈 = 상환원금 + 수수료 */
  invested: number;
  /** 순이득 — 이 제품의 유일한 1차 지표 */
  net: number;
  /** 줄어드는 회차 수 */
  monthsSaved: number;
  /** 상환하지 않았을 때 앞으로 낼 총액 */
  baseRest: number;
  /** 상환 후 앞으로 낼 이자 */
  restInterest: number;
  repayDate: Date;
  cum: number[];
  /** 누적 손익이 0 이상이 되는 첫 인덱스 (0부터). 없으면 null */
  breakeven: number | null;
}

/** 연 이율(%) → 월 이율 */
export function monthlyRate(rate: number): number {
  return rate / 100 / 12;
}

/**
 * 원리금균등 상환 스케줄.
 * 720 상한은 무한 루프 방지용입니다.
 */
export function buildSchedule(balance: number, payment: number, i: number): Row[] {
  const rows: Row[] = [];
  if (!(balance > 0) || !(payment > 0)) return rows;
  let b = balance;
  while (b > 0.5 && rows.length < 720) {
    const interest = Math.round(b * i);
    let principal = payment - interest;
    if (principal <= 0) return rows; // 원금이 줄지 않음 → 중단
    if (principal > b) principal = b; // 마지막 회차
    b -= principal;
    rows.push({ index: rows.length, due: principal + interest, interest, principal, balance: b });
  }
  return rows;
}

/**
 * 남은 회차를 그대로 두고 원금만 줄었을 때의 새 납입액.
 * 반드시 올림입니다. 내림하면 스케줄이 rest 회를 넘어가 만기가 밀립니다.
 */
export function reducedPayment(B1: number, rest: number, i: number): number {
  if (!(B1 > 0) || !(rest > 0)) return 0;
  if (i === 0) return Math.ceil(B1 / rest);
  return Math.ceil((B1 * i) / (1 - Math.pow(1 + i, -rest)));
}

/**
 * 실제로 쓸 수 있는 재산정 납입액.
 *
 * 닫힌 식(reducedPayment)은 이자를 원 단위로 반올림하지 않는다고 보고 계산합니다.
 * 반올림이 회차마다 쌓이면 마지막에 몇 원이 남아 회차가 하나 더 생기는데,
 * 3원을 받으려고 한 달을 더 끄는 스케줄은 실제로 존재하지 않습니다.
 * 그래서 rest 회 안에 끝나는 최소 납입액까지 1원씩 올립니다.
 *
 * @param cap 납입액 상한. 재산정이 오히려 납입액을 올리는 일은 없어야 합니다.
 */
export function fitPayment(B1: number, rest: number, i: number, cap = Infinity): number {
  let p = reducedPayment(B1, rest, i);
  if (p <= 0) return 0;
  // 누적 반올림 오차는 회차당 0.5원 이하라 1~2원이면 충분합니다. 64는 넉넉한 상한입니다.
  for (let k = 0; k < 64 && buildSchedule(B1, p, i).length > rest; k++) p += 1;
  return Math.min(p, cap);
}

/** 'YYYY-MM-DD' → 로컬 타임존 Date. UTC 변환을 섞으면 하루씩 밀립니다. */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function toISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 31일 → 짧은 달 보정 */
export function addMonths(d: Date, n: number): Date {
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(d.getDate(), last));
  return t;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function dateOfInstallment(cfg: LoanConfig, k: number): Date {
  return addMonths(parseDate(cfg.nextDate), k);
}

/** 상환일 기준 실제 수수료율 (소수 비율, 예: 0.009855) */
export function feeRateAt(repayDate: Date, cfg: LoanConfig): number {
  const flat = cfg.feeRate / 100;
  if (cfg.feeMode === 'flat') return flat;

  const open = parseDate(cfg.openDate);
  const maturity = parseDate(cfg.maturity);
  const total = daysBetween(open, maturity);
  if (total <= 0) return flat;

  if (cfg.feeYears > 0 && repayDate.getTime() >= addMonths(open, Math.round(cfg.feeYears * 12)).getTime()) {
    return 0; // 부과기간 경과
  }
  return (flat * Math.max(0, daysBetween(repayDate, maturity))) / total;
}

/** 입력 검증 + 기준 스케줄 */
export function analyze(cfg: LoanConfig): Analysis {
  const empty: Analysis = {
    problem: 'invalid',
    base: [],
    count: 0,
    totalInterest: 0,
    totalPaid: 0,
    firstInterest: 0,
    maturityDate: null,
    maxDelay: 0,
  };
  if (!(cfg.balance > 0) || !(cfg.rate > 0) || !(cfg.payment > 0)) return empty;

  const i = monthlyRate(cfg.rate);
  const base = buildSchedule(cfg.balance, cfg.payment, i);
  const firstInterest = Math.round(cfg.balance * i);
  if (base.length === 0) {
    return { ...empty, problem: 'payment-too-small', firstInterest };
  }

  let totalInterest = 0;
  let totalPaid = 0;
  for (const r of base) {
    totalInterest += r.interest;
    totalPaid += r.due;
  }
  return {
    problem: 'ok',
    base,
    count: base.length,
    totalInterest,
    totalPaid,
    firstInterest,
    maturityDate: dateOfInstallment(cfg, base.length - 1),
    maxDelay: Math.max(0, Math.min(12, base.length - 2)),
  };
}

export interface SimulateOptions {
  /** 지금 상환할 때의 기준일. 테스트에서 고정하기 위해 주입합니다 */
  today?: Date;
}

/**
 * 핵심 함수.
 * @param amount 상환할 원금
 * @param delayMonths 지연 개월 수 (0이면 지금)
 * @param recycle 줄어든 차액을 매달 다시 원금으로 넣는가
 */
export function simulate(
  cfg: LoanConfig,
  base: Row[],
  amount: number,
  delayMonths: number,
  method: Method,
  recycle: boolean,
  opts: SimulateOptions = {},
): Scenario {
  const i = monthlyRate(cfg.rate);
  const N0 = base.length;
  const m = Math.max(0, Math.min(Math.round(delayMonths), Math.max(0, N0 - 1)));

  const prev = m === 0 ? undefined : base[m - 1];
  const balanceAt = m === 0 ? cfg.balance : (prev?.balance ?? 0);
  const rest = N0 - m;

  // 잔액보다 많이 넣어도 잔액까지만 씁니다. 넘는 돈에 수수료를 물릴 이유가 없습니다.
  const P = Math.max(0, Math.min(amount, balanceAt));
  const clamped = amount > balanceAt;

  const B1 = Math.max(0, balanceAt - P);

  // P 가 0이면 재산정할 것이 없습니다. 여기서 닫힌 식을 쓰면
  // 원래 납입액과 몇 원 차이가 나서 "아무것도 안 했는데 손익이 생기는" 결과가 됩니다.
  const reduced = P > 0 && B1 > 0 && rest > 0 ? fitPayment(B1, rest, i, cfg.payment) : 0;

  // 'pay' 는 회차를 유지하고 납입액을 낮춥니다.
  // 'term' 과 'pay + recycle' 은 납입액을 그대로 두므로 회차가 줄어듭니다.
  const rows =
    method === 'pay' && !recycle && reduced > 0
      ? buildSchedule(B1, reduced, i)
      : buildSchedule(B1, cfg.payment, i);

  let baseRest = 0;
  for (let j = m; j < N0; j++) baseRest += base[j]?.due ?? 0;

  let newTotal = 0;
  let restInterest = 0;
  for (const r of rows) {
    newTotal += r.due;
    restInterest += r.interest;
  }

  const repayDate = m === 0 ? (opts.today ?? new Date()) : dateOfInstallment(cfg, m - 1);
  const fr = feeRateAt(repayDate, cfg);

  // 실제 청구액이라 원 미만 절사입니다.
  let fee = Math.floor(P * fr);

  // 매달 추가로 넣는 차액. P 가 0이면 재산정할 것이 없어 reduced 도 0인데,
  // 그때 (payment - reduced) 를 그대로 쓰면 매달 내는 원리금 전체를 추가
  // 상환으로 오인해 상환액이 0인데도 수수료가 붙습니다.
  const recycled =
    method === 'pay' && recycle && P > 0 && reduced > 0 ? Math.max(0, cfg.payment - reduced) : 0;

  const feeEstimated = recycled > 0 && rows.length > 0;
  if (feeEstimated) {
    // 매달 같은 차액을 추가로 넣는다고 가정한 추정치라 반올림합니다.
    fee += Math.round(recycled * rows.length * fr);
  }

  const less = baseRest - newTotal;
  const invested = P + fee;
  const net = less - invested;

  // 누적 손익. 마지막 원소는 언제나 net 과 같아야 합니다.
  const len = Math.max(N0, m + rows.length);
  const cum: number[] = new Array(len).fill(0);
  let c = 0;
  for (let k = 0; k < len; k++) {
    if (k < m) {
      cum[k] = 0;
      continue;
    }
    if (k === m) c -= invested;
    c += (base[k]?.due ?? 0) - (rows[k - m]?.due ?? 0);
    cum[k] = c;
  }

  let breakeven: number | null = null;
  for (let k = m; k < len; k++) {
    if ((cum[k] ?? 0) >= 0) {
      breakeven = k;
      break;
    }
  }

  return {
    amount: P,
    clamped,
    delayMonths: m,
    method,
    recycle,
    balanceAt,
    balanceAfter: B1,
    rows,
    count: rows.length,
    reduced,
    drop: reduced > 0 ? Math.max(0, cfg.payment - reduced) : 0,
    feeRate: fr,
    fee,
    feeEstimated,
    less,
    invested,
    net,
    monthsSaved: rest - rows.length,
    baseRest,
    restInterest,
    repayDate,
    cum,
    breakeven,
  };
}
