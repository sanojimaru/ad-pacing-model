/**
 * Dayparting Dynamic Budget Pacing Example
 * ----------------------------------------
 * 条件
 * 配信時間: 10:00-15:00
 * 現在時刻: 12:00
 * 残予算: 50000
 *
 * hourly budget rate(add) = 累積rate
 */

const cumulativeRates = [
  0.02,0.03,0.04,0.04,0.05,0.06,0.09,0.13,
  0.17,0.22,0.27,0.33,0.40,0.47,0.52,0.59,
  0.65,0.73,0.80,0.87,0.92,0.97,1,1
]

// ---------------------------------------------------------------------------
// 残り時間連動補正パラメータ（時間帯配信のみ）
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------

/** 累積rate配列（24要素）→ 時間別rate配列に変換 */
export function toHourlyRate(cumulative: number[]): number[] {
  return Array.from({ length: 24 }, (_, h) =>
    h === 0 ? cumulative[0] : cumulative[h] - cumulative[h - 1]
  )
}

/**
 * spec準拠のコア計算: 指定時間 h の予算を単一値で返す（毎時呼び出しの基本単位）
 * remainingRateSum は呼び出し元で一度だけ計算して渡す
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
  spendCapacity?: number[] // optional: 時間別消化上限（P90など）。インデックスは hour
  remainingTimeAdjustment?: RemainingTimeAdjustmentParams
}) {

  // 1. 累積rate → 時間rate
  const hourlyRate = toHourlyRate(cumulativeRates)

  // 2. 配信対象時間（跨ぎ対応）
  const eligibleHours: number[] = []
  if (startHour === endHour) {
    for (let h = 0; h < 24; h++) eligibleHours.push(h)
  } else if (startHour < endHour) {
    for (let h = startHour; h < endHour; h++) eligibleHours.push(h)
  } else {
    // 跨ぎ: 例 23->2 => [23,0,1]
    for (let h = startHour; h < 24; h++) eligibleHours.push(h)
    for (let h = 0; h < endHour; h++) eligibleHours.push(h)
  }

  // 3. 残り配信時間（順序を保ってスライス）
  const idx = eligibleHours.indexOf(nowHour)
  const remainingHours = idx === -1 ? [] : eligibleHours.slice(idx)

  // nowHour が配信対象外 or 残予算なし → 配信停止
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

  // 4. 残りrate合計
  const remainingRateSum = remainingHours.reduce(
    (sum, h) => sum + hourlyRate[h],
    0
  )

  // 5-7. 残り時間ごとに computeBudgetForHour を呼び出し、24時間分の配列に収める
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

  // 8. 残り時間連動補正（時間帯配信のみ: startHour !== endHour）
  let adjustmentDetail: AdjustmentDetail | undefined
  if (remainingTimeAdjustment && startHour !== endHour) {
    const { dailyBudget, usedBudget } = remainingTimeAdjustment
    const hLeft = remainingHours.length
    const eSize = eligibleHours.length

    // 動的 k = 1.5 × √(5/|E|)
    const k = 1.5 * Math.sqrt(5 / eSize)

    // Front-loading 補正率
    const frontloadRate = 1 + 0.15 * Math.sqrt(5 / eSize)

    // ベース配分（既存計算値）
    const baseBudget = hourlyBudget[nowHour]

    // 目標累積消化額: eligibleHours のうち nowHour より前の時間の rate 合計で算出
    // idx を使い、跨ぎ配信でも順序通りにスライスする
    const hoursBeforeNow = eligibleHours.slice(0, idx)
    const totalEligibleRate = eligibleHours.reduce((sum, h) => sum + hourlyRate[h], 0)
    const rateBeforeNow = hoursBeforeNow.reduce((sum, h) => sum + hourlyRate[h], 0)
    const targetCumRatio = totalEligibleRate > 0
      ? rateBeforeNow / totalEligibleRate
      : hoursBeforeNow.length / eligibleHours.length
    const targetCum = Math.min(dailyBudget, dailyBudget * targetCumRatio * frontloadRate)

    // 実績累積消化額
    const actualCum = usedBudget

    // 差分（Slack）
    const slack = targetCum - actualCum

    // 残り時間連動補正係数
    const alpha = Math.min(1, k / hLeft)

    // 補正後予算
    const targetHourlyBudget = baseBudget + alpha * slack

    // clamp
    let adjustedBudget = Math.min(remainingBudget, Math.max(0, targetHourlyBudget))
    if (spendCapacity?.[nowHour] != null) {
      adjustedBudget = Math.min(adjustedBudget, spendCapacity[nowHour])
    }
    hourlyBudget[nowHour] = adjustedBudget

    adjustmentDetail = {
      baseBudget,
      targetCum,
      actualCum,
      slack,
      hLeft,
      k,
      frontloadRate,
      alpha,
      targetHourlyBudget,
      adjustedBudget,
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

// ---------------------------
// 実行
// ---------------------------
// 使い方: npx ts-node pacing.ts <startHour> <endHour> <nowHour> <dailyBudget> <usedBudget>
// 例:     npx ts-node pacing.ts 10 15 12 100000 20000

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.length < 5) {
    console.error('Usage: npx ts-node pacing.ts <startHour> <endHour> <nowHour> <dailyBudget> <usedBudget>')
    console.error('Example: npx ts-node pacing.ts 10 15 12 100000 20000')
    process.exit(1)
  }
  const startHour       = parseInt(args[0], 10)
  const endHour         = parseInt(args[1], 10)
  const nowHour         = parseInt(args[2], 10)
  const dailyBudget     = parseInt(args[3], 10)
  const usedBudget      = parseInt(args[4], 10)
  const remainingBudget = Math.max(0, dailyBudget - usedBudget)

  console.log(`\nConfig: startHour=${startHour}, endHour=${endHour}, nowHour=${nowHour}`)
  console.log(`Budget: daily=${dailyBudget}, used=${usedBudget}, remaining=${remainingBudget}`)

  // 1. 補正なし（ベース配分のみ）
  const baseResult = calculateHourlyBudget({
    cumulativeRates,
    startHour,
    endHour,
    nowHour,
    remainingBudget,
  })

  // 2. 補正あり（残り時間連動）
  const adjResult = calculateHourlyBudget({
    cumulativeRates,
    startHour,
    endHour,
    nowHour,
    remainingBudget,
    remainingTimeAdjustment: { dailyBudget, usedBudget },
  })

  // 補正詳細
  if (adjResult.adjustmentDetail) {
    const d = adjResult.adjustmentDetail
    console.log(`\n--- 残り時間連動補正 詳細 ---`)
    console.log(`TargetCum=${Math.round(d.targetCum)}, ActualCum=${Math.round(d.actualCum)}, Slack=${Math.round(d.slack)}${d.slack > 0 ? '(遅れ)' : d.slack < 0 ? '(進み)' : '(±0)'}`)
    console.log(`H_left=${d.hLeft}, alpha=${d.alpha.toFixed(4)}, k=${d.k.toFixed(4)}, frontloadRate=${d.frontloadRate.toFixed(4)}`)
  }

  // 24時間テーブル出力
  console.log("\nHourly Budget & Rate Allocation (all 24 hours)")
  let cumBudget = 0
  let cumAdj = 0
  let cumRate = 0
  console.table(Array.from({ length: 24 }, (_, i) => {
    const base = baseResult.hourlyBudget[i]
    const adj = adjResult.hourlyBudget[i]
    const rate = baseResult.normalizedHourlyRate[i]
    cumBudget += base
    cumAdj += adj
    cumRate += rate
    const diff = adj - base
    const adjRate = remainingBudget > 0 ? adj / remainingBudget : 0
    const alpha = (adjResult.adjustmentDetail && i === nowHour)
      ? adjResult.adjustmentDetail.alpha
      : null
    return {
      cumInput  : +cumulativeRates[i].toFixed(4),
      hour      : i,
      rate      : +rate.toFixed(4),
      adjRate   : +adjRate.toFixed(4),
      alpha     : alpha !== null ? +alpha.toFixed(4) : '',
      cumRate   : +cumRate.toFixed(4),
      base      : Math.round(base),
      adjusted  : Math.round(adj),
      diff      : Math.round(diff),
      cumBase   : Math.round(cumBudget),
      cumAdj    : Math.round(cumAdj),
    }
  }))
}
