package com.coachxai.lessonrecorder;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * 세그먼트·종료 선언 업로드. WorkManager 가 앱이 꺼져도, 네트워크가 끊겼다
 * 돌아와도 이어서 보낸다. 서버는 같은 세그먼트·종료 선언의 재전송을 그대로
 * 받아 주므로(멱등) 중복 전송은 문제가 되지 않는다.
 */
public class UploadWorker extends Worker {
    private static final String TAG = "LessonRecorder";
    private static final String KEY_RID = "rid";
    private static final String KEY_KIND = "kind";
    private static final String KEY_SEQ = "seq";
    private static final String KIND_SEGMENT = "segment";
    private static final String KIND_COMPLETE = "complete";
    /** 이만큼 재시도해도 안 되면 포기(대략 하루 이상 지속된 실패). */
    private static final int MAX_ATTEMPTS = 40;

    public UploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void enqueueSegment(Context ctx, String rid, int seq) {
        enqueue(ctx, rid, KIND_SEGMENT, seq);
    }

    static void enqueueComplete(Context ctx, String rid) {
        enqueue(ctx, rid, KIND_COMPLETE, -1);
    }

    private static void enqueue(Context ctx, String rid, String kind, int seq) {
        Data data = new Data.Builder()
                .putString(KEY_RID, rid)
                .putString(KEY_KIND, kind)
                .putInt(KEY_SEQ, seq)
                .build();
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(UploadWorker.class)
                .setInputData(data)
                .setConstraints(new Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .addTag("lesson-recorder")
                .build();
        String name = String.format(Locale.US, "lr-%s-%s-%d", rid, kind, seq);
        // KEEP: 이미 대기 중인 같은 업로드가 있으면 새로 만들지 않는다(앱 재실행 시 재등록).
        WorkManager.getInstance(ctx).enqueueUniqueWork(name, ExistingWorkPolicy.KEEP, req);
    }

    /** 기기에 남은 업로드를 다시 등록한다 — 앱 시작 시. */
    static void resumeAll(Context ctx) {
        for (SessionStore.Session s : SessionStore.all(ctx)) {
            for (SessionStore.Segment seg : s.segments) {
                if (!seg.uploaded && !seg.failed) enqueueSegment(ctx, s.recordingId, seg.seq);
            }
            if (SessionStore.STATE_STOPPED.equals(s.state) && !s.completeSent) {
                enqueueComplete(ctx, s.recordingId);
            }
        }
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        String rid = getInputData().getString(KEY_RID);
        String kind = getInputData().getString(KEY_KIND);
        int seq = getInputData().getInt(KEY_SEQ, -1);
        if (rid == null || kind == null) return Result.failure();
        SessionStore.Session s = SessionStore.load(ctx, rid);
        if (s == null) return Result.success(); // 이미 정리됐거나 버린 녹음

        int code;
        try {
            if (KIND_SEGMENT.equals(kind)) {
                SessionStore.Segment seg = s.segment(seq);
                File f = SessionStore.segmentFile(ctx, rid, seq);
                if (seg == null || seg.uploaded || !f.exists()) return Result.success();
                code = putFile(s, seq, f, seg.durationMs);
            } else {
                code = postComplete(s);
            }
        } catch (IOException e) {
            Log.w(TAG, "upload " + kind + " " + seq + " failed, will retry", e);
            return retryOrGiveUp(ctx, rid, kind, seq);
        }

        if (code >= 200 && code < 300) {
            onSuccess(ctx, rid, kind, seq);
            return Result.success();
        }
        if (code == 408 || code == 429 || code >= 500) {
            return retryOrGiveUp(ctx, rid, kind, seq);
        }
        // 4xx: 토큰 만료·녹음 없음 등 다시 보내도 소용없는 거절.
        Log.e(TAG, "upload " + kind + " " + seq + " rejected: HTTP " + code);
        onPermanentFailure(ctx, rid, kind, seq);
        return Result.failure();
    }

    private Result retryOrGiveUp(Context ctx, String rid, String kind, int seq) {
        if (getRunAttemptCount() + 1 >= MAX_ATTEMPTS) {
            onPermanentFailure(ctx, rid, kind, seq);
            return Result.failure();
        }
        return Result.retry();
    }

    private static void onSuccess(Context ctx, String rid, String kind, int seq) {
        if (KIND_SEGMENT.equals(kind)) {
            //noinspection ResultOfMethodCallIgnored
            SessionStore.segmentFile(ctx, rid, seq).delete();
            SessionStore.update(ctx, rid, s -> {
                SessionStore.Segment seg = s.segment(seq);
                if (seg != null) seg.uploaded = true;
            });
        } else {
            SessionStore.update(ctx, rid, s -> s.completeSent = true);
        }
        LessonRecorderPlugin.notifyStatusChanged();
    }

    private static void onPermanentFailure(Context ctx, String rid, String kind, int seq) {
        if (KIND_SEGMENT.equals(kind)) {
            SessionStore.update(ctx, rid, s -> {
                SessionStore.Segment seg = s.segment(seq);
                if (seg != null) seg.failed = true;
            });
        } else {
            // 종료 선언을 끝내 못 보냈다 — 서버 정리 러너가 3일 뒤 지운다.
            SessionStore.update(ctx, rid, s -> s.completeSent = true);
        }
        LessonRecorderPlugin.notifyStatusChanged();
    }

    private static HttpURLConnection open(SessionStore.Session s, String path, String method) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(s.uploadBaseUrl + path).openConnection();
        conn.setRequestMethod(method);
        conn.setDoOutput(true);
        conn.setConnectTimeout(20_000);
        conn.setReadTimeout(60_000);
        conn.setRequestProperty("Authorization", "Bearer " + s.uploadToken);
        return conn;
    }

    private static int putFile(SessionStore.Session s, int seq, File f, long durationMs) throws IOException {
        HttpURLConnection conn = open(s, "/segments/" + seq, "PUT");
        try {
            conn.setRequestProperty("Content-Type", "audio/mp4");
            conn.setRequestProperty("x-segment-duration-ms", Long.toString(durationMs));
            conn.setFixedLengthStreamingMode(f.length());
            byte[] buf = new byte[16 * 1024];
            try (InputStream in = new FileInputStream(f); OutputStream out = conn.getOutputStream()) {
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return conn.getResponseCode();
        } finally {
            conn.disconnect();
        }
    }

    private static int postComplete(SessionStore.Session s) throws IOException {
        HttpURLConnection conn = open(s, "/complete", "POST");
        try {
            JSONObject body = new JSONObject();
            body.put("segmentCount", s.segmentCount());
            body.put("durationMs", s.durationMs());
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bytes);
            }
            return conn.getResponseCode();
        } catch (org.json.JSONException e) {
            throw new IOException(e);
        } finally {
            conn.disconnect();
        }
    }
}
