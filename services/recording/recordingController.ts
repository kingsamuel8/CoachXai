/**
 * 레슨 녹음 시작/종료 흐름 — 서버 녹음 생성과 네이티브 녹음기를 잇는다.
 * (docs/VOICE_RECORDING_PLAN.md §5, §8)
 */
import { resolveApiBaseUrl } from '../apiBase';
import { LessonRecorder, type StopResult, type UnfinishedSession } from './lessonRecorder';
import { createRecording, type Recording } from './recordingApi';

export class RecordingUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'not_native' | 'no_api_base' | 'permission_denied'
  ) {
    super(message);
    this.name = 'RecordingUnavailableError';
  }
}

export async function isRecordingAvailable(): Promise<boolean> {
  try {
    return (await LessonRecorder.isAvailable()).available;
  } catch {
    return false;
  }
}

/**
 * 서버에 녹음을 만들고 네이티브 녹음을 시작한다.
 * 네이티브 시작이 실패하면 서버 녹음은 그대로 둔다 — 종료되지 않은 녹음은
 * 3일 뒤 정리 러너가 지운다.
 */
export async function startLessonRecording(input: {
  clientId?: string;
  clientName?: string;
  lessonId?: string;
}): Promise<{ recording: Recording; startedAt: number }> {
  if (!(await isRecordingAvailable())) {
    throw new RecordingUnavailableError('레슨 녹음은 코치 앱에서만 할 수 있어요', 'not_native');
  }
  const apiBase = resolveApiBaseUrl();
  if (!/^https?:\/\//.test(apiBase)) {
    // 네이티브 업로더는 웹뷰 밖에서 돌기 때문에 상대 경로를 쓸 수 없다.
    throw new RecordingUnavailableError('서버 주소가 설정되지 않았어요', 'no_api_base');
  }
  const perm = await LessonRecorder.requestPermissions();
  if (perm.microphone !== 'granted') {
    throw new RecordingUnavailableError('마이크 권한이 필요해요', 'permission_denied');
  }

  const { recording, uploadToken } = await createRecording({ ...input, startedAt: Date.now() });
  const { startedAt } = await LessonRecorder.start({
    recordingId: recording.id,
    uploadBaseUrl: `${apiBase}/api/recordings/${recording.id}`,
    uploadToken,
    notificationTitle: '레슨 녹음 중',
    notificationText: input.clientName ? `${input.clientName} 회원 레슨` : '화면을 꺼도 녹음은 계속돼요',
  });
  return { recording, startedAt };
}

/** 녹음 종료. 남은 업로드와 종료 선언은 네이티브가 앱이 닫혀도 마저 보낸다. */
export const stopLessonRecording = (): Promise<StopResult> => LessonRecorder.stop();

/** 앱이 죽어 마무리되지 못한 녹음 — 다음 실행 때 코치에게 물어본다. */
export async function findUnfinishedRecordings(): Promise<UnfinishedSession[]> {
  if (!(await isRecordingAvailable())) return [];
  const status = await LessonRecorder.getStatus();
  const { sessions } = await LessonRecorder.listUnfinished();
  // 지금 녹음 중인 세션은 "끊긴 녹음"이 아니다.
  return sessions.filter((s) => s.recordingId !== status.recordingId);
}

export const finishUnfinishedRecording = (recordingId: string) =>
  LessonRecorder.finishUnfinished({ recordingId });

export const discardUnfinishedRecording = (recordingId: string) =>
  LessonRecorder.discardUnfinished({ recordingId });
