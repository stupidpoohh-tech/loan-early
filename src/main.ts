import './style.css';
import {
  analyze,
  dateOfInstallment,
  feeRateAt,
  fitPayment,
  monthlyRate,
  parseDate,
  simulate,
  toISO,
  type Analysis,
  type FeeMode,
  type LoanConfig,
  type Method,
  type Row,
  type Scenario,
} from './loan';
import { months, num, pct, short, signed, ym, ymd } from './format';

interface State {
  cfg: LoanConfig;
  amount: number;
  delayMonths: number;
  method: Method;
  recycle: boolean;
}

/** 다음 납입일 기본값 — 오늘 이후 첫 25일. 실제 대출 정보는 하드코딩하지 않습니다. */
function nextTwentyFifth(): string {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  let d = new Date(t.getFullYear(), t.getMonth(), 25);
  if (d.getTime() <= t.getTime()) d = new Date(t.getFullYear(), t.getMonth() + 1, 25);
  return toISO(d);
}

/**
 * 예시 대출 — 3,000만원 / 연 15% / 84회.
 * 납입액은 84회에 딱 떨어지는 값입니다. 578,880원 같은 근사치를 쓰면
 * 마지막에 3천원짜리 85회차가 붙어 첫 화면부터 어수선해집니다.
 */
function example(): State {
  const next = nextTwentyFifth();
  const nd = parseDate(next);
  return {
    cfg: {
      balance: 30_000_000,
      rate: 15,
      payment: 578_903,
      nextDate: next,
      nextNo: 1,
      feeRate: 1,
      feeMode: 'flat',
      openDate: toISO(new Date(nd.getFullYear() - 1, nd.getMonth(), nd.getDate())),
      maturity: toISO(new Date(nd.getFullYear() + 7, nd.getMonth(), nd.getDate())),
      feeYears: 3,
    },
    amount: 1_000_000,
    delayMonths: 0,
    method: 'term',
    recycle: false,
  };
}

/**
 * 첫 화면 — 개인의 숫자 칸은 비워 둡니다.
 * 예시 숫자를 채워 두면 내가 넣은 값인지 남이 넣어 둔 값인지 구분이 안 되고,
 * 모바일에서는 지우고 다시 넣는 손이 한 번 더 갑니다.
 * 수수료율·회차·날짜는 개인 정보가 아니라 관행값이라 그대로 둡니다.
 */
function blank(): State {
  const s = example();
  s.cfg.balance = 0;
  s.cfg.rate = 0;
  s.cfg.payment = 0;
  s.amount = 0;
  return s;
}

/** 세 칸이 다 비었으면 아직 아무것도 시작하지 않은 화면입니다. */
function isBlank(s: State): boolean {
  return s.cfg.balance <= 0 && s.cfg.rate <= 0 && s.cfg.payment <= 0;
}

let state: State = blank();

// ── 저장 · 복원 ────────────────────────────────────────────────

const STORE_KEY = 'prepay.v1';

interface Packed {
  v: 1;
  b: number;
  r: number;
  p: number;
  d: string;
  n: number;
  f: number;
  fm: FeeMode;
  o: string;
  mt: string;
  fy: number;
  a: number;
  dm: number;
  me: Method;
  rc: 0 | 1;
}

function pack(s: State): string {
  const p: Packed = {
    v: 1,
    b: s.cfg.balance,
    r: s.cfg.rate,
    p: s.cfg.payment,
    d: s.cfg.nextDate,
    n: s.cfg.nextNo,
    f: s.cfg.feeRate,
    fm: s.cfg.feeMode,
    o: s.cfg.openDate,
    mt: s.cfg.maturity,
    fy: s.cfg.feeYears,
    a: s.amount,
    dm: s.delayMonths,
    me: s.method,
    rc: s.recycle ? 1 : 0,
  };
  // URL 안전 base64. 해시에 +, /, = 가 섞이면 복사·붙여넣기에서 깨집니다.
  return btoa(JSON.stringify(p)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unpack(raw: string): State | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(atob(b64)) as Partial<Packed>;
    if (o.v !== 1) return null;
    const d = example();
    const n = (x: unknown, fb: number) => (typeof x === 'number' && Number.isFinite(x) ? x : fb);
    const s = (x: unknown, fb: string) => (typeof x === 'string' && x ? x : fb);
    return {
      cfg: {
        balance: n(o.b, d.cfg.balance),
        rate: n(o.r, d.cfg.rate),
        payment: n(o.p, d.cfg.payment),
        nextDate: s(o.d, d.cfg.nextDate),
        nextNo: n(o.n, d.cfg.nextNo),
        feeRate: n(o.f, d.cfg.feeRate),
        feeMode: o.fm === 'prorata' ? 'prorata' : 'flat',
        openDate: s(o.o, d.cfg.openDate),
        maturity: s(o.mt, d.cfg.maturity),
        feeYears: n(o.fy, d.cfg.feeYears),
      },
      amount: n(o.a, d.amount),
      delayMonths: n(o.dm, d.delayMonths),
      method: o.me === 'pay' ? 'pay' : 'term',
      recycle: o.rc === 1,
    };
  } catch {
    return null;
  }
}

