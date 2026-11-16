package com.coachxai.lessonrecorder;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.io.IOException;

/**
 * 레슨 녹음 포그라운드 서비스(type=microphone).
 *
 * 화면이 꺼지고 웹뷰가 잠들어도 이 서비스가 마이크를 붙들고 녹음한다.
 * AudioRecord 로 PCM 을 받아 AacSegmentWriter 로 60초마다 파일을 갈아
 * 끼우고, 닫힌 파일은 곧바로 UploadWorker 로 넘긴다.
 *
 * 상시 알림의 [녹음 종료] 로 화면을 켜지 않고도 끝낼 수 있다.
 */
public class RecorderService extends Service {
    private static final String TAG = "LessonRecorder";
    static final String ACTION_START = "com.coachxai.lessonrecorder.START";
    static final String ACTION_STOP = "com.coachxai.lessonrecorder.STOP";
    static final String EXTRA_RID = "rid";
    static final String EXTRA_SEGMENT_SEC = "segmentSec";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";

    private static final String CHANNEL_ID = "lesson_recording";
    private static final int NOTIFICATION_ID = 7301;
    private static final int[] SAMPLE_RATES = {16_000, 44_100, 48_000};
    private static final int BIT_RATE = 32_000;

    /** 지금 녹음 중인 서비스. 플러그인이 상태 조회·종료에 쓴다. */
    private static volatile RecorderService active;

    static RecorderService active() {
        return active;
    }

