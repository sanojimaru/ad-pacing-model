# 時間帯配信（Dayparting）向け 動的ペーシング仕様

（残り時間正規化 × hourly budget rate 活用 + 残り時間連動補正）

## 0. 背景と課題

現行のペーシングは「1日（24h）を通した hourly budget rate（時間別トラフィック割合）」を参照して、各時間に使ってよい予算割合を決定している。

しかし **時間帯指定配信（dayparting）**では「配信できない時間」が存在するため、全日の rate を前提にした累積配分が成立しない。
結果として以下が起きやすい。

* 序盤に使い切る／終盤に残りすぎる
* 配信できない（入札負け・在庫不足）時間があると未消化が出る
* 短時間帯では 1時間のズレが致命的になる

さらに、残予算の再配分だけでは以下の課題が残る。

* 配信遅れが発生しても未消化分が次時間以降に十分強く反映されない
* 残り時間が少ないのに補正強度が一定のため、終盤で追いつけないことがある

## 1. 目的

時間帯指定配信において、

* **hourly budget rate の形状（ピーク/谷）を活かし**
* **残り配信可能時間と残予算**を使って毎時間リプランし
* **なるべく予算を使い切る**（アンダーを減らす）
* **配信遅れが生じた場合、残り時間が少ないほど強く追い上げる**
* 終盤の無理な追い上げによる暴発や品質崩壊を避ける（安全装置）

を実現する。

## 2. 適用範囲

* **時間帯指定配信（dayparting）にのみ適用**
* 非時間帯指定（24h配信）は現行ロジックのまま
* 残り時間連動補正は時間帯配信キャンペーンにのみ適用する

## 3. 概要（ロジックの考え方）

毎時間 `now` に以下を行う。

1. dayparting の「配信対象時間（E）」を作る
2. 現在以降の「残り配信対象時間（E_remaining）」を作る
3. `E_remaining` に含まれる hourly budget rate だけで **再正規化（targetRate）**する
4. **残予算（RemainingBudget）**を targetRate に従って当該時間へ割り当て、
   **ベース配分（BaseBudget）**を得る
5. **目標累積消化額（TargetCum）**と**実績累積消化額（ActualCum）**の差（Slack）を算出する
6. 残り配信可能時間数（H_left）に応じた補正係数（alpha）を用いて、
   **補正後の目標時間予算（TargetHourlyBudget）**を得る
7. 必要に応じて **Spend Capacity**（実配信能力の上限）でキャップし、
   **最終的な当該時間予算（HourlyBudget）**を決定する

---

## 4. 用語と変数定義

## 4.1 時間

* `h`: 時間（0〜23 の整数）
* `now`: 現在の時間（0〜23 の整数）

※ UTCで持っている場合は、先に日付境界と時刻（hour）を揃えたうえで本ロジックを適用する。

## 4.2 予算

* `DailyBudget`：そのキャンペーンの当日予算（非予算）
* `UsedBudget`：当日これまでに消化した予算
* `RemainingBudget`：当日残り予算

[
RemainingBudget = \max(0,\ DailyBudget - UsedBudget)
]

## 4.3 hourly budget rate

* `rate_h`：時間 `h` が入札可能トラフィック全体に占める割合（毎日更新、非負）

例：`rate_10=0.06, rate_11=0.07 ...`

## 4.4 配信対象時間（dayparting）

* `E`：配信可能時間の集合

  * 例：10:00–13:00（終了境界）なら `E={10,11,12}`
  * 例：23:00–02:00 なら `E={23,0,1}`

## 4.5 残り配信対象時間

* `E_remaining`：現在 `now` 以降の配信対象時間集合

  * 例：`E={10,11,12}`, `now=11` → `E_remaining={11,12}`

## 4.6 残り配信可能時間数

* `H_left = |E_remaining|`

## 4.7 目標累積消化額・実績累積消化額・差分