/** 값을 어디서 가져왔는지 — 화면에 알려 주기 위해 기억해 둡니다 */
type Origin = 'default' | 'link' | 'saved';
let origin: Origin = 'default';

function restore(): void {
  const hash = location.hash.replace(/^#/, '');
  const fromHash = hash ? unpack(hash) : null;
  if (fromHash) {
    state = fromHash;
    origin = 'link';
    return;
  }
  try {
    const saved = localStorage.getItem(STORE_KEY);
    const fromStore = saved ? unpack(saved) : null;
    if (fromStore) {
      state = fromStore;
      origin = 'saved';
      touched = true; // 이미 저장된 내 값이므로 계속 갱신합니다
    }
  } catch {
    /* 저장소를 못 쓰는 환경이면 기본값 그대로 갑니다 */
  }
}

/**
 * 사용자가 값을 만지기 전에는 저장하지 않습니다.
 * 예시값을 그대로 저장해 버리면 다음 방문에 "지난번 입력값을 불러왔다"고
 * 알리면서 정작 예시 숫자를 보여 주게 됩니다.
 */
let touched = false;

function persist(): void {
  if (!touched) return;
  try {
    localStorage.setItem(STORE_KEY, pack(state));
  } catch {
    /* 무시 */
  }
}

function forget(): void {
  touched = false;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* 무시 */
  }
}

// ── DOM ────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} 를 찾을 수 없습니다`);
  return node as T;
}

const ui = {
  balance: el<HTMLInputElement>('balance'),
  rate: el<HTMLInputElement>('rate'),
  payment: el<HTMLInputElement>('payment'),
  deriveToggle: el<HTMLButtonElement>('deriveToggle'),
  deriveBox: el<HTMLDivElement>('deriveBox'),
  restCount: el<HTMLInputElement>('restCount'),
  deriveApply: el<HTMLButtonElement>('deriveApply'),
  loanline: el<HTMLParagraphElement>('loanline'),
  lede: el<HTMLParagraphElement>('lede'),
  loanbar: el<HTMLButtonElement>('loanbar'),
  loanbarText: el<HTMLElement>('loanbarText'),
  loanEdit: el<HTMLDivElement>('loanEdit'),
  loanDone: el<HTMLButtonElement>('loanDone'),
  inputmsg: el<HTMLParagraphElement>('inputmsg'),
  restored: el<HTMLParagraphElement>('restored'),
  netLabel: el<HTMLParagraphElement>('netLabel'),
  ratewarn: el<HTMLParagraphElement>('ratewarn'),
  stickybar: el<HTMLButtonElement>('stickybar'),
  sbAmt: el<HTMLElement>('sbAmt'),
  sbWhen: el<HTMLElement>('sbWhen'),
  sbNet: el<HTMLElement>('sbNet'),
  nextDate: el<HTMLInputElement>('nextDate'),
  nextNo: el<HTMLInputElement>('nextNo'),
  feeRate: el<HTMLInputElement>('feeRate'),
  feeMode: el<HTMLSelectElement>('feeMode'),
  prorataOnly: el<HTMLDivElement>('prorataOnly'),
  feeOpen: el<HTMLButtonElement>('feeOpen'),
  feeText: el<HTMLElement>('feeText'),
  feeDialog: el<HTMLDialogElement>('feeDialog'),
  feeClose: el<HTMLButtonElement>('feeClose'),
  feeDone: el<HTMLButtonElement>('feeDone'),
  openDate: el<HTMLInputElement>('openDate'),
  maturity: el<HTMLInputElement>('maturity'),
  feeYears: el<HTMLInputElement>('feeYears'),
  fillMaturity: el<HTMLButtonElement>('fillMaturity'),
  calcMaturity: el<HTMLElement>('calcMaturity'),
  amount: el<HTMLInputElement>('amount'),
  amountNum: el<HTMLInputElement>('amountNum'),
  amountChips: el<HTMLDivElement>('amountChips'),
  delay: el<HTMLInputElement>('delay'),
  delayOut: el<HTMLElement>('delayOut'),
  delayLoss: el<HTMLParagraphElement>('delayLoss'),
  waitHint: el<HTMLParagraphElement>('waitHint'),
  waitText: el<HTMLElement>('waitText'),
  waitApply: el<HTMLButtonElement>('waitApply'),
  sayAmount: el<HTMLElement>('sayAmount'),
  sayCompare: el<HTMLElement>('sayCompare'),
  sayFee: el<HTMLElement>('sayFee'),
  verdictBox: el<HTMLDivElement>('verdictBox'),
  verdict: el<HTMLParagraphElement>('verdict'),
  netBig: el<HTMLParagraphElement>('netBig'),
  ratioLine: el<HTMLParagraphElement>('ratioLine'),
  cardTerm: el<HTMLButtonElement>('cardTerm'),
  cardPay: el<HTMLButtonElement>('cardPay'),
  netTerm: el<HTMLElement>('netTerm'),
  netPay: el<HTMLElement>('netPay'),
  recycleWrap: el<HTMLLabelElement>('recycleWrap'),
  recycle: el<HTMLInputElement>('recycle'),
  recycleHint: el<HTMLElement>('recycleHint'),
  inout: el<HTMLDivElement>('inout'),
  ioOut: el<HTMLElement>('ioOut'),
  ioIn: el<HTMLElement>('ioIn'),
  curve: el<HTMLDivElement>('curve'),
  curveNote: el<HTMLParagraphElement>('curveNote'),
  stack: el<HTMLDivElement>('stack'),
  tableWrap: el<HTMLDivElement>('tableWrap'),
  copyLink: el<HTMLButtonElement>('copyLink'),
  reset: el<HTMLButtonElement>('reset'),
  toast: el<HTMLElement>('toast'),
};

