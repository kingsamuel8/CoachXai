import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateGolfMissions, generateCoachXChatResponse } from '../services/geminiService';
import type { ClientProfile } from '../types';

describe('geminiService backend runtime adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls backend /api/ai/invoke for mission generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: '["미션 A","미션 B","미션 C"]' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const profile = { name: '회원', phone: '01011112222' } as ClientProfile;
    const result = await generateGolfMissions(profile, []);

    expect(result).toEqual(['미션 A', '미션 B', '미션 C']);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/invoke'),
      expect.objectContaining({
        method: 'POST',
      })
    );
  });

  it('sends the stored login token — the AI gateway is coaches-only', async () => {
    localStorage.setItem('swingnote_api_token', 'coach-jwt');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: '["미션 A","미션 B","미션 C"]' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await generateGolfMissions({ name: '회원', phone: '01033334444' } as ClientProfile, []);
    } finally {
      localStorage.removeItem('swingnote_api_token');
    }
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/invoke'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer coach-jwt' }),
      })
    );
  });

  it('falls back to heuristic CoachX reply when backend runtime fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await generateCoachXChatResponse('unknown question', [], [], 'en');
    expect(result).toMatch(/coachx/i);
  });
});
