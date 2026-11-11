import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PRICING = JSON.parse(readFileSync(join(HERE, 'pricing.json'), 'utf8'));

/** 未知のモデルに使う保守的な既定値（安く見積もって驚くより、高く見積もる） */
export const UNKNOWN_MODEL = { input: 15.0, output: 75.0, tier: 'capable' };

export function priceOf(model, pricing = PRICING) {
  return pricing.models?.[model] ?? UNKNOWN_MODEL;
}

export function isKnownModel(model, pricing = PRICING) {
  return Boolean(pricing.models?.[model]);
}

/** 1 回の呼び出しのコスト（USD） */
export function costOf({ model, input_tokens = 0, output_tokens = 0 }, pricing = PRICING) {
  const p = priceOf(model, pricing);
  return (Number(input_tokens) * p.input + Number(output_tokens) * p.output) / 1_000_000;
}

/** 1 段階安いモデル。無ければ null */
export function cheaperThan(model, pricing = PRICING) {
  return pricing.downgrade?.[model] ?? null;
}

// ---------------------------------------------------------------------------
// 走らせる前の見積もり
// ---------------------------------------------------------------------------

/**
 * 掲示板型 swarm のコストを事前に見積もる。
 *
 * 掲示板型の怖いところは、**投稿が増えるほど全員のプロンプトが長くなる**こと。
 * 台数 N・ラウンド R に対して、素朴には O(N × R) 回の呼び出しだが、
 * 入力トークンは掲示板の蓄積ぶんだけ増えるので実質 O(N × R²) に近づく。
 * boardWindow（直近何件を読ませるか）で頭打ちにできる。
 *
 * @param {object} o
 * @param {number} o.workers worker 数
 * @param {number} o.verifiers verifier 数
 * @param {number} o.rounds ラウンド数
 * @param {object} o.models {coordinator, worker, verifier}
 * @param {number} [o.systemTokens] 役割プロンプト等の固定分
 * @param {number} [o.postTokens] 1 投稿あたりの平均トークン
 * @param {number} [o.postsPerTurn] 1 ターンあたりの平均投稿数
 * @param {number} [o.outputTokens] 1 ターンの平均出力トークン
 * @param {number} [o.boardWindow] プロンプトに載せる直近投稿数の上限
 * @param {number} [o.activeRatio] 毎ラウンド動くエージェントの割合
 */
export function estimateRun({
  workers,
  verifiers = 1,
  rounds,
  models = {},
  systemTokens = 1200,
  postTokens = 180,
  postsPerTurn = 1.2,
  outputTokens = 700,
  boardWindow = 40,
  activeRatio = 0.7,
  pricing = PRICING,
} = {}) {
  if (!Number.isFinite(workers) || workers < 1) throw new RangeError('workers は 1 以上が必要です');
  if (!Number.isFinite(rounds) || rounds < 1) throw new RangeError('rounds は 1 以上が必要です');
  if (!Number.isFinite(verifiers) || verifiers < 1) throw new RangeError('verifiers は 1 以上が必要です');

  const roster = [
    { role: 'coordinator', n: 1, model: models.coordinator ?? 'claude-opus-5' },
    { role: 'worker', n: workers, model: models.worker ?? 'claude-sonnet-5' },
    { role: 'verifier', n: verifiers, model: models.verifier ?? 'claude-opus-5' },
  ];
  const agents = 1 + workers + verifiers;

  const byRole = {};
  let usd = 0, calls = 0, inTok = 0, outTok = 0;
  const perRound = [];

  for (let r = 1; r <= rounds; r++) {
    // そのラウンド開始時点で掲示板に積まれている投稿数
    const boardPosts = Math.min(boardWindow, Math.round((r - 1) * agents * activeRatio * postsPerTurn));
    const promptTokens = systemTokens + boardPosts * postTokens;
    let roundUsd = 0;

    for (const { role, n, model } of roster) {
      const active = role === 'coordinator' ? 1 : Math.max(1, Math.round(n * activeRatio));
      const i = active * promptTokens;
      const o = active * outputTokens;
      const c = costOf({ model, input_tokens: i, output_tokens: o }, pricing);
      byRole[role] ??= { role, model, calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 };
      byRole[role].calls += active;
      byRole[role].input_tokens += i;
      byRole[role].output_tokens += o;
      byRole[role].usd += c;
      usd += c; calls += active; inTok += i; outTok += o; roundUsd += c;
    }
    perRound.push({ round: r, boardPosts, promptTokens, usd: round4(roundUsd) });
  }

  return {
    agents,
    calls,
    input_tokens: inTok,
    output_tokens: outTok,
    usd: round4(usd),
    usdPerAgent: round4(usd / agents),
    byRole: Object.values(byRole).map((x) => ({ ...x, usd: round4(x.usd) })).sort((a, b) => b.usd - a.usd),
    perRound,
    assumptions: { systemTokens, postTokens, postsPerTurn, outputTokens, boardWindow, activeRatio },
  };
}