// ── 금액 입력칸 ────────────────────────────────────────────────
// 8자리 원화를 "30000000" 으로 보여주면 자릿수를 셀 수 없습니다.
// type=text + inputmode=numeric 으로 두고 직접 쉼표를 넣습니다.

function moneyOf(input: HTMLInputElement): number {
  const digits = input.value.replace(/\D/g, '');
  return digits ? Number(digits) : 0;
}

function setMoney(input: HTMLInputElement, n: number): void {
  const next = n > 0 ? n.toLocaleString('ko-KR') : '';
  if (input.value !== next) input.value = next;
}

/** 쉼표를 다시 넣으면서 캐럿을 원래 자리(앞쪽 숫자 개수 기준)로 돌려놓습니다. */
function reformatMoney(input: HTMLInputElement): void {
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const digitsBefore = before.replace(/\D/g, '').length;
  const digits = input.value.replace(/\D/g, '');
  input.value = digits ? Number(digits).toLocaleString('ko-KR') : '';

  let pos = 0;
  let seen = 0;
  while (pos < input.value.length && seen < digitsBefore) {
    if (/\d/.test(input.value[pos] ?? '')) seen++;
    pos++;
  }
  try {
    input.setSelectionRange(pos, pos);
  } catch {
    /* 선택 영역을 못 쓰는 입력칸이면 넘어갑니다 */
  }
}

/** 입력칸에 상태를 씁니다. 사용자가 타이핑하는 중에는 부르지 않습니다. */
function fillInputs(): void {
  setMoney(ui.balance, state.cfg.balance);
  ui.rate.value = state.cfg.rate > 0 ? String(state.cfg.rate) : '';
  setMoney(ui.payment, state.cfg.payment);
  ui.nextDate.value = state.cfg.nextDate;
  ui.nextNo.value = String(state.cfg.nextNo);
  ui.feeRate.value = String(state.cfg.feeRate);
  ui.feeMode.value = state.cfg.feeMode;
  ui.openDate.value = state.cfg.openDate;
  ui.maturity.value = state.cfg.maturity;
  ui.feeYears.value = String(state.cfg.feeYears);
  ui.recycle.checked = state.recycle;
}

function readInputs(): void {
  const n = (input: HTMLInputElement, fb: number) => {
    const v = Number(input.value);
    return Number.isFinite(v) ? v : fb;
  };
  state.cfg.balance = moneyOf(ui.balance);
  state.cfg.rate = Math.max(0, n(ui.rate, 0));
  state.cfg.payment = moneyOf(ui.payment);
  state.cfg.nextDate = ui.nextDate.value || state.cfg.nextDate;
  state.cfg.nextNo = Math.max(1, Math.round(n(ui.nextNo, 1)));
  state.cfg.feeRate = Math.max(0, n(ui.feeRate, 0));
  state.cfg.feeMode = ui.feeMode.value === 'prorata' ? 'prorata' : 'flat';
  state.cfg.openDate = ui.openDate.value || state.cfg.openDate;
  state.cfg.maturity = ui.maturity.value || state.cfg.maturity;
  state.cfg.feeYears = Math.max(0, n(ui.feeYears, 0));
  state.recycle = ui.recycle.checked;
}

// ── 그리기 ─────────────────────────────────────────────────────

const CHIPS = [100_000, 500_000, 1_000_000, 3_000_000, 5_000_000, 10_000_000];

/**
 * 칩은 더하기입니다 — 100만을 누르고 300만을 누르면 400만이 됩니다.
 * 한 번에 정확한 금액을 고르는 사람보다 얹어 가며 맞추는 사람이 많습니다.
 * 남은 잔액을 넘길 칩은 아예 그리지 않고, 되돌릴 [지우기]를 끝에 답니다.
 */
function renderChips(balanceAt: number): void {
  const room = Math.max(0, balanceAt - state.amount);
  const adds = CHIPS.filter((v) => v <= room)
    .map((v) => `<button type="button" class="chip" data-add="${v}">+${short(v)}</button>`)
    .join('');
  const all = `<button type="button" class="chip" data-set="${balanceAt}" aria-pressed="${state.amount >= balanceAt}">전액</button>`;
  const clear =
    state.amount > 0 ? '<button type="button" class="chip clear" data-set="0">지우기</button>' : '';
  ui.amountChips.innerHTML = adds + all + clear;
}

