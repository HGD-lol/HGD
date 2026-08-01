'use strict';

/*
 * 내전 점수 시스템
 * - 기본 200점
 * - 승리: +16점 (연승 보너스: 2연승 +17, 3연승 +18, ...)
 * - 패배: -14점 (연패 페널티: 2연패 -15, 3연패 -16, ...)
 * - 협곡 내전에만 점수 반영
 */
const BASE_SCORE = 200;
const WIN_POINTS = 16;
const LOSS_POINTS = 14;

module.exports = { BASE_SCORE, WIN_POINTS, LOSS_POINTS };
