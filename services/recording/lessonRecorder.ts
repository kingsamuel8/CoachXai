/**
 * LessonRecorder — 네이티브 레슨 녹음기 플러그인의 JS 계약.
 * (구현: plugins/lesson-recorder, 기획: docs/VOICE_RECORDING_PLAN.md §4.1)
 *
 * 녹음·세그먼트 분할·업로드는 전부 네이티브가 한다. 화면이 꺼져 웹뷰가
 * 잠들어도 녹음과 업로드가 이어지게 하기 위해서다. 웹뷰는 시작/종료를
 * 지시하고 상태를 보여줄 뿐이다.
 *
 * 네이티브는 서버의 `/api/recordings/:id` 아래로 직접 올린다:
 *   PUT  {uploadBaseUrl}/segments/{seq}   (헤더 x-segment-duration-ms)
 *   POST {uploadBaseUrl}/gaps
 *   POST {uploadBaseUrl}/complete         (stop 시 네이티브가 직접 보낸다)
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type RecorderState = 'idle' | 'recording' | 'interrupted';

export interface RecorderStatus {
  state: RecorderState;
  recordingId?: string;
  /** 지금까지 녹음된 오디오 길이(ms). 끊긴 시간은 포함하지 않는다. */
  elapsedMs?: number;
  /** 닫힌 세그먼트 수(진행 중인 세그먼트 제외). */
  segmentCount?: number;
  /** 기기에 남아 업로드를 기다리는 파일 수(모든 녹음 합). */
  pendingUploads: number;
}

export interface StartOptions {
  recordingId: string;
  /** 절대 URL: `${API}/api/recordings/${recordingId}` */
  uploadBaseUrl: string;
  /** 녹음 전용 업로드 토큰(로그인 토큰 아님). */
  uploadToken: string;
  /** 세그먼트 길이(초). 기본 60. */
  segmentSec?: number;
  /** 안드로이드 상시 알림 문구. */
  notificationTitle?: string;
  notificationText?: string;
}

export interface StopResult {
  recordingId: string;
  segmentCount: number;
  durationMs: number;
}

export interface UnfinishedSession {
  recordingId: string;
  startedAt: number;
  segmentCount: number;
  durationMs: number;
}

export interface LessonRecorderPlugin {
  /** 이 기기에서 네이티브 녹음을 쓸 수 있는가(웹·학생 앱 등은 false). */
  isAvailable(): Promise<{ available: boolean }>;
  /** 마이크(·안드로이드 알림) 권한 요청. */
  requestPermissions(): Promise<{ microphone: 'granted' | 'denied' | 'prompt' }>;
  start(options: StartOptions): Promise<{ startedAt: number }>;
  /** 녹음을 끝내고 종료 선언(complete) 전송을 네이티브 업로드 큐에 넣는다. */
  stop(): Promise<StopResult>;
  getStatus(): Promise<RecorderStatus>;
  /** 앱이 죽어 종료 선언을 못 한 녹음들. */
  listUnfinished(): Promise<{ sessions: UnfinishedSession[] }>;
  /** 끊긴 녹음을 여기까지로 마무리한다(남은 세그먼트 업로드 + complete). */
  finishUnfinished(options: { recordingId: string }): Promise<StopResult>;
  /** 끊긴 녹음을 기기에서 버린다(서버 쪽은 3일 뒤 정리 러너가 지운다). */
  discardUnfinished(options: { recordingId: string }): Promise<void>;
  addListener(
    eventName: 'stateChange',
    listener: (status: RecorderStatus) => void
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

const unsupported = (): never => {
  throw new Error('레슨 녹음은 코치 앱에서만 할 수 있어요');
};

/** 웹: 화면 꺼짐 녹음이 원리적으로 불가하므로 지원하지 않는다(기획 §4.1). */
const webFallback: LessonRecorderPlugin = {
  isAvailable: async () => ({ available: false }),
  requestPermissions: async () => ({ microphone: 'denied' }),
  start: async () => unsupported(),
  stop: async () => unsupported(),
  getStatus: async () => ({ state: 'idle', pendingUploads: 0 }),
  listUnfinished: async () => ({ sessions: [] }),
  finishUnfinished: async () => unsupported(),
  discardUnfinished: async () => undefined,
  addListener: async () => ({ remove: async () => undefined }),
  removeAllListeners: async () => undefined,
};

export const LessonRecorder = registerPlugin<LessonRecorderPlugin>('LessonRecorder', {
  web: () => webFallback,
});