function renderCurve(s: Scenario, cfg: LoanConfig): void {
  const cum = s.cum;
  const len = cum.length;
  if (len === 0) {
    ui.curve.innerHTML = '';
    ui.curveNote.textContent = '';
    return;
  }
  let min = 0;
  let max = 0;
  for (const v of cum) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const zeroY = (max / span) * 100;

  const bars = cum
    .map((v, k) => {
      const h = (Math.abs(v) / span) * 100;
      const y = v >= 0 ? zeroY - h : zeroY;
      const fill = v >= 0 ? 'var(--pr)' : 'var(--it)';
      return `<rect x="${k + 0.07}" y="${y.toFixed(3)}" width="0.86" height="${Math.max(h, 0.4).toFixed(3)}" fill="${fill}"/>`;
    })
    .join('');

  const be = s.breakeven;
  const beLine =
    be === null
      ? ''
      : `<line x1="${be + 0.5}" y1="0" x2="${be + 0.5}" y2="100" stroke="var(--text)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>`;

  ui.curve.innerHTML = `<svg viewBox="0 0 ${len} 100" preserveAspectRatio="none" role="img"
      aria-label="누적 손익 곡선. 본전 시점 ${be === null ? '없음' : `${cfg.nextNo + be}회차`}">
      ${bars}
      <line x1="0" y1="${zeroY.toFixed(3)}" x2="${len}" y2="${zeroY.toFixed(3)}" stroke="var(--hair)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      ${beLine}
    </svg>`;

  if (be === null) {
    ui.curveNote.innerHTML = '<i>언제부터 이득?</i> 만기까지 본전에 못 미칩니다';
  } else {
    const d = dateOfInstallment(cfg, be);
    ui.curveNote.innerHTML =
      `<i>언제부터 이득?</i> <b>${ymKo(d)}</b>부터 · 갚고 ${months(be - s.delayMonths + 1)} 뒤`;
  }
}

function renderTable(s: Scenario, cfg: LoanConfig, base: Row[]): void {
  const rows = s.rows.length > 0 ? s.rows : base;
  const offset = s.rows.length > 0 ? s.delayMonths : 0;

  const head = '<tr><th>회차</th><th>납입일</th><th>납입액</th><th>이자</th><th>원금</th><th>잔액</th></tr>';
  const body = rows
    .map((r) => {
      const no = cfg.nextNo + offset + r.index;
      const d = dateOfInstallment(cfg, offset + r.index);
      return `<tr><td>${no}</td><td>${ymd(d)}</td><td>${num(r.due)}</td><td>${num(r.interest)}</td><td>${num(r.principal)}</td><td>${num(r.balance)}</td></tr>`;
    })
    .join('');
  ui.tableWrap.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;

  // 원금/이자 구성 — 의사결정용이 아니라 구조 설명용이라 접힌 영역에만 둡니다.
  const n = rows.length;
  const peak = Math.max(...rows.map((r) => r.due), 1);
  const stack = rows
    .map((r, k) => {
      const ih = (r.interest / peak) * 100;
      const ph = (r.principal / peak) * 100;
      return (
        `<rect x="${k + 0.05}" y="${(100 - ih).toFixed(2)}" width="0.9" height="${ih.toFixed(2)}" fill="var(--it)"/>` +
        `<rect x="${k + 0.05}" y="${(100 - ih - ph).toFixed(2)}" width="0.9" height="${ph.toFixed(2)}" fill="var(--pr)"/>`
      );
    })
    .join('');
  ui.stack.innerHTML =
    `<p class="legend"><span><i style="background:var(--pr)"></i>원금</span><span><i style="background:var(--it)"></i>이자</span></p>` +
    `<svg viewBox="0 0 ${n} 100" preserveAspectRatio="none" role="img" aria-label="회차별 원금과 이자 구성">${stack}</svg>`;
}

/**
 * 대출 정보가 없으면 잔액을 모르니 금액 조작부를 그릴 수 없습니다.
 * 이때 슬라이더를 그냥 두면 value 가 비어 있어 브라우저가 min·max의
 * 한가운데(1,500만)에 손잡이를 놓습니다 — 0원인데 반쯤 채워진 화면이 됩니다.
 */
function clearAmountUI(): void {
  ui.amount.value = String(Math.max(0, state.amount));
  if (document.activeElement !== ui.amountNum) setMoney(ui.amountNum, state.amount);
  ui.delay.value = String(Math.max(0, state.delayMonths));
  ui.amountChips.innerHTML = '';
}

function clearResults(message: string): void {
  ui.verdict.textContent = message;
  ui.netBig.textContent = '';
  ui.ratioLine.textContent = '';
  ui.netTerm.textContent = '—';
  ui.netPay.textContent = '—';
  ui.inout.hidden = true;
  ui.curve.innerHTML = '';
  ui.curveNote.textContent = '';
  ui.tableWrap.innerHTML = '';
  ui.stack.innerHTML = '';
}

function renderLoanLine(a: Analysis): void {
  if (a.problem !== 'ok' || !a.maturityDate) {
    ui.loanline.textContent = '';
    return;
  }
  ui.loanline.innerHTML =
    `<b>${a.count}번</b> 더 · <b>${ymKo(a.maturityDate)}</b> · 이자 <b>${short(a.totalInterest)}</b>`;
}

/**
 * 대출 정보 입력은 한 번 하는 일이고 슬라이더는 계속 만지는 일입니다.
 * 세 칸이 다 차면 한 줄로 접어 자리를 슬라이더 쪽에 넘깁니다.
 * 타이핑 도중에 접히면 안 되므로, 사용자가 상환 조건 쪽을 건드릴 때 접습니다.
 */