* `TargetCum(now)`：現在時刻開始時点までに本来消化しているべき目標累積消化額
* `ActualCum(now)`：当日開始から現在時刻開始時点までの実績累積消化額（= `UsedBudget`）
* `Slack(now) = TargetCum(now) - ActualCum(now)`
  * `Slack > 0`：配信遅れ
  * `Slack < 0`：配信進みすぎ

## 4.8 補正係数

* `alpha(now)`：残り時間連動補正係数（`0 < alpha ≤ 1`）
* `k`：補正強度パラメータ。配信対象時間数 `|E|` から動的に算出される（§5.6 参照）

## 4.9 前倒し配信係数（Front-loading）

* `frontloadRate`：配信序盤に目標消化ペースをやや前倒しにするための係数（`frontloadRate ≥ 1`）
* 配信対象時間数 `|E|` から動的に算出される（§5.4 参照）
* 短時間帯ほど前倒し効果が大きく、長時間帯では効果が小さくなる

---

## 5. 計算式

## 5.1 残り配信時間における rate 合計

[
R = \sum_{h \in E_{remaining}} rate_h
]

* `R`：残り配信時間の rate 合計

## 5.2 target rate（残り時間で再正規化した比率）

[
targetRate_{now} = \frac{rate_{now}}{R}
\quad (R > 0)
]

### フォールバック（R=0 の場合）

[
targetRate_{now} = \frac{1}{|E_{remaining}|}
]

## 5.3 ベース配分（BaseBudget）

[
BaseBudget = RemainingBudget \times targetRate_{now}
]

* `BaseBudget`：残り時間の rate 形状に従った当該時間の配分額（補正前）

## 5.4 目標累積消化額（TargetCum）と前倒し配信（Front-loading）

配信対象時間 E 全体で正規化した rate を用いて、当日の目標累積消化曲線を定義する。
さらに `frontloadRate` を乗じることで、序盤のペースをやや前倒しにし、終盤の未消化リスクを低減する。

### frontloadRate の算出

[
frontloadRate = 1 + 0.15 \times \sqrt{\frac{5}{|E|}}
]

| |E|（配信対象時間数） | frontloadRate |
|------:|--------------:|
| 2     |         1.237 |
| 5     |         1.150 |
| 12    |         1.097 |
| 24    |         1.068 |

* `|E|` が小さい（短時間帯）ほど前倒し効果が強い
* `|E|=5` で基準値 1.150

### TargetCum の算出

[
R_{all} = \sum_{h \in E} rate_h
]

[
targetCumRatio = \frac{\displaystyle\sum_{h \in E,\ h \prec now} rate_h}{R_{all}}
]

[
TargetCum(now) = \min\!\left(DailyBudget,\ DailyBudget \times targetCumRatio \times frontloadRate\right)
]

※ `h ≺ now` は `E` の順序上 `now` より前の時間を表す（跨ぎ配信でも順序を維持する）。
※ `min(DailyBudget, ...)` により、前倒し補正で日予算を超えないようにクランプする。

### フォールバック（R_all = 0 の場合）

[
targetCumRatio = \frac{|\{h \in E \mid h \prec now\}|}{|E|}
]

[
TargetCum(now) = \min\!\left(DailyBudget,\ DailyBudget \times targetCumRatio \times frontloadRate\right)
]

## 5.5 差分（Slack）

[
Slack(now) = TargetCum(now) - UsedBudget
]

## 5.6 残り時間連動補正係数（alpha）と動的 k

### k の動的算出

[
k = 1.5 \times \sqrt{\frac{5}{|E|}}
]

| |E|（配信対象時間数） | k     |
|------:|------:|
| 2     | 2.372 |
| 5     | 1.500 |
| 12    | 0.968 |
| 24    | 0.685 |

* `|E|=5` で基準値 k=1.5 を維持
* 短時間帯では k が大きくなり、補正が強く効く
* 長時間帯では k が小さくなり、補正が穏やかになる

### alpha の算出

[
\alpha(now) = \min\!\left(1,\ \frac{k}{H_{left}}\right)
]

