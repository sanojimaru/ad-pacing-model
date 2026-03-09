/**
 * pacing.spec.ts
 * 残り時間連動方式 受け入れテスト
 *
 * Run: npx vitest pacing.spec.ts
 */

import { describe, it, expect } from 'vitest'
import { calculateHourlyBudget } from './pacing'

// 既存 pacing.ts と同じ累積レート
const cumulativeRates = [
  0.02,0.03,0.04,0.04,0.05,0.06,0.09,0.13,
  0.17,0.22,0.27,0.33,0.40,0.47,0.52,0.59,
  0.65,0.73,0.80,0.87,0.92,0.97,1,1,
]

/**
 * 共通ヘルパー: startHour=10, endHour=15 の時間帯配信で
 * nowHour=12 の hourlyBudget[12] を取り出す
 */
function runAt12(usedBudget: number, dailyBudget = 100_000) {
  const remainingBudget = dailyBudget - usedBudget
  return calculateHourlyBudget({
    cumulativeRates,
    startHour: 10,
    endHour: 15,
    nowHour: 12,
    remainingBudget,
    remainingTimeAdjustment: { dailyBudget, usedBudget },
  })
}

// ---------------------------------------------------------------------------
// 受け入れ条件 1: 時間帯配信のみに新ロジックが適用される
// ---------------------------------------------------------------------------
describe('AC1: 時間帯配信のみに適用される', () => {
  it('時間帯配信では adjustmentDetail が返る', () => {
    const result = runAt12(20_000)
    expect(result.adjustmentDetail).toBeDefined()
  })

  it('非時間帯配信（startHour===endHour）では adjustmentDetail が undefined', () => {
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 0,
      endHour: 0, // 全日 = 非dayparting
      nowHour: 12,
      remainingBudget: 80_000,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 20_000 },
    })
    expect(result.adjustmentDetail).toBeUndefined()
  })

  it('remainingTimeAdjustment 未指定でも adjustmentDetail が undefined（既存動作の維持）', () => {
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 10,
      endHour: 15,
      nowHour: 12,
      remainingBudget: 50_000,
    })
    expect(result.adjustmentDetail).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 受け入れ条件 2: 配信遅れ時に Slack>0 となり BaseBudget より増加する
// ---------------------------------------------------------------------------
describe('AC2: Slack>0 のとき HourlyBudget > BaseBudget', () => {
  it('配信遅れ(usedBudget=20000)のとき hourlyBudget > baseBudget', () => {
    const result = runAt12(20_000)
    const d = result.adjustmentDetail!
    // targetCum = 100000 * (0.05+0.06) / (0.05+0.06+0.07+0.07+0.05) = 36666.67
    expect(d.slack).toBeGreaterThan(0)
    expect(result.hourlyBudget[12]).toBeGreaterThan(d.baseBudget)
  })

  it('Slack の値が正しく計算される (targetCum≈42167, actualCum=20000)', () => {
    const result = runAt12(20_000)
    const d = result.adjustmentDetail!
    expect(d.targetCum).toBeCloseTo(42_166.67, 0)
    expect(d.actualCum).toBe(20_000)
    expect(d.slack).toBeCloseTo(22_166.67, 0)
  })

  it('補正後の hourlyBudget が正しい (baseBudget≈29474, alpha=0.5)', () => {
    // baseBudget = 80000 * (0.07/0.19) ≈ 29473.68
    // targetHourlyBudget ≈ 29474 + 0.5*22167 ≈ 40557
    const result = runAt12(20_000)
    expect(result.hourlyBudget[12]).toBeCloseTo(40_557, 0)
  })
})