let editing = true;

/** 렌더에서 계산한 최적 지연 — '그때로 바꿔보기' 버튼이 씁니다 */
let suggestedDelay = 0;

function syncLoanCard(): void {
  const canFold = analyze(state.cfg).problem === 'ok';
  const fold = canFold && !editing;
  ui.loanDone.hidden = !canFold || fold;
  ui.lede.hidden = fold;
  ui.loanbar.hidden = !fold;
  ui.loanEdit.hidden = fold;
  if (!fold) return;
  ui.loanbarText.textContent =
    `${short(state.cfg.balance)} · ${state.cfg.rate}% · 월 ${short(state.cfg.payment)}`;
}

/** 이 금리 아래면 예금과 비교할 실익이 생깁니다 (예금 3%대, 이자소득세 15.4% 감안) */
const LOW_RATE = 5;

/** 문장 안에 들어가는 날짜 — "2031.11" 보다 "2031년 11월" 이 읽힙니다 */
function ymKo(d: Date): string {
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}

/** 빈 칸을 하나씩 짚어 줍니다. "0보다 큰 값" 보다 무엇이 없는지가 중요합니다. */
function missingFields(): string {
  const miss: string[] = [];
  if (state.cfg.balance <= 0) miss.push('아직 갚아야 할 돈');
  if (state.cfg.rate <= 0) miss.push('이자율');
  if (state.cfg.payment <= 0) miss.push('매달 내는 돈');
  return miss.join(', ');
}

function syncResetButton(): void {
  ui.reset.textContent = isBlank(state) ? '예시로 채워보기' : '입력값 지우기';
}