/**
 * 「予算 X ドルなら何体まで出せるか」を二分探索で求める。
 * 記事の「1000体起動とかもできちゃいそう（予算が許すなら）」に数字で答えるための関数。
 */
export function maxWorkersWithin(budgetUsd, opts = {}) {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new RangeError('budgetUsd は正の数が必要です');
  const cost = (w) => estimateRun({ ...opts, workers: w }).usd;
  if (cost(1) > budgetUsd) return 0;

  let lo = 1, hi = 2;
  while (cost(hi) <= budgetUsd && hi < 100000) { lo = hi; hi *= 2; }
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cost(mid) <= budgetUsd) lo = mid; else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// 走っている間のガード
// ---------------------------------------------------------------------------

/**
 * 実行中のコストを見張る。
 *
 * 単に上限で止めるだけでなく、**このままのペースだと超える**ことを早めに知らせ、
 * 役割ごとにモデルを 1 段落とすという中間手段を出す。
 * いきなり止めると、せっかくの中間成果が検証されないまま捨てられる。
 */
export class CostGovernor {
  /**
   * @param {object} o
   * @param {number} o.budgetUsd 総予算
   * @param {number} [o.plannedRounds] 予定ラウンド数。超過予測に使う
   * @param {number} [o.warnAt] 警告を出す消化率（既定 0.6）
   * @param {number} [o.downgradeAt] 降格を勧める消化率（既定 0.8）
   * @param {number} [o.perAgentUsd] 1 体あたりの上限
   */
  constructor({ budgetUsd, plannedRounds = null, warnAt = 0.6, downgradeAt = 0.8, perAgentUsd = Infinity, pricing = PRICING } = {}) {
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new RangeError('budgetUsd は正の数が必要です');
    if (!(warnAt < downgradeAt && downgradeAt < 1)) throw new RangeError('warnAt < downgradeAt < 1 である必要があります');
    this.budgetUsd = budgetUsd;
    this.plannedRounds = plannedRounds;
    this.warnAt = warnAt;
    this.downgradeAt = downgradeAt;
    this.perAgentUsd = perAgentUsd;
    this.pricing = pricing;
    this.spent = 0;
    this.byAgent = new Map();
    this.byRole = new Map();
    this.byRound = new Map();
    this.calls = 0;
    this.downgraded = new Set();
  }

  /**
   * 1 回の呼び出しを記録する。
   * @param {object} u {agent, role, model, input_tokens, output_tokens, round, usd?}
   * @returns {number} この呼び出しのコスト
   */
  record(u = {}) {
    const usd = Number.isFinite(u.usd) ? u.usd : costOf(u, this.pricing);
    this.spent += usd;
    this.calls++;
    bump(this.byAgent, u.agent ?? '@unknown', usd);
    bump(this.byRole, u.role ?? 'unknown', usd);
    if (Number.isFinite(u.round)) bump(this.byRound, u.round, usd);
    return usd;
  }

  get ratio() {
    return this.spent / this.budgetUsd;
  }

  /** 現在のペースで plannedRounds まで走った場合の着地見込み */
  projectedUsd() {
    if (!this.plannedRounds || this.byRound.size === 0) return null;
    const done = this.byRound.size;
    if (done >= this.plannedRounds) return this.spent;
    // 掲示板型は後半ほどプロンプトが長い。直近ラウンドの単価で残りを引き伸ばす
    const rounds = [...this.byRound.entries()].sort((a, b) => a[0] - b[0]);
    const recent = rounds.at(-1)[1];
    return this.spent + recent * (this.plannedRounds - done);
  }

