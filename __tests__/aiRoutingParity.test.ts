/**
 * Express AI 게이트웨이와 Supabase Edge Function(ai-invoke)이 같은 모델·온도로
 * 부르는지 확인한다. 한쪽만 고치면 레슨 받아쓰기·노트 품질이 경로마다 달라진다.
 */
import { describe, expect, it } from 'vitest';
import { FEATURE_MODEL_OVERRIDES as SERVER_MODELS } from '../server/src/services/modelRouter';
import { DEFAULT_TEMPERATURE_BY_FEATURE as SERVER_TEMPS } from '../server/src/services/aiTemperature';
import {
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE_BY_FEATURE as EDGE_TEMPS,
  FEATURE_MODEL_OVERRIDES as EDGE_MODELS,
  resolveModel,
  resolveTemperature,
} from '../supabase/functions/_shared/aiRouting';

describe('AI routing parity (Express ↔ Supabase Edge Function)', () => {
  it('routes every feature to the same model', () => {
    expect(EDGE_MODELS).toEqual(SERVER_MODELS);
  });

  it('uses the same default temperatures', () => {
    expect(EDGE_TEMPS).toEqual(SERVER_TEMPS);
  });

  it('lets an explicit model / temperature win, then the feature map, then the default', () => {
    expect(resolveModel('lesson_client_note', undefined, DEFAULT_MODEL)).toBe('gemini-3.1-pro-preview');
    expect(resolveModel('lesson_client_note', 'gemini-x', DEFAULT_MODEL)).toBe('gemini-x');
    expect(resolveModel('unknown_feature', undefined, DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
    expect(resolveTemperature('lesson_audio_transcribe', undefined)).toBe(0.1);
    expect(resolveTemperature('lesson_audio_transcribe', 0.9)).toBe(0.9);
  });
});
