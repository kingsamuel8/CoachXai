import { describe, it, expect, vi, beforeEach } from 'vitest';

const plugin = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  requestPermissions: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn(),
  listUnfinished: vi.fn(),
  finishUnfinished: vi.fn(),
  discardUnfinished: vi.fn(),
}));
const api = vi.hoisted(() => ({ createRecording: vi.fn() }));
const base = vi.hoisted(() => ({ url: 'https://api.example.com' }));

vi.mock('../services/recording/lessonRecorder', () => ({ LessonRecorder: plugin }));
vi.mock('../services/recording/recordingApi', () => api);
vi.mock('../services/apiBase', () => ({ resolveApiBaseUrl: () => base.url }));

import {
  RecordingUnavailableError,
  findUnfinishedRecordings,
  startLessonRecording,
} from '../services/recording/recordingController';

beforeEach(() => {
  vi.clearAllMocks();
  base.url = 'https://api.example.com';
  plugin.isAvailable.mockResolvedValue({ available: true });
  plugin.requestPermissions.mockResolvedValue({ microphone: 'granted' });
  plugin.start.mockResolvedValue({ startedAt: 123 });
  api.createRecording.mockResolvedValue({
    recording: { id: 'rec-1' },
    uploadToken: 'up-token',
    uploadTokenExpiresAt: 0,
  });
});

describe('startLessonRecording', () => {
  it('서버에 녹음을 만들고 업로드 토큰·절대 주소로 네이티브 녹음을 시작한다', async () => {
    const r = await startLessonRecording({ clientName: '홍길동' });
    expect(r.startedAt).toBe(123);
    expect(plugin.start).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingId: 'rec-1',
        uploadBaseUrl: 'https://api.example.com/api/recordings/rec-1',
        uploadToken: 'up-token',
        notificationText: '홍길동 회원 레슨',
      })
    );
  });

  it('웹(네이티브 녹음기 없음)에서는 서버 녹음을 만들지 않는다', async () => {
    plugin.isAvailable.mockResolvedValue({ available: false });
    await expect(startLessonRecording({})).rejects.toMatchObject({ reason: 'not_native' });
    expect(api.createRecording).not.toHaveBeenCalled();
  });

  it('서버 주소가 상대 경로면 시작하지 않는다 — 네이티브 업로더는 웹뷰 밖에서 돈다', async () => {
    base.url = '';
    await expect(startLessonRecording({})).rejects.toBeInstanceOf(RecordingUnavailableError);
    expect(api.createRecording).not.toHaveBeenCalled();
  });

  it('마이크 권한이 없으면 시작하지 않는다', async () => {
    plugin.requestPermissions.mockResolvedValue({ microphone: 'denied' });
    await expect(startLessonRecording({})).rejects.toMatchObject({ reason: 'permission_denied' });
    expect(api.createRecording).not.toHaveBeenCalled();
  });
});

describe('findUnfinishedRecordings', () => {
  it('지금 녹음 중인 세션은 끊긴 녹음으로 보지 않는다', async () => {
    plugin.getStatus.mockResolvedValue({ state: 'recording', recordingId: 'live', pendingUploads: 0 });
    plugin.listUnfinished.mockResolvedValue({
      sessions: [
        { recordingId: 'live', startedAt: 1, segmentCount: 3, durationMs: 180_000 },
        { recordingId: 'crashed', startedAt: 0, segmentCount: 12, durationMs: 720_000 },
      ],
    });
    const list = await findUnfinishedRecordings();
    expect(list.map((s) => s.recordingId)).toEqual(['crashed']);
  });
});