  /**
   * いま何をすべきか。
   * @returns {{action:'continue'|'warn'|'downgrade'|'stop', reason:string, spent:number, ratio:number, projected:number|null, overAgents:string[]}}
   */
  check() {
    const projected = this.projectedUsd();
    const overAgents = [...this.byAgent.entries()].filter(([, v]) => v > this.perAgentUsd).map(([k]) => k);
    const base = { spent: round4(this.spent), ratio: round4(this.ratio), projected: projected === null ? null : round4(projected), overAgents };

    if (this.spent >= this.budgetUsd) {
      return { action: 'stop', reason: `予算 $${this.budgetUsd} を使い切りました（$${round4(this.spent)}）`, ...base };
    }
    if (overAgents.length > 0) {
      return { action: 'stop', reason: `1 体あたりの上限 $${this.perAgentUsd} を超えたエージェントがいます: ${overAgents.join(', ')}`, ...base };
    }
    if (projected !== null && projected > this.budgetUsd) {
      return { action: 'downgrade', reason: `このペースだと着地 $${round4(projected)} で予算 $${this.budgetUsd} を超えます`, ...base };
    }
    if (this.ratio >= this.downgradeAt) {
      return { action: 'downgrade', reason: `予算の ${Math.round(this.ratio * 100)}% を消化しました。安いモデルに落とす頃合いです`, ...base };
    }
    if (this.ratio >= this.warnAt) {
      return { action: 'warn', reason: `予算の ${Math.round(this.ratio * 100)}% を消化しました`, ...base };
    }
    return { action: 'continue', reason: '予算内', ...base };
  }

  /**
   * 役割ごとのモデル割り当てを 1 段階安くする。
   * 判断の質に効く coordinator / verifier は最後まで残し、手を動かす worker から落とす。
   */
  downgradePlan(models = {}) {
    const order = ['worker', 'coordinator', 'verifier'];
    const next = { ...models };
    for (const role of order) {
      const cur = next[role];
      const cheaper = cur ? cheaperThan(cur, this.pricing) : null;
      if (cheaper && !this.downgraded.has(role)) {
        next[role] = cheaper;
        this.downgraded.add(role);
        return { changed: true, role, from: cur, to: cheaper, models: next };
      }
    }
    return { changed: false, role: null, from: null, to: null, models: next };
  }

  summary() {
    return {
      spent: round4(this.spent),
      budget: this.budgetUsd,
      ratio: round4(this.ratio),
      calls: this.calls,
      byRole: [...this.byRole.entries()].map(([role, usd]) => ({ role, usd: round4(usd) })).sort((a, b) => b.usd - a.usd),
      byAgent: [...this.byAgent.entries()].map(([agent, usd]) => ({ agent, usd: round4(usd) })).sort((a, b) => b.usd - a.usd),
      byRound: [...this.byRound.entries()].sort((a, b) => a[0] - b[0]).map(([round, usd]) => ({ round, usd: round4(usd) })),
    };
  }
}

// ---------------------------------------------------------------------------
// 走ったあとの分析
// ---------------------------------------------------------------------------

/** board.jsonl の中身からコスト内訳と改善案を出す */
export function reportBoard(text, { pricing = PRICING } = {}) {
  const posts = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object') posts.push(o);
    } catch { /* 読めない行は無視する。コスト分析は壊れたボードでも続けたい */ }
  }

  const gov = new CostGovernor({ budgetUsd: Number.MAX_SAFE_INTEGER });
  const models = new Map();
  let unknownModels = new Set();

  for (const p of posts) {
    if (!p.cost) continue;
    const role = roleOf(p.from);
    const model = p.cost.model ?? 'unknown';
    if (!isKnownModel(model, pricing) && model !== 'unknown') unknownModels.add(model);
    gov.record({
      agent: p.from, role, model,
      input_tokens: p.cost.input_tokens, output_tokens: p.cost.output_tokens,
      usd: Number.isFinite(p.cost.usd) ? p.cost.usd : undefined,
      round: p.meta?.round,
    });
    const key = `${role}:${model}`;
    models.set(key, (models.get(key) ?? 0) + 1);
  }

  const s = gov.summary();
  const verdicts = {};
  for (const p of posts) if (p.type === 'verify_result') verdicts[p.verdict] = (verdicts[p.verdict] ?? 0) + 1;
  const vTotal = Object.values(verdicts).reduce((a, b) => a + b, 0);

  return {
    posts: posts.length,
    spent: s.spent,
    calls: s.calls,
    byRole: s.byRole,
    byAgent: s.byAgent,
    byRound: s.byRound,
    modelsUsed: [...models.entries()].map(([k, n]) => ({ key: k, posts: n })),
    unknownModels: [...unknownModels],
    verdicts,
    costPerPass: vTotal && verdicts.pass ? round4(s.spent / verdicts.pass) : null,
    advice: advise({ summary: s, posts, verdicts, pricing }),
  };
}

