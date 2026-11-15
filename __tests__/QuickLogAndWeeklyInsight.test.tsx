/**
 * Tests for quick-log and weekly-insight storage:
 * 1. storageService quick log CRUD works correctly.
 * 2. storageService weekly insight CRUD works correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storageService } from '../services/storage';
import { QuickLogEntry, WeeklyInsight } from '../types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../services/firebase', () => ({
  firebaseService: {
    isInitialized: vi.fn().mockReturnValue(false),
    getQuickLogsByClient: vi.fn().mockResolvedValue([]),
    saveQuickLog: vi.fn().mockResolvedValue(undefined),
    getWeeklyInsightsByClient: vi.fn().mockResolvedValue([]),
    saveWeeklyInsight: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeLog = (overrides: Partial<QuickLogEntry> = {}): QuickLogEntry => ({
  id: crypto.randomUUID(),
  clientId: 'TestClient_01012345678',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  logDate: '2026-04-01',
  mood: 'GOOD',
  goodPoint: '드라이버 방향성 좋았다',
  problemPoint: '퍼팅 거리감 부족',
  ...overrides,
});

const CLIENT_ID = 'TestClient_01012345678';

// ─── storageService tests ─────────────────────────────────────────────────────

describe('storageService – quick logs', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty array when no logs stored', () => {
    expect(storageService.getQuickLogs()).toEqual([]);
  });

  it('saves and retrieves a quick log', () => {
    const log = makeLog({ id: 'log1' });
    storageService.saveQuickLog(log);
    const all = storageService.getQuickLogs();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('log1');
  });

  it('updates an existing quick log (upsert)', () => {
    const log = makeLog({ id: 'log1', goodPoint: 'original' });
    storageService.saveQuickLog(log);
    const updated = { ...log, goodPoint: 'updated' };
    storageService.saveQuickLog(updated);
    const all = storageService.getQuickLogs();
    expect(all).toHaveLength(1);
    expect(all[0].goodPoint).toBe('updated');
  });

  it('getQuickLogsByClient filters by clientId', () => {
    storageService.saveQuickLog(makeLog({ id: 'a', clientId: CLIENT_ID }));
    storageService.saveQuickLog(makeLog({ id: 'b', clientId: 'OtherClient_999' }));
    const mine = storageService.getQuickLogsByClient(CLIENT_ID);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe('a');
  });

  it('deleteQuickLog removes the correct entry', () => {
    storageService.saveQuickLog(makeLog({ id: 'del1' }));
    storageService.saveQuickLog(makeLog({ id: 'del2' }));
    storageService.deleteQuickLog('del1');
    const all = storageService.getQuickLogs();
    expect(all.map((q) => q.id)).not.toContain('del1');
    expect(all.map((q) => q.id)).toContain('del2');
  });
});

describe('storageService – weekly insights', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty array when no insights stored', () => {
    expect(storageService.getWeeklyInsights()).toEqual([]);
  });

  it('saves and retrieves a weekly insight', () => {
    const insight: WeeklyInsight = {
      id: 'wi1',
      clientId: CLIENT_ID,
      weekStart: '2026-03-30',
      weekEnd: '2026-04-05',
      summary: '좋은 한 주였습니다.',
      keyPatterns: ['패턴1'],
      recommendedFocus: '다음 주 포커스',
      generatedAt: Date.now(),
    };
    storageService.saveWeeklyInsight(insight);
    const all = storageService.getWeeklyInsights();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('wi1');
  });

  it('getWeeklyInsightsByClient filters and sorts by generatedAt descending', () => {
    const early: WeeklyInsight = {
      id: 'wi_early',
      clientId: CLIENT_ID,
      weekStart: '2026-03-23',
      weekEnd: '2026-03-29',
      summary: 'Early',
      keyPatterns: [],
      recommendedFocus: '',
      generatedAt: 1000,
    };
    const late: WeeklyInsight = {
      id: 'wi_late',
      clientId: CLIENT_ID,
      weekStart: '2026-03-30',
      weekEnd: '2026-04-05',
      summary: 'Late',
      keyPatterns: [],
      recommendedFocus: '',
      generatedAt: 2000,
    };
    storageService.saveWeeklyInsight(early);
    storageService.saveWeeklyInsight(late);
    const results = storageService.getWeeklyInsightsByClient(CLIENT_ID);
    expect(results[0].id).toBe('wi_late');
    expect(results[1].id).toBe('wi_early');
  });
});
