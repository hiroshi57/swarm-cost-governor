import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  costOf, priceOf, cheaperThan, isKnownModel, estimateRun, maxWorkersWithin,
  CostGovernor, reportBoard, PRICING, UNKNOWN_MODEL,
} from '../src/index.mjs';

// ---------- 価格 ----------

test('costOf は 1M トークン単価から計算する', () => {
  const c = costOf({ model: 'claude-sonnet-5', input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(c, PRICING.models['claude-sonnet-5'].input + PRICING.models['claude-sonnet-5'].output);
  assert.equal(costOf({ model: 'mock', input_tokens: 999999, output_tokens: 999999 }), 0);
  assert.equal(costOf({ model: 'claude-opus-5' }), 0, 'トークンが無ければ 0');
});

test('未知のモデルは保守的な既定値で計算する（安く見せない）', () => {
  assert.equal(isKnownModel('なにかの新モデル'), false);
  assert.deepEqual(priceOf('なにかの新モデル'), UNKNOWN_MODEL);
  const unknown = costOf({ model: 'なにかの新モデル', input_tokens: 1e6, output_tokens: 1e6 });
  const cheapest = costOf({ model: 'gemini-4-argon', input_tokens: 1e6, output_tokens: 1e6 });
  assert.ok(unknown > cheapest, '未知のモデルを最安として扱ってはいけない');
});

test('cheaperThan は 1 段階安いモデルを返す', () => {
  assert.equal(cheaperThan('claude-opus-5'), 'claude-sonnet-5');
  assert.equal(cheaperThan('claude-sonnet-5'), 'claude-haiku-4');
  assert.equal(cheaperThan('claude-haiku-4'), null, 'これ以上落とせないモデルは null');
  assert.equal(cheaperThan('存在しない'), null);
});

test('価格表に _note と _updated があり、値がすべて正の数', () => {
  assert.ok(PRICING._note.length > 10, '価格が変わることの注意書きを消さない');
  assert.match(PRICING._updated, /^\d{4}-\d{2}-\d{2}$/);
  for (const [m, p] of Object.entries(PRICING.models)) {
    assert.ok(p.input >= 0 && p.output >= 0, `${m} の価格が負`);
    assert.ok(['capable', 'balanced', 'cheap'].includes(p.tier), `${m} の tier が不正`);
  }
});

// ---------- 事前見積もり ----------

test('estimateRun: 台数とラウンドに応じて増える', () => {
  const a = estimateRun({ workers: 2, rounds: 5 });
  const b = estimateRun({ workers: 8, rounds: 5 });
  const c = estimateRun({ workers: 2, rounds: 15 });
  assert.ok(b.usd > a.usd, '台数が増えれば高い');
  assert.ok(c.usd > a.usd, 'ラウンドが増えれば高い');
  assert.equal(a.agents, 1 + 2 + 1);
  assert.equal(a.perRound.length, 5);
});

test('estimateRun: 掲示板が伸びるほど 1 ラウンドが高くなる', () => {
  const e = estimateRun({ workers: 4, rounds: 10, boardWindow: 1000 });
  assert.ok(e.perRound.at(-1).usd > e.perRound[0].usd * 2, '後半ほど高い');
  assert.ok(e.perRound.at(-1).promptTokens > e.perRound[0].promptTokens);
});

test('estimateRun: boardWindow でプロンプトが頭打ちになる', () => {
  const wide = estimateRun({ workers: 4, rounds: 20, boardWindow: 1000 });
  const narrow = estimateRun({ workers: 4, rounds: 20, boardWindow: 20 });
  assert.ok(narrow.usd < wide.usd, '窓を狭めれば安い');
  const tail = narrow.perRound.slice(-5).map((r) => r.promptTokens);
  assert.equal(new Set(tail).size, 1, '上限に達したら一定になる');
});

test('estimateRun: 役割別にモデルを変えると安くなる', () => {
  const expensive = estimateRun({ workers: 6, rounds: 8, models: { coordinator: 'claude-opus-5', worker: 'claude-opus-5', verifier: 'claude-opus-5' } });
  const mixed = estimateRun({ workers: 6, rounds: 8, models: { coordinator: 'claude-opus-5', worker: 'claude-haiku-4', verifier: 'claude-opus-5' } });
  assert.ok(mixed.usd < expensive.usd * 0.6, '手を動かす役を安くすると大きく下がる');
  assert.equal(mixed.byRole.find((r) => r.role === 'worker').model, 'claude-haiku-4');
});

test('estimateRun: 不正な引数を拒否する', () => {
  assert.throws(() => estimateRun({ workers: 0, rounds: 5 }), RangeError);
  assert.throws(() => estimateRun({ workers: 2, rounds: 0 }), RangeError);
  assert.throws(() => estimateRun({ workers: 2, rounds: 5, verifiers: 0 }), RangeError);
  assert.throws(() => estimateRun({}), RangeError);
});

test('maxWorkersWithin: 予算に収まる最大の台数を返し、1 体増やすと超える', () => {
  const rounds = 8;
  const n = maxWorkersWithin(50, { rounds });
  assert.ok(n >= 1);
  assert.ok(estimateRun({ workers: n, rounds }).usd <= 50);
  assert.ok(estimateRun({ workers: n + 1, rounds }).usd > 50);
});

test('maxWorkersWithin: 予算が小さすぎれば 0', () => {
  assert.equal(maxWorkersWithin(0.00001, { rounds: 10 }), 0);
  assert.throws(() => maxWorkersWithin(0, { rounds: 10 }), RangeError);
  assert.throws(() => maxWorkersWithin(-5, { rounds: 10 }), RangeError);
});

test('1000 体の見積もりが実際に出せる（記事の「予算が許すなら」に数字で答える）', () => {
  const e = estimateRun({ workers: 1000, rounds: 6, models: { coordinator: 'gemini-4-carbon', worker: 'gemini-4-argon', verifier: 'gemini-4-carbon' } });
  assert.equal(e.agents, 1002);
  assert.ok(e.usd > 0 && Number.isFinite(e.usd));
  assert.ok(e.calls > 1000);
});

// ---------- 実行中のガード ----------

test('CostGovernor: 消化率に応じて continue → warn → downgrade → stop と上がる', () => {
  const g = new CostGovernor({ budgetUsd: 10 });
  assert.equal(g.check().action, 'continue');
  g.record({ agent: '@worker-1', role: 'worker', usd: 5.0 });
  assert.equal(g.check().action, 'continue', '50% ではまだ何も言わない');
  g.record({ agent: '@worker-1', role: 'worker', usd: 1.5 });
  assert.equal(g.check().action, 'warn', '65% で警告');
  g.record({ agent: '@worker-1', role: 'worker', usd: 2.0 });
  assert.equal(g.check().action, 'downgrade', '85% で降格を勧める');
  g.record({ agent: '@worker-1', role: 'worker', usd: 2.0 });
  assert.equal(g.check().action, 'stop', '使い切ったら止める');
});

test('CostGovernor: 着地見込みが予算を超えるなら、使い切る前に downgrade を出す', () => {
  const g = new CostGovernor({ budgetUsd: 10, plannedRounds: 10 });
  for (const round of [1, 2]) g.record({ agent: '@worker-1', role: 'worker', usd: 1.2, round });
  const c = g.check();
  assert.equal(c.action, 'downgrade');
  assert.ok(c.projected > 10, '着地見込みが出ている');
  assert.ok(c.ratio < 0.5, 'まだ半分も使っていない段階で警告できる');
});

test('CostGovernor: 1 体あたりの上限を超えたら止める', () => {
  const g = new CostGovernor({ budgetUsd: 100, perAgentUsd: 2 });
  g.record({ agent: '@worker-1', role: 'worker', usd: 2.5 });
  g.record({ agent: '@worker-2', role: 'worker', usd: 0.5 });
  const c = g.check();
  assert.equal(c.action, 'stop');
  assert.deepEqual(c.overAgents, ['@worker-1']);
});

test('CostGovernor: 降格は worker から始め、判断役を最後まで残す', () => {
  const g = new CostGovernor({ budgetUsd: 10 });
  const m0 = { coordinator: 'claude-opus-5', worker: 'claude-opus-5', verifier: 'claude-opus-5' };
  const a = g.downgradePlan(m0);
  assert.equal(a.role, 'worker');
  assert.equal(a.models.worker, 'claude-sonnet-5');
  const b = g.downgradePlan(a.models);
  assert.equal(b.role, 'coordinator', '次は監督役');
  const c = g.downgradePlan(b.models);
  assert.equal(c.role, 'verifier', '検証役は最後');
  const d = g.downgradePlan(c.models);
  assert.equal(d.changed, false, '同じ役割を二度は落とさない');
});

test('CostGovernor: トークンから自力で課金額を出せる', () => {
  const g = new CostGovernor({ budgetUsd: 100 });
  const usd = g.record({ agent: '@w', role: 'worker', model: 'claude-sonnet-5', input_tokens: 1e6, output_tokens: 0 });
  assert.equal(usd, 3);
  assert.equal(g.summary().spent, 3);
});

test('CostGovernor: 不正な設定を拒否する', () => {
  assert.throws(() => new CostGovernor({ budgetUsd: 0 }), RangeError);
  assert.throws(() => new CostGovernor({ budgetUsd: 10, warnAt: 0.9, downgradeAt: 0.5 }), RangeError);
  assert.throws(() => new CostGovernor({ budgetUsd: 10, downgradeAt: 1.2 }), RangeError);
});

test('CostGovernor: summary は役割・エージェント・ラウンドで割れる', () => {
  const g = new CostGovernor({ budgetUsd: 100 });
  g.record({ agent: '@coordinator', role: 'coordinator', usd: 1, round: 1 });
  g.record({ agent: '@worker-1', role: 'worker', usd: 2, round: 1 });
  g.record({ agent: '@worker-1', role: 'worker', usd: 3, round: 2 });
  const s = g.summary();
  assert.equal(s.spent, 6);
  assert.equal(s.byRole[0].role, 'worker');
  assert.equal(s.byAgent[0].agent, '@worker-1');
  assert.deepEqual(s.byRound.map((r) => r.round), [1, 2]);
  assert.equal(s.byRound[1].usd, 3);
});

// ---------- 走ったあとの分析 ----------

const board = (...rows) => rows.map((r, i) => JSON.stringify({
  seq: i + 1, id: `p_${String(i + 1).padStart(4, '0')}`, ts: new Date(Date.UTC(2026, 10, 11, 4, 0, i)).toISOString(),
  to: [], subject: 's', ...r,
})).join('\n');

test('reportBoard: 役割別のコストを集計する', () => {
  const text = board(
    { from: '@coordinator', type: 'assign', task_id: 'T1', cost: { model: 'claude-opus-5', input_tokens: 10000, output_tokens: 1000, usd: 0.2 }, meta: { round: 1 } },
    { from: '@worker-1', type: 'done', to: ['@verifier'], cost: { model: 'claude-sonnet-5', input_tokens: 20000, output_tokens: 3000, usd: 0.1 }, meta: { round: 2 } },
    { from: '@verifier', type: 'verify_result', verdict: 'pass', ref: 'p_0002', cost: { model: 'claude-opus-5', input_tokens: 30000, output_tokens: 500, usd: 0.5 }, meta: { round: 3 } },
  );
  const r = reportBoard(text);
  assert.equal(r.posts, 3);
  assert.equal(r.spent, 0.8);
  assert.equal(r.byRole[0].role, 'verifier');
  assert.equal(r.costPerPass, 0.8);
  assert.deepEqual(r.byRound.map((x) => x.round), [1, 2, 3]);
});

test('reportBoard: 検証にコストが偏っていれば指摘する', () => {
  const text = board(
    { from: '@worker-1', type: 'done', to: ['@verifier'], cost: { model: 'claude-sonnet-5', usd: 0.1 } },
    { from: '@verifier', type: 'verify_result', verdict: 'pass', ref: 'p_0001', cost: { model: 'claude-opus-5', usd: 0.9 } },
  );
  const r = reportBoard(text);
  assert.ok(r.advice.some((a) => a.what.includes('検証に全体の')));
  assert.ok(r.advice.every((a) => a.level === 'ok' || a.how.length > 0), '指摘には必ず対処法を付ける');
});

test('reportBoard: 差し戻しゼロを警告する', () => {
  const text = board(
    { from: '@worker-1', type: 'done', to: ['@verifier'], cost: { model: 'claude-sonnet-5', usd: 0.5 } },
    { from: '@verifier', type: 'verify_result', verdict: 'pass', ref: 'p_0001', cost: { model: 'claude-sonnet-5', usd: 0.2 } },
  );
  assert.ok(reportBoard(text).advice.some((a) => a.what.includes('差し戻しが 1 件もありません')));
});

test('reportBoard: 壊れた行があってもコスト分析は続く', () => {
  const text = board({ from: '@worker-1', type: 'done', to: ['@verifier'], cost: { model: 'mock', usd: 1 } }) + '\nこわれた行\n';
  const r = reportBoard(text);
  assert.equal(r.posts, 1);
  assert.equal(r.spent, 1);
});

test('reportBoard: 価格表に無いモデルを報告する', () => {
  const text = board({ from: '@worker-1', type: 'done', to: ['@verifier'], cost: { model: 'future-model-9', input_tokens: 1000, output_tokens: 100 } });
  assert.deepEqual(reportBoard(text).unknownModels, ['future-model-9']);
});

test('reportBoard: 空のボードでも落ちない', () => {
  const r = reportBoard('');
  assert.equal(r.posts, 0);
  assert.equal(r.spent, 0);
  assert.equal(r.costPerPass, null);
  assert.ok(r.advice.length > 0);
});