function advise({ summary, posts, verdicts, pricing }) {
  const out = [];
  const total = summary.spent || 1;
  const role = Object.fromEntries(summary.byRole.map((r) => [r.role, r.usd]));

  if ((role.verifier ?? 0) / total > 0.45) {
    out.push({
      level: 'warn',
      what: `検証に全体の ${Math.round((role.verifier / total) * 100)}% を使っています`,
      why: 'verifier が掲示板全体を毎回読み直している可能性が高い',
      how: 'boardWindow を狭めるか、検証対象の投稿と artifacts だけを渡す',
    });
  }
  if ((role.coordinator ?? 0) / total > 0.4) {
    out.push({
      level: 'warn',
      what: `監督役に全体の ${Math.round((role.coordinator / total) * 100)}% を使っています`,
      why: '分解が終わったあとも毎ラウンド全文を読んでいる',
      how: 'coordinator は未読がある時だけ起動する（swarm-board-core は既定でそうしている）',
    });
  }
  const workerShare = (role.worker ?? 0) / total;
  if (workerShare < 0.35 && summary.byRole.length > 1) {
    out.push({
      level: 'info',
      what: `実作業に使っているのは全体の ${Math.round(workerShare * 100)}% だけです`,
      why: '調整と検証のオーバーヘッドが実作業を上回っている',
      how: 'タスク分割が細かすぎないか見直す。worker 1 体で足りる仕事に群れは要らない',
    });
  }
  const rounds = summary.byRound;
  if (rounds.length >= 3) {
    const first = rounds[0].usd || 1e-9;
    const last = rounds.at(-1).usd;
    if (last / first > 3) {
      out.push({
        level: 'warn',
        what: `1 ラウンドあたりのコストが ${Math.round(last / first)} 倍に膨らんでいます`,
        why: '掲示板が伸びるほど全員のプロンプトが長くなる（掲示板型の構造的な弱点）',
        how: 'boardWindow で直近 N 件に絞る。古い投稿は要約して 1 件に畳む',
      });
    }
  }
  if (verdicts.pass && !verdicts.needs_changes && !verdicts.fail) {
    out.push({
      level: 'warn',
      what: '差し戻しが 1 件もありません',
      why: '受入基準が緩いか、verifier が成果物を実際には確かめていない',
      how: 'assign の body に測定可能な完了基準を書く。verifier に根拠の記載を必須にする',
    });
  }
  const capable = summary.byRole.filter((r) => r.role === 'worker');
  for (const r of capable) {
    const model = posts.find((p) => p.cost && roleOf(p.from) === 'worker')?.cost?.model;
    const cheaper = model ? cheaperThan(model, pricing) : null;
    if (cheaper && r.usd / total > 0.4) {
      out.push({
        level: 'info',
        what: `worker が ${model} を使っています`,
        why: '手を動かす役は判断役ほどの性能を必要としないことが多い',
        how: `${cheaper} に落として一度試し、一発合格率が落ちないか見る`,
      });
    }
  }
  if (out.length === 0) out.push({ level: 'ok', what: '目立つ無駄は見つかりませんでした', why: '', how: '' });
  return out;
}

function roleOf(name) {
  if (typeof name !== 'string' || !name.startsWith('@')) return 'unknown';
  const n = name.slice(1).toLowerCase();
  if (n === 'coordinator' || n.startsWith('coordinator-')) return 'coordinator';
  if (n === 'verifier' || n.startsWith('verifier-')) return 'verifier';
  if (n === 'worker' || n.startsWith('worker-')) return 'worker';
  if (n === 'human') return 'human';
  return 'unknown';
}

function bump(map, key, v) {
  map.set(key, (map.get(key) ?? 0) + v);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export { roleOf, round4 };