function render(): void {
  const cfg = state.cfg;
  const a = analyze(cfg);

  ui.prorataOnly.hidden = cfg.feeMode !== 'prorata';
  ui.feeText.textContent =
    `${cfg.feeRate}%` +
    (cfg.feeYears > 0 ? ` · ${cfg.feeYears}년` : ' · 기간 제한 없음') +
    (cfg.feeMode === 'prorata' ? ' · 슬라이딩' : '');
  renderLoanLine(a);

  // 슬라이딩 수수료는 만기일이 틀리면 조용히 틀린 답을 냅니다.
  // 스케줄로 계산한 만기를 한 번에 넣을 수 있게 해 둡니다.
  const calcMaturity = a.maturityDate ? toISO(a.maturityDate) : '';
  ui.calcMaturity.textContent = calcMaturity ? ymd(parseDate(calcMaturity)) : '';
  ui.fillMaturity.hidden = !calcMaturity || calcMaturity === cfg.maturity;
  ui.fillMaturity.dataset['d'] = calcMaturity;

  syncResetButton();
  syncLoanCard();

  if (a.problem !== 'ok') {
    // 아직 아무것도 넣지 않은 첫 화면에 경고를 띄울 이유는 없습니다.
    if (isBlank(state)) {
      ui.inputmsg.hidden = true;
      clearAmountUI();
      clearResults('위 세 칸을 채우시면 결과가 바로 나옵니다.');
      return;
    }
    const miss = missingFields();
    ui.inputmsg.hidden = false;
    ui.inputmsg.textContent =
      a.problem === 'payment-too-small'
        ? `매달 내는 돈이 한 달 이자(${num(a.firstInterest)}원)보다 적습니다. 이러면 원금이 줄지 않으니 금액을 다시 확인해 주세요.`
          : miss
            ? `${miss}을 입력해 주세요.`
            : '세 칸을 모두 0보다 큰 값으로 입력해 주세요.';
    clearAmountUI();
    clearResults('대출 정보를 먼저 채워 주세요.');
    return;
  }
  ui.inputmsg.hidden = true;

  // 지연 슬라이더 범위
  const maxDelay = a.maxDelay;
  ui.delay.max = String(maxDelay);
  state.delayMonths = Math.min(Math.max(0, state.delayMonths), maxDelay);
  if (ui.delay.value !== String(state.delayMonths)) ui.delay.value = String(state.delayMonths);

  // 상환 시점의 잔액 — 슬라이더 최대치와 '전액' 칩의 기준입니다
  const prev = state.delayMonths === 0 ? undefined : a.base[state.delayMonths - 1];
  const balanceAt = state.delayMonths === 0 ? cfg.balance : (prev?.balance ?? 0);

  state.amount = Math.min(Math.max(0, Math.round(state.amount)), balanceAt);
  ui.amount.max = String(balanceAt);
  if (ui.amount.value !== String(state.amount)) ui.amount.value = String(state.amount);
  if (document.activeElement !== ui.amountNum) setMoney(ui.amountNum, state.amount);
  renderChips(balanceAt);

  const delayDate = dateOfInstallment(cfg, Math.max(0, state.delayMonths - 1));
  ui.delayOut.textContent =
    state.delayMonths === 0
      ? '지금'
      : `${state.delayMonths}개월 뒤 · ${ym(delayDate)} (${cfg.nextNo + state.delayMonths - 1}회차)`;

  // 두 방식을 항상 같이 계산합니다. 사용자는 자기 대출이 어느 쪽인지 대체로 모릅니다.
  const term = simulate(cfg, a.base, state.amount, state.delayMonths, 'term', false);
  const pay = simulate(cfg, a.base, state.amount, state.delayMonths, 'pay', state.recycle);
  const s = state.method === 'term' ? term : pay;

  const off = state.amount <= 0;

  // ⑤ 방식 비교
  ui.netTerm.textContent = signed(term.net);
  ui.netPay.textContent = signed(pay.net);
  ui.netTerm.classList.toggle('neg', term.net < 0);
  ui.netPay.classList.toggle('neg', pay.net < 0);
  ui.cardTerm.setAttribute('aria-checked', String(state.method === 'term'));
  ui.cardPay.setAttribute('aria-checked', String(state.method === 'pay'));
  ui.recycleWrap.hidden = state.method !== 'pay';
  ui.recycleHint.textContent = state.recycle
    ? `(추가 수수료 약 ${num(Math.max(0, pay.fee - Math.floor(pay.amount * pay.feeRate)))}원 추정)`
    : '(기간 단축과 거의 같아집니다)';

  // ③ 지연 손해
  if (state.delayMonths > 0 && state.amount > 0) {
    const nowS = simulate(cfg, a.base, state.amount, 0, state.method, state.recycle);
    const diff = s.net - nowS.net;
    ui.delayLoss.hidden = false;
    ui.delayLoss.innerHTML =
      diff > 0
        ? `지금 갚을 때보다 <span class="mono">${num(diff)}원</span> 더 남습니다 — 수수료가 줄어든 덕입니다`
        : diff < 0
          ? `지금 갚을 때보다 <span class="mono">${num(-diff)}원</span> 덜 남습니다`
          : '지금 갚을 때와 차이가 없습니다';
  } else {
    ui.delayLoss.hidden = true;
  }

  // '언제' 축의 정답 — 미뤄서 나아지는 유일한 힘은 수수료 면제입니다.
  // 금리가 낮고 면제가 코앞이면 몇 달 기다리는 쪽이 이기므로, 그때만 먼저 알려 줍니다.
  suggestedDelay = 0;
  if (state.amount > 0) {
    let bestNet = -Infinity;
    for (let m2 = 0; m2 <= maxDelay; m2++) {
      const n2 =
        m2 === state.delayMonths
          ? s.net
          : simulate(cfg, a.base, state.amount, m2, state.method, state.recycle).net;
      if (n2 > bestNet) {
        bestNet = n2;
        suggestedDelay = m2;
      }
    }
    const gain = bestNet - s.net;
    if (suggestedDelay > state.delayMonths && gain >= 10_000) {
      const dd = dateOfInstallment(cfg, suggestedDelay - 1);
      const feeThen = feeRateAt(dd, cfg);
      ui.waitHint.hidden = false;
      ui.waitText.innerHTML =
        `<b>${suggestedDelay}개월 뒤(${ymKo(dd)})</b>부터는 중도상환수수료가 ` +
        `${feeThen === 0 ? '없습니다' : '크게 줄어듭니다'}. 그때 갚으면 <b>${num(gain)}원</b> 더 남습니다.`;
    } else {
      ui.waitHint.hidden = true;
    }
  } else {
    ui.waitHint.hidden = true;
  }

  // ④ 결론
  if (off) {
    ui.verdict.textContent = '위에서 얼마를 갚으실지 정해 주세요.';
    ui.netLabel.hidden = true;
    ui.netBig.textContent = '';
    ui.ratioLine.textContent = '';
    ui.ratewarn.hidden = true;
    ui.stickybar.hidden = true;
    // 금액을 0으로 되돌리면 직전 계산의 분할·곡선이 남습니다. 같이 지웁니다.
    ui.inout.hidden = true;
    ui.curve.innerHTML = '';
    ui.curveNote.textContent = '';
  } else {
    const when = state.delayMonths === 0 ? '지금' : `${state.delayMonths}개월 뒤에`;

    const what =
      s.count === 0
        ? '남은 대출이 모두 없어집니다'
        : s.method === 'term' || s.recycle
          ? s.monthsSaved > 0
            ? `대출이 <b>${s.monthsSaved}개월</b> 빨리 끝납니다`
            : '마지막에 내는 돈이 줄어듭니다'
          : s.drop > 0
            ? `매달 <b>${num(s.drop)}원</b>씩 덜 냅니다`
            : '매달 내는 돈이 줄지 않습니다';
    // '지금'은 바로 위 시점 슬라이더가 이미 말하고 있어 되풀이하지 않습니다
    ui.verdict.innerHTML = state.delayMonths === 0 ? `${what}.` : `${when} 갚으시면 ${what}.`;
    ui.netLabel.hidden = false;
    ui.netLabel.textContent = s.net >= 0 ? '내 손에 남는 돈' : '오히려 손해';
    const nextNet = signed(s.net);
    if (ui.netBig.textContent !== nextNet) {
      ui.netBig.textContent = nextNet;
      ui.netBig.classList.remove('bump');
      void ui.netBig.offsetWidth; // 애니메이션을 다시 태우려면 리플로우가 필요합니다
      ui.netBig.classList.add('bump');
    }
    ui.netBig.classList.toggle('neg', s.net < 0);
    ui.inout.hidden = false;
    // 반 폭 칸이라 만 단위로 줄입니다. 정확한 금액은 캡션·행동 안내에 있습니다.
    ui.ioOut.textContent = `−${short(s.invested)}원`;
    ui.ioIn.textContent = `+${short(s.less)}원`;
    ui.ratioLine.innerHTML =
      (s.fee > 0
        ? `수수료 ${num(s.fee)}원(${pct(s.feeRate)}${s.feeEstimated ? ' 추정' : ''}) 포함`
        : '수수료 없음') +
      (s.invested > 0 ? ` · 넣은 돈의 ${Math.round((s.net / s.invested) * 100)}% 이득` : '') +
      ` · 갚고도 이자 ${num(s.restInterest)}원 남음` +
      (s.clamped ? ' · 남은 금액까지만 반영' : '');

    ui.sayAmount.textContent = `${num(s.amount)}원`;
    ui.sayCompare.innerHTML =
      `→ 기간이 줄면 <b>${signed(term.net)}</b>, 월 납입금이 줄면 <b>${signed(pay.net)}</b>. ` +
      `답을 듣고 위 '은행이 어떻게 줄여 주나요?'에서 맞는 쪽을 누르세요.`;
    ui.sayFee.innerHTML =
      `→ 이 계산으로는 약 <b>${num(s.fee)}원</b>입니다. 많이 다르면 아래 수수료 설정을 고쳐 다시 보세요.`;

    // 금리가 낮으면 "갚는 게 이득"이라는 결론이 뒤집힐 수 있습니다.
    // 이 도구는 예금에 뒀을 때의 이자를 계산에 넣지 않으므로 그때만 알립니다.
    ui.sbAmt.textContent = `${num(s.amount)}원`;
    ui.sbWhen.textContent = state.delayMonths === 0 ? '지금 갚으면' : `${state.delayMonths}개월 뒤 갚으면`;
    ui.sbNet.textContent = signed(s.net);
    ui.sbNet.classList.toggle('neg', s.net < 0);

    ui.ratewarn.hidden = cfg.rate > LOW_RATE || s.net <= 0;
    ui.ratewarn.innerHTML =
      `이 대출은 금리가 <b>${cfg.rate}%</b>로 낮은 편입니다. 갚지 않고 그 돈을 예금에 두면 ` +
      `이자가 붙으므로, <b>예금 금리와 비교해 보신 뒤</b> 정하시는 편이 좋습니다. ` +
      `예금 이자에는 15.4%의 세금이 붙는다는 점도 함께 보세요.`;
  }

  if (!off) {
    renderCurve(s, cfg);
  }
  renderTable(s, cfg, a.base);


  persist();
}