| H_left | alpha (k=1.5, \|E\|=5) |
|-------:|--------------:|
| 1      |          1.00 |
| 2      |          0.75 |
| 3      |          0.50 |
| 6      |          0.25 |

## 5.7 補正後の目標時間予算（TargetHourlyBudget）

[
TargetHourlyBudget = BaseBudget + \alpha(now) \times Slack(now)
]

## 5.8 最終予算（HourlyBudget）

負値防止および残予算超過防止のためクランプする。

[
HourlyBudget = \min\!\left(RemainingBudget,\ \max(0,\ TargetHourlyBudget)\right)
]

## 5.9 Spend Capacity による上限制御（推奨）

時間 `h` に「現実的に消化可能な上限」を `SpendCapacity_h` とする。
（例：過去同曜日×同時間の spend 実績 P90）

適用する場合は 5.8 の後にさらに制限する。

[
HourlyBudget = \min\!\left(HourlyBudget,\ SpendCapacity_{now}\right)
]

※ SpendCapacity を導入しない場合は省略してよいが、終盤の暴発を防ぐ意味で導入を推奨。

**重要：Slack 補正後の SpendCapacity 再適用**

§5.7 の Slack 補正（`TargetHourlyBudget = BaseBudget + alpha × Slack`）により、BaseBudget 算出時に適用された SpendCapacity を超える値が設定される場合がある。
そのため、§5.8 のクランプ後に **必ず** §5.9 の SpendCapacity を再適用すること。
処理順序は以下のとおり：

1. §5.7: Slack 補正 → TargetHourlyBudget
2. §5.8: クランプ → `[0, RemainingBudget]`
3. §5.9: SpendCapacity キャップ → 最終 HourlyBudget

この順序により、Slack 補正で膨らんだ予算が SpendCapacity を超えることを防ぐ。

---

## 6. 特徴（期待される挙動）

* **hourly budget rate の形状を維持**：ピーク時間に自然に予算が寄る
* **残り時間を考慮して毎時リプラン**：遅れ/進みが残予算に反映され、残り時間へ再配分される
* **daypartingでも成立**：配信可能時間だけで正規化するため、短時間帯・跨ぎ時間帯でも一貫して動作
* **残り時間連動補正**：配信遅れ時に残り時間が少ないほど追い上げが強まり、予算の使い切りが改善する
* **安全性**：HourlyBudget を `[0, RemainingBudget]` にクランプ。SpendCapacity により追加の上限制御も可能

---

## 7. 処理フロー（毎時間）

1. `RemainingBudget = max(0, DailyBudget - UsedBudget)`
2. `E = dayparting から配信対象時間を作る`
3. `E_remaining = now 以降の E`
4. `H_left = |E_remaining|`
5. `R = sum(rate[h]) for h in E_remaining`
6. `targetRate_now = rate[now] / R`（R=0なら均等）
7. `BaseBudget = RemainingBudget × targetRate_now`
8. `frontloadRate = 1 + 0.15 × √(5/|E|)` を算出
9. `targetCumRatio = sum(rate[h] for h in E, h ≺ now) / R_all`
10. `TargetCum(now) = min(DailyBudget, DailyBudget × targetCumRatio × frontloadRate)`
11. `Slack = TargetCum(now) - UsedBudget`
12. `k = 1.5 × √(5/|E|)` を動的に算出
13. `alpha = min(1, k / H_left)`（時間帯配信のみ）
14. `TargetHourlyBudget = BaseBudget + alpha × Slack`
15. `HourlyBudget = clamp(TargetHourlyBudget, 0, RemainingBudget)`
16. `HourlyBudget = min(HourlyBudget, SpendCapacity[now])`（**Slack 補正後にも必ず適用**）
17. `HourlyBudget` を当該時間の上限として配信制御へ渡す

---

## 8. TypeScript 実装例