// ---------------------------------------------------------------------------
// 受け入れ条件 3: 残り配信可能時間が少ないほど alpha が大きくなる
// ---------------------------------------------------------------------------
describe('AC3: H_left が少ないほど alpha が大きい (動的k)', () => {
  function alphaAt(nowHour: number) {
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 10,
      endHour: 15,
      nowHour,
      remainingBudget: 50_000,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 50_000 },
    })
    return result.adjustmentDetail!.alpha
  }

  it('H_left=3 (nowHour=12) → alpha=0.5', () => {
    // min(1, 1.5/3) = 0.5
    expect(alphaAt(12)).toBeCloseTo(0.5, 5)
  })

  it('H_left=2 (nowHour=13) → alpha=0.75', () => {
    // min(1, 1.5/2) = 0.75
    expect(alphaAt(13)).toBeCloseTo(0.75, 5)
  })

  it('H_left=1 (nowHour=14) → alpha=1.0', () => {
    // min(1, 1.5/1) = min(1, 1.5) = 1.0
    expect(alphaAt(14)).toBeCloseTo(1.0, 5)
  })

  it('alpha は 1.0 を超えない（k=1.5, H_left=1 でも上限 1.0）', () => {
    expect(alphaAt(14)).toBeLessThanOrEqual(1.0)
  })

  it('動的k: |E|=5 のとき k=1.5（基準値維持）', () => {
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 10,
      endHour: 15, // |E|=5
      nowHour: 12,
      remainingBudget: 50_000,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 50_000 },
    })
    expect(result.adjustmentDetail!.k).toBeCloseTo(1.5, 5)
  })

  it('動的k: |E|=2 のとき k≈2.372（短時間帯→強い補正）', () => {
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 10,
      endHour: 12, // |E|=2
      nowHour: 10,
      remainingBudget: 50_000,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 50_000 },
    })
    // k = 1.5 * sqrt(5/2) ≈ 2.3717
    expect(result.adjustmentDetail!.k).toBeCloseTo(1.5 * Math.sqrt(5 / 2), 3)
  })

  it('動的k: |E|=12 のとき k≈0.968（長時間帯→穏やかな補正）', () => {
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 6,
      endHour: 18, // |E|=12
      nowHour: 12,
      remainingBudget: 50_000,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 50_000 },
    })
    // k = 1.5 * sqrt(5/12) ≈ 0.9682
    expect(result.adjustmentDetail!.k).toBeCloseTo(1.5 * Math.sqrt(5 / 12), 3)
  })
})

// ---------------------------------------------------------------------------
// 受け入れ条件 4: HourlyBudget が 0 未満にならない
// ---------------------------------------------------------------------------
describe('AC4: HourlyBudget >= 0', () => {
  it('大幅な配信進みすぎで targetHourlyBudget が負でも 0 にクランプ', () => {
    // usedBudget=90000 → slack = 36667 - 90000 = -53333
    // baseBudget = 10000 * 7/19 ≈ 3684
    // targetHourlyBudget ≈ 3684 - 26667 = -22983 → clamp to 0
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 10,
      endHour: 15,
      nowHour: 12,
      remainingBudget: 10_000,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 90_000 },
    })
    expect(result.hourlyBudget[12]).toBeGreaterThanOrEqual(0)
    expect(result.hourlyBudget[12]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 受け入れ条件 5: HourlyBudget が RemainingBudget を超えない
// ---------------------------------------------------------------------------
describe('AC5: HourlyBudget <= RemainingBudget', () => {
  it('H_left=1 かつ大幅遅れでも remainingBudget でキャップ', () => {
    // nowHour=14, usedBudget=50000, remainingBudget=50000
    // targetCum = 100000 * 0.25/0.30 ≈ 83333
    // slack ≈ 33333, alpha=1.0
    // targetHourlyBudget = 50000 + 33333 = 83333 → clamp to 50000
    const remainingBudget = 50_000
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 10,
      endHour: 15,
      nowHour: 14,
      remainingBudget,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 50_000 },
    })
    expect(result.hourlyBudget[14]).toBeLessThanOrEqual(remainingBudget)
    expect(result.hourlyBudget[14]).toBe(remainingBudget)
  })

  it('配信遅れでも hourlyBudget は remainingBudget を超えない', () => {
    const remainingBudget = 80_000
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 10,
      endHour: 15,
      nowHour: 12,
      remainingBudget,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 20_000 },
    })
    expect(result.hourlyBudget[12]).toBeLessThanOrEqual(remainingBudget)
  })
})