// ── 이벤트 ─────────────────────────────────────────────────────

function onInputChange(): void {
  readInputs();
  render();
}

for (const input of [ui.balance, ui.payment]) {
  input.addEventListener('input', () => {
    reformatMoney(input);
    onInputChange();
  });
}
for (const input of [ui.rate, ui.nextNo, ui.feeRate, ui.feeYears]) {
  input.addEventListener('input', onInputChange);
}
for (const input of [ui.nextDate, ui.openDate, ui.maturity, ui.feeMode]) {
  input.addEventListener('change', onInputChange);
}

ui.amount.addEventListener('input', () => {
  state.amount = Number(ui.amount.value);
  render();
});

ui.amountNum.addEventListener('input', () => {
  reformatMoney(ui.amountNum);
  state.amount = moneyOf(ui.amountNum);
  render();
});

ui.delay.addEventListener('input', () => {
  state.delayMonths = Number(ui.delay.value);
  render();
});

ui.amountChips.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest('.chip') as HTMLElement | null;
  if (!target) return;
  const add = target.dataset['add'];
  const set = target.dataset['set'];
  // 상한 처리는 render() 가 잔액 기준으로 한 번에 합니다
  if (add !== undefined) state.amount += Number(add);
  else if (set !== undefined) state.amount = Number(set);
  render();
});

ui.cardTerm.addEventListener('click', () => {
  state.method = 'term';
  render();
});
ui.cardPay.addEventListener('click', () => {
  state.method = 'pay';
  render();
});
ui.recycle.addEventListener('change', () => {
  state.recycle = ui.recycle.checked;
  render();
});

ui.deriveToggle.addEventListener('click', () => {
  const open = ui.deriveBox.hidden;
  ui.deriveBox.hidden = !open;
  ui.deriveToggle.textContent = open ? '닫기' : '남은 회차로 계산';
  if (open) {
    const a = analyze(state.cfg);
    ui.restCount.value = String(a.count > 0 ? a.count : 60);
    ui.restCount.focus();
  }
});

ui.deriveApply.addEventListener('click', () => {
  const n = Math.round(Number(ui.restCount.value));
  if (!Number.isFinite(n) || n < 1 || n > 720) return;
  const p = fitPayment(state.cfg.balance, n, monthlyRate(state.cfg.rate));
  if (p <= 0) return;
  state.cfg.payment = p;
  setMoney(ui.payment, p);
  render();
});

// ── 수수료 설정 팝업 ───────────────────────────────────────────
// 값은 고치는 즉시 뒤 화면에 반영되므로 '확인'은 닫기와 같습니다.

function openFee(): void {
  ui.feeDialog.showModal();
  document.documentElement.classList.add('sheetopen');
}

