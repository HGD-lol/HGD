'use strict';

/* 시즌 / 티어 / 라인 / 직책 스케일 상수 */

const SEASON_YEAR = 2026;
const SEASON_LABEL = '2026 Split 2';

const TIER_ORDER = ['챌린저', '그랜드마스터', '마스터', '다이아', '에메랄드', '플레티넘', '골드', '실버', '브론즈', '아이언', '언랭'];
const TIER_RANK = { 챌린저: 10, 그랜드마스터: 9, 마스터: 8, 다이아: 7, 에메랄드: 6, 플레티넘: 5, 골드: 4, 실버: 3, 브론즈: 2, 아이언: 1, 언랭: 0 };
const TIER_COLOR = {
  챌린저: '#FFD23F', 그랜드마스터: '#E84057', 마스터: '#E4478D', 다이아: '#6FC3DF', 에메랄드: '#2ECC8F', 플레티넘: '#4FC0C0',
  골드: '#E0A335', 실버: '#A9B7C6', 브론즈: '#B4744A', 아이언: '#7C8B9E', 언랭: '#6B7A8F',
};

const LINE_ORDER = ['탑', '정글', '미드', '원딜', '서폿'];
const LINE_COLOR = { 탑: '#E0603C', 정글: '#4FA35A', 미드: '#4A8FE0', 원딜: '#E0B23C', 서폿: '#C77FE0' };
const LINE_SHORT = { 탑: 'TOP', 정글: 'JGL', 미드: 'MID', 원딜: 'ADC', 서폿: 'SUP' };

const ROLE_LABEL = { 단장: '협곡 단장', 부단장: '협곡 부단장', 단원: '협곡단원', 예비: '예비 단원' };

module.exports = {
  SEASON_YEAR, SEASON_LABEL,
  TIER_ORDER, TIER_RANK, TIER_COLOR,
  LINE_ORDER, LINE_COLOR, LINE_SHORT,
  ROLE_LABEL,
};
