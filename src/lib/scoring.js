'use strict';

const { TIER_RANK } = require('./scales');

/*
 * 단원 자체 점수 = 티어점수 + 승률보정 + 연승연패
 *  - 티어점수  : 티어등급(0~7) × TIER_WEIGHT  (언랭 0 … 마스터 70)
 *  - 승률보정  : (승률 - 0.5) × WINRATE_WEIGHT  (경기 없으면 0)
 *  - 연승연패  : 현재 연속 결과. 3연승 → +3, 2연패 → -2 (승리 시 연패 보너스 초기화,
 *               패배 시 연승 보너스 초기화 — stats.streak 이 이미 이 규칙을 반영)
 *
 * 예) 마스터 · 승16 패12(57%) · 2연승 = 70 + round(0.07×40=2.8)=3 + 2 = 75점
 */
const TIER_WEIGHT = 10;
const WINRATE_WEIGHT = 40;

function scoreOf(member, stat) {
  const tierScore = (TIER_RANK[member.tier] ?? 0) * TIER_WEIGHT;
  const winrateScore = stat && stat.g ? Math.round((stat.wr - 0.5) * WINRATE_WEIGHT) : 0;
  const streakScore = (stat && stat.streak) || 0;
  const base = tierScore + winrateScore;
  return {
    tierScore,
    winrateScore,
    streakScore,
    streak: streakScore,
    base,
    total: base + streakScore,
  };
}

module.exports = { scoreOf, TIER_WEIGHT, WINRATE_WEIGHT };