```ts
/**
 * Dayparting（時間帯配信）向け：残り時間正規化 + 残り時間連動補正
 *
 * 目的：
 * - hourly budget rate の形状を活かしつつ残予算を残り時間で再配分
 * - 配信遅れが生じた場合、残り時間が少ないほど補正を強めて予算を使い切る
 * - HourlyBudget を [0, RemainingBudget] にクランプして安全装置とする
 *
 * 適用条件：
 * - startHour !== endHour（時間帯指定配信）のときのみ補正を適用する
 * - 非時間帯配信（startHour === endHour）は baseBudget をそのまま使用する
 */

export interface RemainingTimeAdjustmentParams {
  dailyBudget: number
  usedBudget: number
}

export interface AdjustmentDetail {
  baseBudget: number
  targetCum: number
  actualCum: number
  slack: number
  hLeft: number
  k: number
  frontloadRate: number
  alpha: number
  targetHourlyBudget: number
  adjustedBudget: number
}

/** 累積 rate 配列（24要素）→ 時間別 rate 配列に変換 */
export function toHourlyRate(cumulative: number[]): number[] {
  return Array.from({ length: 24 }, (_, h) =>
    h === 0 ? cumulative[0] : cumulative[h] - cumulative[h - 1]
  )
}

/**
 * 指定時間 h の BaseBudget を計算する。
 * remainingRateSum は呼び出し元で一度だけ計算して渡す。
 */
export function computeBudgetForHour(
  h: number,
  remainingHours: number[],
  remainingRateSum: number,
  hourlyRate: number[],
  remainingBudget: number,
  spendCapacity?: number[]
): { normalizedRate: number; targetBudget: number; budget: number; capped: boolean } {
  const normalizedRate = remainingRateSum > 0
    ? hourlyRate[h] / remainingRateSum
    : 1 / remainingHours.length
  const targetBudget = remainingBudget * normalizedRate
  const capacity = spendCapacity?.[h] ?? Infinity
  const budget = Math.min(targetBudget, capacity)
  return { normalizedRate, targetBudget, budget, capped: budget < targetBudget }
}

/**
 * 全残り時間分の予算配列を返すメイン関数。
 * remainingTimeAdjustment を渡すと nowHour の予算に残り時間連動補正を適用する。
 */
export function calculateHourlyBudget({
  cumulativeRates,
  startHour,
  endHour,
  nowHour,
  remainingBudget,
  spendCapacity,
  remainingTimeAdjustment,
}: {
  cumulativeRates: number[]
  startHour: number
  endHour: number
  nowHour: number
  remainingBudget: number
  spendCapacity?: number[]
  remainingTimeAdjustment?: RemainingTimeAdjustmentParams
}) {
  // 1. 累積 rate → 時間別 rate
  const hourlyRate = toHourlyRate(cumulativeRates)

  // 2. 配信対象時間 E（跨ぎ対応）
  const eligibleHours: number[] = []
  if (startHour === endHour) {
    for (let h = 0; h < 24; h++) eligibleHours.push(h)
  } else if (startHour < endHour) {
    for (let h = startHour; h < endHour; h++) eligibleHours.push(h)
  } else {
    for (let h = startHour; h < 24; h++) eligibleHours.push(h)
    for (let h = 0; h < endHour; h++) eligibleHours.push(h)
  }

  // 3. 残り配信時間 E_remaining（順序保持）
  const idx = eligibleHours.indexOf(nowHour)
  const remainingHours = idx === -1 ? [] : eligibleHours.slice(idx)

  if (remainingHours.length === 0 || remainingBudget <= 0) {
    return {
      hourlyRate,
      normalizedHourlyRate: Array(24).fill(0),
      eligibleHours,
      remainingHours,
      remainingRateSum: 0,
      hourlyBudget: Array(24).fill(0),
      cappedByCapacity: Array(24).fill(false),
      reason: remainingHours.length === 0 ? "not_eligible" : "no_budget",
      adjustmentDetail: undefined as AdjustmentDetail | undefined,
    }
  }

  // 4. 残り rate 合計 R
  const remainingRateSum = remainingHours.reduce((sum, h) => sum + hourlyRate[h], 0)

  // 5–7. 残り時間ごとに BaseBudget を計算（SpendCapacity 込み）
  const hourlyBudget: number[] = Array(24).fill(0)
  const normalizedHourlyRate: number[] = Array(24).fill(0)
  const cappedByCapacity: boolean[] = Array(24).fill(false)

  remainingHours.forEach(h => {
    const { normalizedRate, budget, capped } = computeBudgetForHour(
      h, remainingHours, remainingRateSum, hourlyRate, remainingBudget, spendCapacity
    )
    normalizedHourlyRate[h] = normalizedRate
    hourlyBudget[h] = budget
    cappedByCapacity[h] = capped
  })

  // 8–16. 残り時間連動補正（時間帯配信のみ: startHour !== endHour）
  let adjustmentDetail: AdjustmentDetail | undefined
  if (remainingTimeAdjustment && startHour !== endHour) {
    const { dailyBudget, usedBudget } = remainingTimeAdjustment
    const hLeft = remainingHours.length
    const eSize = eligibleHours.length

    // 動的 k = 1.5 × √(5/|E|)
    const k = 1.5 * Math.sqrt(5 / eSize)

    // frontloadRate = 1 + 0.15 × √(5/|E|)
    const frontloadRate = 1 + 0.15 * Math.sqrt(5 / eSize)

    // BaseBudget（既存計算値）
    const baseBudget = hourlyBudget[nowHour]

    // TargetCum(now): E の順序上 nowHour より前の rate 合計で算出（跨ぎ対応）
    const hoursBeforeNow = eligibleHours.slice(0, idx)
    const totalEligibleRate = eligibleHours.reduce((sum, h) => sum + hourlyRate[h], 0)
    const rateBeforeNow = hoursBeforeNow.reduce((sum, h) => sum + hourlyRate[h], 0)
    const targetCumRatio = totalEligibleRate > 0
      ? rateBeforeNow / totalEligibleRate
      : hoursBeforeNow.length / eligibleHours.length
    const targetCum = Math.min(dailyBudget, dailyBudget * targetCumRatio * frontloadRate)

    // Slack
    const actualCum = usedBudget
    const slack = targetCum - actualCum

    // alpha = min(1, k / H_left)
    const alpha = Math.min(1, k / hLeft)

    // TargetHourlyBudget = BaseBudget + alpha × Slack
    const targetHourlyBudget = baseBudget + alpha * slack

    // clamp to [0, RemainingBudget]
    let adjustedBudget = Math.min(remainingBudget, Math.max(0, targetHourlyBudget))

    // Slack 補正後に SpendCapacity を再適用
    if (spendCapacity?.[nowHour] != null) {
      adjustedBudget = Math.min(adjustedBudget, spendCapacity[nowHour])
    }

    hourlyBudget[nowHour] = adjustedBudget

    adjustmentDetail = {
      baseBudget, targetCum, actualCum, slack,
      hLeft, k, frontloadRate, alpha, targetHourlyBudget, adjustedBudget,
    }
  }

  return {
    hourlyRate,
    normalizedHourlyRate,
    eligibleHours,
    remainingHours,
    remainingRateSum,
    hourlyBudget,
    cappedByCapacity,
    adjustmentDetail,
  }
}
```

---

## 9. パラメータ一覧

* **`k`**（補正強度パラメータ）: `k = 1.5 × √(5/|E|)` により動的算出。`|E|=5` で基準値 1.5
* **`frontloadRate`**（前倒し配信係数）: `frontloadRate = 1 + 0.15 × √(5/|E|)` により動的算出。`|E|=5` で基準値 1.150

---

## 10. 注意事項

* 残り時間連動補正は **時間帯配信（startHour ≠ endHour）のみ** 適用する
* 補正は **nowHour の予算のみ** に適用する（他の残り時間の配分には影響しない）
* 前時間比変化率制御・平滑化は本仕様の対象外。別機能として追加検討する
* 補正は毎時ダイレクトに反映されるため、大きな遅れがある場合は急な予算増加が起きうる。
  Spend Capacity との併用を推奨する