    private volatile boolean running;
    private Thread thread;
    private PowerManager.WakeLock wakeLock;
    private String recordingId;
    private long segmentMs = 60_000;
    private volatile long elapsedMs;
    private volatile int closedSegments;
    private String notifTitle = "레슨 녹음 중";
    private String notifText = "화면을 꺼도 녹음은 계속돼요";
    private long chronometerBase;
    private volatile String error;

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            // 알림에서 종료 — 웹뷰가 잠들어 있어도 여기서 마무리까지 한다.
            new Thread(this::stopAndFinish, "lesson-recorder-stop").start();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action) || running) return START_NOT_STICKY;

        recordingId = intent.getStringExtra(EXTRA_RID);
        segmentMs = Math.max(10, intent.getIntExtra(EXTRA_SEGMENT_SEC, 60)) * 1000L;
        if (intent.getStringExtra(EXTRA_TITLE) != null) notifTitle = intent.getStringExtra(EXTRA_TITLE);
        if (intent.getStringExtra(EXTRA_TEXT) != null) notifText = intent.getStringExtra(EXTRA_TEXT);
        chronometerBase = System.currentTimeMillis();

        // startForegroundService 후 5초 안에 불러야 한다 — 다른 무엇보다 먼저.
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CoachXai:LessonRecorder");
        wakeLock.acquire(6 * 60 * 60 * 1000L); // 안전 상한 6시간

        running = true;
        active = this;
        thread = new Thread(this::recordLoop, "lesson-recorder");
        thread.start();
        LessonRecorderPlugin.notifyStatusChanged();
        return START_NOT_STICKY;
    }

    long elapsedMs() {
        return elapsedMs;
    }

    int closedSegments() {
        return closedSegments;
    }

    String recordingId() {
        return recordingId;
    }

    String error() {
        return error;
    }

    private AudioRecord openRecord() {
        for (int rate : SAMPLE_RATES) {
            int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) continue;
            try {
                @SuppressWarnings("MissingPermission")
                AudioRecord r = new AudioRecord(MediaRecorder.AudioSource.MIC, rate,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                        Math.max(min * 2, rate / 5 * 2));
                if (r.getState() == AudioRecord.STATE_INITIALIZED) return r;
                r.release();
            } catch (RuntimeException e) {
                Log.w(TAG, "AudioRecord " + rate + "Hz failed", e);
            }
        }
        return null;
    }

    private void recordLoop() {
        AudioRecord record = openRecord();
        if (record == null) {
            fail("마이크를 열 수 없어요");
            return;
        }
        int rate = record.getSampleRate();
        AacSegmentWriter writer = new AacSegmentWriter(rate, BIT_RATE);
        byte[] buf = new byte[rate / 10 * 2]; // 100ms
        long totalSamples = 0;
        int seq = 0;
        try {
            record.startRecording();
            writer.open(SessionStore.segmentFile(this, recordingId, seq));
            long lastNotify = SystemClock.elapsedRealtime();
            while (running) {
                int n = record.read(buf, 0, buf.length);
                if (n < 0) {
                    Log.e(TAG, "AudioRecord.read error " + n);
                    error = "녹음 중 마이크 오류가 났어요";
                    break;
                }
                if (n == 0) continue;
                writer.write(buf, n);
                totalSamples += n / 2;
                elapsedMs = totalSamples * 1000L / rate;
                if (writer.durationMs() >= segmentMs) {
                    finishSegment(writer, seq);
                    seq++;
                    writer.open(SessionStore.segmentFile(this, recordingId, seq));
                }
                long now = SystemClock.elapsedRealtime();
                if (now - lastNotify > 5_000) {
                    lastNotify = now;
                    LessonRecorderPlugin.notifyStatusChanged();
                }
            }
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "record loop failed", e);
            error = "녹음 중 오류가 났어요";
        } finally {
            try {
                record.stop();
            } catch (RuntimeException ignored) {
            }
            record.release();
            try {
                finishSegment(writer, seq);
            } catch (RuntimeException e) {
                Log.e(TAG, "final segment close failed", e);
            }
            if (running) {
                // 종료 지시 없이 루프가 끝났다(마이크 오류). 녹음된 데까지는
                // 업로드됐으니, 코치에게 알려 종료를 누르게 한다.
                LessonRecorderPlugin.notifyError(recordingId, error != null ? error : "녹음이 멈췄어요");
            }
        }
    }

    /** 세그먼트를 닫고, 오디오가 있었으면 기록 + 업로드 등록. */
    private void finishSegment(AacSegmentWriter writer, int seq) {
        long dur = writer.durationMs();
        if (!writer.close()) return;
        SessionStore.update(this, recordingId, s -> {
            if (s.segment(seq) != null) return;
            SessionStore.Segment seg = new SessionStore.Segment();
            seg.seq = seq;
            seg.durationMs = dur;
            s.segments.add(seg);
        });
        closedSegments = seq + 1;
        UploadWorker.enqueueSegment(this, recordingId, seq);
    }

    /**
     * 녹음을 멈추고 종료 선언을 업로드 큐에 넣는다. 녹음 스레드가 마지막
     * 세그먼트를 닫을 때까지 기다린다.
     */
    synchronized SessionStore.Session stopAndFinish() {
        if (recordingId == null) return null;
        running = false;
        if (thread != null) {
            try {
                thread.join(10_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            thread = null;
        }
        SessionStore.Session s = SessionStore.update(this, recordingId,
                x -> x.state = SessionStore.STATE_STOPPED);
        UploadWorker.enqueueComplete(this, recordingId);
        release();
        return s;
    }

    private void fail(String message) {
        error = message;
        running = false;
        // 한 조각도 녹음하지 못했다 — 기기에 남길 것이 없다. (서버의 빈 녹음은
        // 3일 뒤 정리 러너가 지운다.)
        SessionStore.delete(this, recordingId);
        LessonRecorderPlugin.notifyError(recordingId, message);
        release();
    }

    private void release() {
        active = null;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
        LessonRecorderPlugin.notifyStatusChanged();
    }

    @Override
    public void onDestroy() {
        // 시스템이 서비스를 죽이는 경우 — 세션은 'recording' 으로 남아 다음
        // 실행 때 "끊긴 녹음"으로 복구를 제안받는다.
        running = false;
        if (active == this) active = null;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "레슨 녹음", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("레슨을 녹음하는 동안 표시돼요");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        Intent stop = new Intent(this, RecorderService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, piFlags);
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openPi = launch != null ? PendingIntent.getActivity(this, 2, launch, piFlags) : null;

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle(notifTitle)
                .setContentText(notifText)
                .setUsesChronometer(true)
                .setWhen(chronometerBase)
                .setShowWhen(true)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(openPi)
                .addAction(0, "녹음 종료", stopPi)
                .build();
    }
}
