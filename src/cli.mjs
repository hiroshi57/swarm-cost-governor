#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { estimateRun, maxWorkersWithin, reportBoard, PRICING } from './index.mjs';

const HELP = `
swarm-cost — 走らせる前に見積もり、走ったあとに無駄を探す

使い方:
  swarm-cost estimate --workers 8 --rounds 10 [--verifiers 2] [--worker-model ...]
  swarm-cost afford   --budget 50 --rounds 10
  swarm-cost report   <board.jsonl>
  swarm-cost models

共通オプション:
  --coordinator-model <m>   既定 claude-opus-5
  --worker-model <m>        既定 claude-sonnet-5
  --verifier-model <m>      既定 claude-opus-5
  --board-window <n>        プロンプトに載せる直近投稿数の上限（既定 40）
  --active-ratio <0-1>      毎ラウンド動くエージェントの割合（既定 0.7）
  --json                    JSON で出す
`.trim();

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const num = (n, d) => {
  const v = opt(n, null);
  if (v === null) return d;
  const x = Number(v);
  if (!Number.isFinite(x)) { console.error(`--${n} は数値である必要があります: ${v}`); process.exit(2); }
  return x;
};
const json = has('json');
const models = {
  coordinator: opt('coordinator-model', 'claude-opus-5'),
  worker: opt('worker-model', 'claude-sonnet-5'),
  verifier: opt('verifier-model', 'claude-opus-5'),
};
const shared = {
  models,
  verifiers: num('verifiers', 1),
  boardWindow: num('board-window', 40),
  activeRatio: num('active-ratio', 0.7),
};
const usd = (n) => '$' + n.toFixed(n < 1 ? 4 : 2);

if (!cmd || has('help') || cmd === 'help') { console.log(HELP); process.exit(cmd ? 0 : 2); }

if (cmd === 'models') {
  console.log(`価格表（1M トークンあたり USD・${PRICING._updated} 時点の参考値）`);
  console.log(PRICING._note + '\n');
  for (const [m, p] of Object.entries(PRICING.models)) {
    console.log(`  ${m.padEnd(20)} in ${String(p.input).padStart(6)}  out ${String(p.output).padStart(6)}  ${p.tier}`);
  }
  process.exit(0);
}

if (cmd === 'estimate') {
  const workers = num('workers', null);
  const rounds = num('rounds', null);
  if (workers === null || rounds === null) { console.error('--workers と --rounds が必要です'); process.exit(2); }
  const e = estimateRun({ ...shared, workers, rounds });
  if (json) { console.log(JSON.stringify(e, null, 2)); process.exit(0); }

  console.log(`\n${e.agents} エージェント × ${rounds} ラウンドの見積もり\n`);
  console.log(`  合計          ${usd(e.usd)}`);
  console.log(`  1 体あたり    ${usd(e.usdPerAgent)}`);
  console.log(`  呼び出し      ${e.calls} 回`);
  console.log(`  トークン      in ${(e.input_tokens / 1e6).toFixed(2)}M / out ${(e.output_tokens / 1e6).toFixed(2)}M`);
  console.log('\n役割別:');
  for (const r of e.byRole) console.log(`  ${r.role.padEnd(12)} ${r.model.padEnd(18)} ${usd(r.usd).padStart(10)}  (${r.calls} 回)`);
  console.log('\nラウンド別（掲示板が伸びるほど高くなる）:');
  const peak = Math.max(...e.perRound.map((r) => r.usd));
  for (const r of e.perRound) {
    const bar = '█'.repeat(Math.max(1, Math.round((r.usd / peak) * 28)));
    console.log(`  R${String(r.round).padStart(2)}  ${usd(r.usd).padStart(9)}  ${bar}  (掲示板 ${r.boardPosts} 件 / ${r.promptTokens} tok)`);
  }
  const last = e.perRound.at(-1), first = e.perRound[0];
  if (last.usd / first.usd > 2) {
    console.log(`\n  ※ 最終ラウンドは初回の ${(last.usd / first.usd).toFixed(1)} 倍。--board-window を狭めると頭打ちにできます。`);
  }
  console.log('\n' + PRICING._note);
  process.exit(0);
}

if (cmd === 'afford') {
  const budget = num('budget', null);
  const rounds = num('rounds', null);
  if (budget === null || rounds === null) { console.error('--budget と --rounds が必要です'); process.exit(2); }
  const w = maxWorkersWithin(budget, { ...shared, rounds });
  if (json) { console.log(JSON.stringify({ budgetUsd: budget, rounds, maxWorkers: w, ...shared }, null, 2)); process.exit(0); }
  if (w === 0) {
    console.log(`\n予算 ${usd(budget)} では worker 1 体でも ${rounds} ラウンド回せません。`);
    console.log(`  worker 1 体のとき ${usd(estimateRun({ ...shared, workers: 1, rounds }).usd)} かかります。`);
    process.exit(0);
  }
  const e = estimateRun({ ...shared, workers: w, rounds });
  console.log(`\n予算 ${usd(budget)} / ${rounds} ラウンドなら worker は最大 ${w} 体\n`);
  console.log(`  実際の見積もり ${usd(e.usd)}（${e.agents} エージェント）`);
  console.log(`  1 体あたり     ${usd(e.usdPerAgent)}`);
  const w1000 = estimateRun({ ...shared, workers: 1000, rounds }).usd;
  console.log(`\n  参考: 同じ条件で 1000 体なら ${usd(w1000)}`);
  process.exit(0);
}

if (cmd === 'report') {
  const file = argv[1];
  if (!file) { console.error('使い方: swarm-cost report <board.jsonl>'); process.exit(2); }
  const r = reportBoard(readFileSync(file, 'utf8'));
  if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }

  console.log(`\n${file}  —  ${r.posts} 投稿 / ${r.calls} 呼び出し / ${usd(r.spent)}\n`);
  if (r.spent === 0) console.log('  cost が記録されていない投稿ばかりです（mock 実行の可能性）。\n');
  if (r.byRole.length) {
    console.log('役割別:');
    const total = r.spent || 1;
    for (const x of r.byRole) {
      const pct = Math.round((x.usd / total) * 100);
      console.log(`  ${x.role.padEnd(12)} ${usd(x.usd).padStart(10)}  ${String(pct).padStart(3)}%  ${'█'.repeat(Math.round(pct / 3))}`);
    }
  }
  if (r.costPerPass !== null) console.log(`\n合格 1 件あたり ${usd(r.costPerPass)}`);
  if (r.unknownModels.length) console.log(`\n価格表に無いモデル: ${r.unknownModels.join(', ')}（保守的な既定値で計算しています）`);
  console.log('\n所見:');
  for (const a of r.advice) {
    const mark = { warn: '!', info: '-', ok: '✓' }[a.level] ?? '-';
    console.log(`  ${mark} ${a.what}`);
    if (a.why) console.log(`      なぜ: ${a.why}`);
    if (a.how) console.log(`      どうする: ${a.how}`);
  }
  process.exit(0);
}

console.error(`未知のコマンド '${cmd}'\n\n${HELP}`);
process.exit(2);