function closeFee(): void {
  ui.feeDialog.close();
}

ui.feeOpen.addEventListener('click', openFee);
ui.feeClose.addEventListener('click', closeFee);
ui.feeDone.addEventListener('click', closeFee);

// 바깥(백드롭)을 누르면 닫습니다 — 팝업 자신이 클릭 대상일 때만 바깥입니다
ui.feeDialog.addEventListener('click', (e) => {
  if (e.target === ui.feeDialog) closeFee();
});

// Esc 로 닫히는 경우까지 한곳에서 뒷정리합니다
ui.feeDialog.addEventListener('close', () => {
  document.documentElement.classList.remove('sheetopen');
});

ui.fillMaturity.addEventListener('click', () => {
  const d = ui.fillMaturity.dataset['d'];
  if (!d) return;
  state.cfg.maturity = d;
  ui.maturity.value = d;
  render();
});

let toastTimer = 0;
function toast(msg: string): void {
  ui.toast.hidden = false;
  ui.toast.textContent = msg;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
  }, 2400);
}

ui.copyLink.addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}${location.search}#${pack(state)}`;
  history.replaceState(null, '', `#${pack(state)}`);
  try {
    await navigator.clipboard.writeText(url);
    toast('링크를 복사했습니다');
  } catch {
    // 클립보드를 못 쓰는 웹뷰가 있어 주소창 갱신으로 대체합니다
    toast('주소창의 링크를 복사해 주세요');
  }
});

// 비어 있으면 예시를 넣어 주고, 값이 있으면 지웁니다. 버튼 하나로 양쪽을 겸합니다.
ui.reset.addEventListener('click', () => {
  const clearing = !isBlank(state);
  state = clearing ? blank() : example();
  editing = clearing; // 지운 뒤에는 다시 입력하는 중이므로, 다 채워져도 스스로 접지 않습니다
  // 예시는 구경거리지 내 값이 아닙니다. 저장해 두면 다음 방문에 남의 숫자로
  // 화면이 차 있고, 그게 내가 넣은 값인지 예시인지 구분되지 않습니다.
  touched = false;
  forget();
  history.replaceState(null, '', location.pathname + location.search);
  ui.deriveBox.hidden = true;
  ui.deriveToggle.textContent = '남은 회차로 계산';
  fillInputs();
  render();
  origin = 'default';
  showOrigin();
  toast(clearing ? '입력값을 지웠습니다' : '예시값을 넣었습니다');
});

window.addEventListener('hashchange', () => {
  const hash = location.hash.replace(/^#/, '');
  const s = hash ? unpack(hash) : null;
  if (s) {
    state = s;
    editing = false;
    fillInputs();
    render();
    origin = 'link';
    showOrigin();
  }
});

/** 값이 예시가 아닌데 아무 표시가 없으면, 어디서 온 숫자인지 알 수 없습니다. */
function showOrigin(): void {
  if (origin === 'default') {
    ui.restored.hidden = true;
    return;
  }
  ui.restored.hidden = false;
  ui.restored.textContent =
    origin === 'saved'
      ? '지난번에 입력하신 값을 이 브라우저에서 불러왔습니다.'
      : '링크에 담긴 값으로 열었습니다.';
}

// 한 번이라도 값을 만지면 저장을 시작하고, "불러왔습니다" 안내는 내립니다.
for (const ev of ['input', 'change', 'click'] as const) {
  document.addEventListener(ev, (e) => {
    // 되돌리기는 '만진 것'이 아니라 '지운 것'이라 따로 처리합니다
    if ((e.target as HTMLElement | null)?.closest('#reset')) return;
    touched = true;
    if (origin === 'default') return;
    origin = 'default';
    showOrigin();
  });
}

/**
 * 슬라이더를 만지는 동안 결과가 화면 밖에 있으면 조작과 반응이 끊깁니다.
 * 조작부는 보이는데 결과는 안 보이는 순간에만 아래에 요약을 띄웁니다.
 */
let controlsSeen = false;
let verdictSeen = true;

function syncStickybar(): void {
  const show = controlsSeen && !verdictSeen && !!ui.netBig.textContent;
  if (ui.stickybar.hidden === !show) return;
  ui.stickybar.hidden = !show;
}

if ('IntersectionObserver' in window) {
  new IntersectionObserver(
    ([e]) => {
      verdictSeen = !!e?.isIntersecting;
      syncStickybar();
    },
    { threshold: 0.55 },
  ).observe(ui.verdictBox);
  new IntersectionObserver(
    ([e]) => {
      controlsSeen = !!e?.isIntersecting;
      syncStickybar();
    },
    { threshold: 0 },
  ).observe(ui.amount);
}

ui.loanbar.addEventListener('click', () => {
  editing = true;
  syncLoanCard();
  ui.balance.focus();
});

ui.waitApply.addEventListener('click', () => {
  state.delayMonths = suggestedDelay;
  touched = true;
  render();
  persist();
});

ui.loanDone.addEventListener('click', () => {
  editing = false;
  syncLoanCard();
});

ui.stickybar.addEventListener('click', () => {
  ui.verdictBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

restore();
editing = analyze(state.cfg).problem !== 'ok';
fillInputs();
render();
showOrigin();
