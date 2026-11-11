# swarm-cost-governor

**「1000体起動とかもできちゃいそう（予算が許すなら）」に、数字で答える。**

エージェント台数 × ラウンド数 × モデルから、走らせる**前**にコストを見積もり、
走っている**間**に上限で止め、走った**あと**に無駄を指摘する。

## 走らせる前

```bash
node src/cli.mjs estimate --workers 8 --rounds 10
```

```
10 エージェント × 10 ラウンドの見積もり

  合計          $4.71
  1 体あたり    $0.4710
  呼び出し      80 回

役割別:
  worker       claude-sonnet-5         $1.77  (60 回)
  coordinator  claude-opus-5           $1.47  (10 回)
  verifier     claude-opus-5           $1.47  (10 回)

ラウンド別（掲示板が伸びるほど高くなる）:
  R 1    $0.2256  ███████████  (掲示板 0 件 / 1200 tok)
  R 5    $0.5194  █████████████████████████  (掲示板 34 件 / 7320 tok)
  R10    $0.5712  ████████████████████████████  (掲示板 40 件 / 8400 tok)

  ※ 最終ラウンドは初回の 2.5 倍。--board-window を狭めると頭打ちにできます。
```

**予算から逆に台数を出す:**

```bash
node src/cli.mjs afford --budget 50 --rounds 8 \
  --worker-model gemini-4-argon --coordinator-model gemini-4-carbon --verifier-model gemini-4-carbon
```

```
予算 $50.00 / 8 ラウンドなら worker は最大 2210 体
  実際の見積もり $49.97（2212 エージェント）
  参考: 同じ条件で 1000 体なら $22.87
```

安いモデルを worker に使えば、**1000 体 × 8 ラウンドでも $23 程度**。
「予算が許すなら」の実際のラインはこのあたりにある。

## 掲示板型の構造的な弱点

掲示板で協調する方式には、台数以外にもうひとつコスト要因がある。
**投稿が増えるほど、全員のプロンプトが長くなる。**

台数 N・ラウンド R の呼び出し回数は O(N × R) だが、入力トークンは掲示板の蓄積ぶんだけ増えるので、
素朴に組むと実質 O(N × R²) に近づく。上の見積もりで後半のラウンドが高いのはこれが理由。

`--board-window`（プロンプトに載せる直近投稿数）で頭打ちにできる。
上の例では 40 件で止まるので、R6 以降は横ばいになっている。

## 走っている間

```js
import { CostGovernor } from 'swarm-cost-governor';

const gov = new CostGovernor({ budgetUsd: 20, plannedRounds: 12, perAgentUsd: 3 });

gov.record({ agent: '@worker-1', role: 'worker', model: 'claude-sonnet-5',
             input_tokens: 24000, output_tokens: 1800, round: 3 });

const c = gov.check();
if (c.action === 'downgrade') {
  const plan = gov.downgradePlan(models);   // worker → coordinator → verifier の順で落とす
  console.warn(c.reason, `${plan.role}: ${plan.from} → ${plan.to}`);
} else if (c.action === 'stop') {
  runner.abort();
}
```

| action | いつ |
|--------|------|
| `continue` | 予算内 |
| `warn` | 60% 消化 |
| `downgrade` | 80% 消化、**または着地見込みが予算を超えた時点** |
| `stop` | 使い切った / 1 体あたりの上限を超えた |

**着地見込みで早めに動くのが肝。** 使い切ってから止めると、作りかけの成果が検証されないまま捨てられる。
まだ 24% しか使っていない段階でも、このペースなら超えると分かれば降格を勧める。

降格は **worker → coordinator → verifier** の順。
手を動かす役は安いモデルでも通ることが多いが、判断と検証の質を落とすと差し戻しが増えて逆に高くつく。

## 走ったあと

```bash
node src/cli.mjs report runs/xxx/board.jsonl
```

役割別の内訳、合格 1 件あたりの単価、そして所見が出る。

| 所見 | 意味 |
|------|------|
| 検証に全体の 45% 超 | verifier が掲示板全体を毎回読み直している |
| 監督役に 40% 超 | 分解が終わったあとも全文を読んでいる |
| 実作業が 35% 未満 | 調整のオーバーヘッドが実作業を上回っている。分割が細かすぎる |
| ラウンド単価が 3 倍以上に膨張 | 掲示板が伸びすぎ。窓を絞るか古い投稿を畳む |
| **差し戻しが 1 件もない** | 受入基準が緩いか、verifier が実際には確かめていない |

指摘には必ず「なぜ」と「どうする」が付く（テストで固定してある）。

## 価格表

`src/pricing.json` に 1M トークンあたりの USD を置いている。
**価格は頻繁に変わるので、使う前に各社の公式ページで確認して上書きすること。**
同梱の値は見積もりの初期値にすぎない。

価格表に無いモデルは、最安ではなく**保守的な既定値**（capable 相当）で計算する。
安く見積もって驚くより、高く見積もって安く済むほうがよい。

```bash
node src/cli.mjs models   # 現在の価格表を表示
```

## 開発

```bash
node --test "test/*.test.mjs"   # 25 件
```

依存パッケージはゼロ。Node.js 20 以上。

## 関連リポジトリ

| リポジトリ | 役割 |
|-----------|------|
| [swarm-board-protocol](https://github.com/hiroshi57/swarm-board-protocol) | 掲示板の仕様と検証器 |
| [swarm-board-core](https://github.com/hiroshi57/swarm-board-core) | ランナー |
| [swarm-board-viewer](https://github.com/hiroshi57/swarm-board-viewer) | 1 ファイル HTML ビューア |
| `swarm-cost-governor` | **（これ）** 予算ガード |
| [swarm-usecase-100](https://github.com/hiroshi57/swarm-usecase-100) | 100 ユースケースと実現可能性の評価 |

## ライセンス

MIT