// ---------------------------------------------------------------------------
// Front-loading: frontloadRate の動的算出
// ---------------------------------------------------------------------------
describe('Front-loading: frontloadRate の動的算出', () => {
  it('|E|=5 のとき frontloadRate≈1.150（基準値）', () => {
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 10,
      endHour: 15,
      nowHour: 12,
      remainingBudget: 50_000,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 50_000 },
    })
    expect(result.adjustmentDetail!.frontloadRate).toBeCloseTo(1 + 0.15 * Math.sqrt(5 / 5), 5)
  })

  it('|E|=2 のとき frontloadRate≈1.237（短時間帯→高い前倒し）', () => {
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 10,
      endHour: 12,
      nowHour: 10,
      remainingBudget: 50_000,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 50_000 },
    })
    expect(result.adjustmentDetail!.frontloadRate).toBeCloseTo(1 + 0.15 * Math.sqrt(5 / 2), 3)
  })

  it('|E|=12 のとき frontloadRate≈1.097（長時間帯→低い前倒し）', () => {
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 6,
      endHour: 18,
      nowHour: 12,
      remainingBudget: 50_000,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 50_000 },
    })
    expect(result.adjustmentDetail!.frontloadRate).toBeCloseTo(1 + 0.15 * Math.sqrt(5 / 12), 3)
  })

  it('front-loading により targetCum が前倒しされる', () => {
    const result = runAt12(20_000)
    const d = result.adjustmentDetail!
    const rawTargetCum = 100_000 * (0.11 / 0.30)
    expect(d.targetCum).toBeGreaterThan(rawTargetCum)
    expect(d.targetCum).toBeCloseTo(rawTargetCum * d.frontloadRate, 0)
  })
})

// ---------------------------------------------------------------------------
// SpendCapacity: Slack補正後にも再適用される
// ---------------------------------------------------------------------------
describe('SpendCapacity: Slack補正後にも再適用される', () => {
  it('spendCapacity が Slack 補正後の adjustedBudget をキャップする', () => {
    const spendCap = Array(24).fill(Infinity)
    spendCap[12] = 35_000
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 10,
      endHour: 15,
      nowHour: 12,
      remainingBudget: 80_000,
      spendCapacity: spendCap,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 20_000 },
    })
    // Slack 補正なしの baseBudget ≈ 29474, 補正後 > 35000 になるケース
    // SpendCapacity=35000 でキャップされるべき
    expect(result.hourlyBudget[12]).toBeLessThanOrEqual(35_000)
    expect(result.hourlyBudget[12]).toBe(35_000)
  })
})

// ---------------------------------------------------------------------------
// 受け入れ条件 6: 非時間帯配信には影響しない
// ---------------------------------------------------------------------------
describe('AC6: 非時間帯配信には影響しない', () => {
  it('startHour===endHour のとき hourlyBudget は調整なしの値と同じ', () => {
    const params = {
      cumulativeRates,
      startHour: 0,
      endHour: 0,
      nowHour: 12,
      remainingBudget: 80_000,
    }
    const base = calculateHourlyBudget(params)
    const withAdj = calculateHourlyBudget({
      ...params,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget: 20_000 },
    })
    expect(withAdj.hourlyBudget[12]).toBe(base.hourlyBudget[12])
  })
})

// ---------------------------------------------------------------------------
// 追加: baseBudget の継続性（schedule通りのとき補正≈0）
// ---------------------------------------------------------------------------
describe('スケジュール通りのとき補正は小さい', () => {
  it('actualCum≈targetCum のとき hourlyBudget ≈ baseBudget', () => {
    // targetCum ≈ 42167 → usedBudget=42167
    const usedBudget = 42_167
    const result = calculateHourlyBudget({
      cumulativeRates,
      startHour: 10,
      endHour: 15,
      nowHour: 12,
      remainingBudget: 100_000 - usedBudget,
      remainingTimeAdjustment: { dailyBudget: 100_000, usedBudget },
    })
    const d = result.adjustmentDetail!
    expect(Math.abs(d.slack)).toBeLessThan(10) // ほぼゼロ
    expect(result.hourlyBudget[12]).toBeCloseTo(d.baseBudget, 0)
  })
})
