import './style.css';
import {
  analyze,
  dateOfInstallment,
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
import { months, num, pct, ratio, short, signed, won, ym, ymd } from './format';

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
function defaults(): State {
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

let state: State = defaults();

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
    const d = defaults();
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

function restore(): void {
  const hash = location.hash.replace(/^#/, '');
  const fromHash = hash ? unpack(hash) : null;
  if (fromHash) {
    state = fromHash;
    return;
  }
  try {
    const saved = localStorage.getItem(STORE_KEY);
    const fromStore = saved ? unpack(saved) : null;
    if (fromStore) state = fromStore;
  } catch {
    /* 저장소를 못 쓰는 환경이면 기본값 그대로 갑니다 */
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORE_KEY, pack(state));
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
  inputmsg: el<HTMLParagraphElement>('inputmsg'),
  nextDate: el<HTMLInputElement>('nextDate'),
  nextNo: el<HTMLInputElement>('nextNo'),
  feeRate: el<HTMLInputElement>('feeRate'),
  feeMode: el<HTMLSelectElement>('feeMode'),
  prorataOnly: el<HTMLDivElement>('prorataOnly'),
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
  verdict: el<HTMLParagraphElement>('verdict'),
  netBig: el<HTMLParagraphElement>('netBig'),
  ratioLine: el<HTMLParagraphElement>('ratioLine'),
  cardTerm: el<HTMLButtonElement>('cardTerm'),
  cardPay: el<HTMLButtonElement>('cardPay'),
  netTerm: el<HTMLElement>('netTerm'),
  netPay: el<HTMLElement>('netPay'),
  descTerm: el<HTMLElement>('descTerm'),
  descPay: el<HTMLElement>('descPay'),
  recycleWrap: el<HTMLLabelElement>('recycleWrap'),
  recycle: el<HTMLInputElement>('recycle'),
  recycleHint: el<HTMLElement>('recycleHint'),
  flow: el<HTMLDivElement>('flow'),
  flowCard: el<HTMLElement>('flowCard'),
  curve: el<HTMLDivElement>('curve'),
  curveCard: el<HTMLElement>('curveCard'),
  curveNote: el<HTMLParagraphElement>('curveNote'),
  sumLess: el<HTMLElement>('sumLess'),
  sumInvested: el<HTMLElement>('sumInvested'),
  sumRest: el<HTMLElement>('sumRest'),
  stack: el<HTMLDivElement>('stack'),
  tableWrap: el<HTMLDivElement>('tableWrap'),
  copyLink: el<HTMLButtonElement>('copyLink'),
  reset: el<HTMLButtonElement>('reset'),
  toast: el<HTMLElement>('toast'),
  methodCard: el<HTMLElement>('methodCard'),
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
  ui.rate.value = String(state.cfg.rate);
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

function renderChips(balanceAt: number): void {
  const values = CHIPS.filter((v) => v < balanceAt);
  const html = values
    .map(
      (v) =>
        `<button type="button" class="chip" data-v="${v}" aria-pressed="${state.amount === v}">${short(v)}</button>`,
    )
    .join('');
  ui.amountChips.innerHTML =
    html +
    `<button type="button" class="chip" data-v="${balanceAt}" aria-pressed="${state.amount >= balanceAt}">전액</button>`;
}

function renderFlow(s: Scenario): void {
  const scale = Math.max(s.invested, s.less, 1);
  const outW = (s.invested / scale) * 100;
  const inW = (s.less / scale) * 100;
  const blocks = Math.min(Math.max(s.count, 1), 60);
  const ticks = '<i></i>'.repeat(blocks);

  ui.flow.innerHTML = `
    <div class="flowrow">
      <span>나감</span>
      <div>
        <div class="flowbar flowout" style="width:${outW.toFixed(2)}%"><i style="flex:1"></i></div>
        <p class="flowamt mono">−${num(s.invested)}원</p>
      </div>
    </div>
    <div class="flowrow">
      <span>돌아옴</span>
      <div>
        <div class="flowbar flowin" style="width:${inW.toFixed(2)}%">${ticks}</div>
        <p class="flowamt mono">+${num(s.less)}원 · ${s.count > 0 ? `${s.count}회에 나눠서` : '남은 회차 없음'}</p>
      </div>
    </div>
    <div class="flowtotal">
      <span>순이득 — 돌아온 돈에서 넣은 돈을 뺀 값</span>
      <b class="mono${s.net < 0 ? ' neg' : ''}">${signed(s.net)}</b>
    </div>`;
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
    ui.curveNote.innerHTML = '만기까지 본전에 이르지 못합니다.';
  } else {
    const d = dateOfInstallment(cfg, be);
    const after = be - s.delayMonths;
    ui.curveNote.innerHTML = `본전 <b>${cfg.nextNo + be}회차 · ${ym(d)}</b> — 상환하고 <b>${months(after + 1)}</b> 뒤부터 이득입니다.`;
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

function methodDesc(s: Scenario, cfg: LoanConfig, base: Row[]): string {
  if (s.amount <= 0) return '금액을 정해 주세요';
  if (s.count === 0) return '완납입니다';
  if (s.method === 'term' || s.recycle) {
    if (s.monthsSaved <= 0) return '마지막 회차 금액이 줄어듭니다';
    const before = dateOfInstallment(cfg, base.length - 1);
    const after = dateOfInstallment(cfg, s.delayMonths + s.count - 1);
    return `만기가 ${s.monthsSaved}회 당겨집니다 · ${ym(before)} → ${ym(after)}`;
  }
  if (s.drop <= 0) return '납입액이 내려가지 않습니다';
  return `매달 ${num(s.drop)}원씩 덜 냅니다 · 회차는 그대로`;
}

function setDim(node: HTMLElement, on: boolean): void {
  node.classList.toggle('dim', on);
}

function clearResults(message: string): void {
  ui.verdict.textContent = message;
  ui.netBig.textContent = '';
  ui.ratioLine.textContent = '';
  ui.netTerm.textContent = '—';
  ui.netPay.textContent = '—';
  ui.descTerm.textContent = '';
  ui.descPay.textContent = '';
  ui.flow.innerHTML = '';
  ui.curve.innerHTML = '';
  ui.curveNote.textContent = '';
  ui.sumLess.textContent = '—';
  ui.sumInvested.textContent = '—';
  ui.sumRest.textContent = '—';
  ui.tableWrap.innerHTML = '';
  ui.stack.innerHTML = '';
  for (const node of [ui.methodCard, ui.flowCard, ui.curveCard]) setDim(node, true);
}

function renderLoanLine(a: Analysis): void {
  if (a.problem !== 'ok' || !a.maturityDate) {
    ui.loanline.textContent = '';
    return;
  }
  ui.loanline.innerHTML =
    `남은 회차 <b>${a.count}회</b> (${months(a.count)}) · ` +
    `만기 <b>${ym(a.maturityDate)}</b> · 남은 총이자 <b>${num(a.totalInterest)}원</b>`;
}

function render(): void {
  const cfg = state.cfg;
  const a = analyze(cfg);

  ui.prorataOnly.hidden = cfg.feeMode !== 'prorata';
  renderLoanLine(a);

  // 슬라이딩 수수료는 만기일이 틀리면 조용히 틀린 답을 냅니다.
  // 스케줄로 계산한 만기를 한 번에 넣을 수 있게 해 둡니다.
  const calcMaturity = a.maturityDate ? toISO(a.maturityDate) : '';
  ui.calcMaturity.textContent = calcMaturity ? ymd(parseDate(calcMaturity)) : '';
  ui.fillMaturity.hidden = !calcMaturity || calcMaturity === cfg.maturity;
  ui.fillMaturity.dataset['d'] = calcMaturity;

  if (a.problem !== 'ok') {
    ui.inputmsg.hidden = false;
    ui.inputmsg.textContent =
      a.problem === 'payment-too-small'
        ? `월 납입액이 한 달 이자(${num(a.firstInterest)}원)보다 적어 원금이 줄지 않습니다. 금액을 다시 확인해 주세요.`
        : '남은 원금·연 이율·월 납입액을 0보다 큰 값으로 입력해 주세요.';
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
  for (const node of [ui.methodCard, ui.flowCard, ui.curveCard]) setDim(node, off);

  // ⑤ 방식 비교
  ui.netTerm.textContent = signed(term.net);
  ui.netPay.textContent = signed(pay.net);
  ui.netTerm.classList.toggle('neg', term.net < 0);
  ui.netPay.classList.toggle('neg', pay.net < 0);
  ui.descTerm.textContent = methodDesc(term, cfg, a.base);
  ui.descPay.textContent = methodDesc(pay, cfg, a.base);
  ui.cardTerm.setAttribute('aria-checked', String(state.method === 'term'));
  ui.cardPay.setAttribute('aria-checked', String(state.method === 'pay'));
  ui.recycleWrap.hidden = state.method !== 'pay';
  ui.recycleHint.textContent = state.recycle
    ? `(추가 수수료 약 ${num(Math.max(0, pay.fee - Math.floor(pay.amount * pay.feeRate)))}원 추정)`
    : '(기간 단축과 거의 같아집니다)';

  // ③ 지연 손해
  if (state.delayMonths > 0 && state.amount > 0) {
    const nowS = simulate(cfg, a.base, state.amount, 0, state.method, state.recycle);
    const lost = nowS.net - s.net;
    ui.delayLoss.hidden = false;
    ui.delayLoss.innerHTML = `지금 갚을 때보다 <span class="mono">${num(Math.max(0, lost))}원</span> 덜 남습니다`;
  } else {
    ui.delayLoss.hidden = true;
  }

  // ④ 결론
  if (off) {
    ui.verdict.textContent = '갚을 금액을 정하면 결과가 나옵니다.';
    ui.netBig.textContent = '';
    ui.ratioLine.textContent = '';
  } else {
    const when = state.delayMonths === 0 ? '지금' : `${state.delayMonths}개월 뒤에`;
    const what =
      s.count === 0
        ? '남은 대출이 모두 없어집니다'
        : s.method === 'term' || s.recycle
          ? s.monthsSaved > 0
            ? `만기가 <b>${s.monthsSaved}회</b> 당겨집니다`
            : '마지막 회차 금액이 줄어듭니다'
          : s.drop > 0
            ? `매달 <b>${num(s.drop)}원</b>씩 덜 냅니다`
            : '납입액이 내려가지 않습니다';
    ui.verdict.innerHTML = `<b>${num(s.amount)}원</b>을 ${when} 갚으면 ${what}.`;
    ui.netBig.textContent = signed(s.net);
    ui.netBig.classList.toggle('neg', s.net < 0);
    ui.ratioLine.innerHTML =
      `넣는 돈 <span class="mono">${num(s.invested)}원</span>` +
      ` (수수료 ${num(s.fee)}원 · ${pct(s.feeRate)}${s.feeEstimated ? ' 추정' : ''}) 대비 ` +
      `<span class="mono">${ratio(s.net, s.invested)}</span>` +
      (s.clamped ? ' · 남은 잔액까지만 반영했습니다' : '');
  }

  if (!off) {
    renderFlow(s);
    renderCurve(s, cfg);
  }
  renderTable(s, cfg, a.base);

  ui.sumLess.textContent = won(s.less);
  ui.sumInvested.textContent = won(s.invested);
  ui.sumRest.textContent = won(s.restInterest);

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
  state.amount = Number(target.dataset['v'] ?? 0);
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

ui.reset.addEventListener('click', () => {
  state = defaults();
  history.replaceState(null, '', location.pathname + location.search);
  ui.deriveBox.hidden = true;
  ui.deriveToggle.textContent = '남은 회차로 계산';
  fillInputs();
  render();
  toast('예시값으로 되돌렸습니다');
});

window.addEventListener('hashchange', () => {
  const hash = location.hash.replace(/^#/, '');
  const s = hash ? unpack(hash) : null;
  if (s) {
    state = s;
    fillInputs();
    render();
  }
});

restore();
fillInputs();
render();
