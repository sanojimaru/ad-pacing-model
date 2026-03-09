# ad-pacing-model

Dayparting(時間帯配信)向けの動的予算ペーシングアルゴリズム。

hourly budget rate の形状を活かしつつ、残り配信可能時間と残予算に基づいて毎時リプランし、予算の使い切りを最大化します。

## 特徴

- **hourly budget rate の形状を維持** - ピーク時間に自然に予算が寄る
- **残り時間連動補正** - 配信遅れ時に残り時間が少ないほど追い上げを強化
- **動的パラメータ** - 配信対象時間数 `|E|` に応じて補正強度(k)と前倒し係数(frontloadRate)を自動調整
- **安全装置** - HourlyBudget を `[0, RemainingBudget]` にクランプ、SpendCapacity による上限制御

## インストール

```bash
npm install
```

## 使い方

### CLI

```bash
npx ts-node pacing.ts <startHour> <endHour> <nowHour> <dailyBudget> <usedBudget>
```

```bash
# 例: 10時〜15時配信、現在12時、日予算10万、消化済み2万
npx ts-node pacing.ts 10 15 12 100000 20000
```

### ライブラリとして

```typescript
import { calculateHourlyBudget } from './pacing'

const result = calculateHourlyBudget({
  cumulativeRates,    // 累積rate配列（24要素）
  startHour: 10,      // 配信開始時刻
  endHour: 15,        // 配信終了時刻
  nowHour: 12,        // 現在時刻
  remainingBudget: 80000,
  spendCapacity,      // optional: 時間別消化上限
  remainingTimeAdjustment: {  // optional: 残り時間連動補正
    dailyBudget: 100000,
    usedBudget: 20000,
  },
})

console.log(result.hourlyBudget[12])       // 現在時刻の予算
console.log(result.adjustmentDetail)       // 補正の詳細
```

## アルゴリズム概要

毎時間 `now` に以下を実行:

1. 配信対象時間(E)から残り配信時間(E_remaining)を算出
2. 残り時間の hourly budget rate で再正規化し、ベース配分(BaseBudget)を決定
3. 目標累積消化額(TargetCum)と実績(UsedBudget)の差分(Slack)を算出
4. 残り時間連動補正係数 `alpha = min(1, k / H_left)` で補正
5. SpendCapacity でキャップし最終予算を決定

詳細は [spec.md](./spec.md) を参照してください。

## テスト

```bash
npx vitest pacing.spec.ts
```

## License

ISC
