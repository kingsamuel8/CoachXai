package com.coachxai.lessonrecorder;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 녹음 세션의 디스크 기록 — filesDir/lesson-recordings/{recordingId}/session.json
 *
 * 앱이 죽어도 남아야 하는 모든 것(업로드 주소·토큰, 닫힌 세그먼트 목록, 종료
 * 여부)을 여기 둔다. 녹음 스레드·업로드 워커가 동시에 고치므로 모든 접근은
 * 클래스 락으로 직렬화한다.
 */
final class SessionStore {
    private static final String TAG = "LessonRecorder";
    private static final String ROOT = "lesson-recordings";

    static final String STATE_RECORDING = "recording";
    static final String STATE_STOPPED = "stopped";

    static final class Segment {
        int seq;
        long durationMs;
        boolean uploaded;
        boolean failed;
    }

    static final class Session {
        String recordingId;
        String uploadBaseUrl;
        String uploadToken;
        long startedAt;
        String state = STATE_RECORDING;
        boolean completeSent;
        final List<Segment> segments = new ArrayList<>();

        int segmentCount() {
            return segments.size();
        }

        long durationMs() {
            long sum = 0;
            for (Segment s : segments) sum += s.durationMs;
            return sum;
        }

        Segment segment(int seq) {
            for (Segment s : segments) if (s.seq == seq) return s;
            return null;
        }

        boolean allSettled() {
            for (Segment s : segments) if (!s.uploaded && !s.failed) return false;
            return true;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("recordingId", recordingId);
            o.put("uploadBaseUrl", uploadBaseUrl);
            o.put("uploadToken", uploadToken);
            o.put("startedAt", startedAt);
            o.put("state", state);
            o.put("completeSent", completeSent);
            JSONArray arr = new JSONArray();
            for (Segment s : segments) {
                JSONObject j = new JSONObject();
                j.put("seq", s.seq);
                j.put("durationMs", s.durationMs);
                j.put("uploaded", s.uploaded);
                j.put("failed", s.failed);
                arr.put(j);
            }
            o.put("segments", arr);
            return o;
        }

        static Session fromJson(JSONObject o) throws JSONException {
            Session s = new Session();
            s.recordingId = o.getString("recordingId");
            s.uploadBaseUrl = o.getString("uploadBaseUrl");
            s.uploadToken = o.getString("uploadToken");
            s.startedAt = o.getLong("startedAt");
            s.state = o.optString("state", STATE_RECORDING);
            s.completeSent = o.optBoolean("completeSent", false);
            JSONArray arr = o.optJSONArray("segments");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject j = arr.getJSONObject(i);
                    Segment seg = new Segment();
                    seg.seq = j.getInt("seq");
                    seg.durationMs = j.getLong("durationMs");
                    seg.uploaded = j.optBoolean("uploaded", false);
                    seg.failed = j.optBoolean("failed", false);
                    s.segments.add(seg);
                }
            }
            return s;
        }
    }

    private SessionStore() {}

    static File root(Context ctx) {
        return new File(ctx.getFilesDir(), ROOT);
    }

    static File dir(Context ctx, String recordingId) {
        return new File(root(ctx), recordingId);
    }

    static File segmentFile(Context ctx, String recordingId, int seq) {
        return new File(dir(ctx, recordingId), String.format(Locale.US, "seg-%04d.m4a", seq));
    }

    static synchronized Session load(Context ctx, String recordingId) {
        File f = new File(dir(ctx, recordingId), "session.json");
        if (!f.exists()) return null;
        try {
            String text = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
            return Session.fromJson(new JSONObject(text));
        } catch (IOException | JSONException e) {
            Log.e(TAG, "session load failed: " + recordingId, e);
            return null;
        }
    }

    static synchronized void save(Context ctx, Session s) {
        File d = dir(ctx, s.recordingId);
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        File tmp = new File(d, "session.json.tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(s.toJson().toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        } catch (IOException | JSONException e) {
            Log.e(TAG, "session save failed: " + s.recordingId, e);
            return;
        }
        // 원자적 교체 — 저장 도중 죽어도 이전 기록은 남는다.
        if (!tmp.renameTo(new File(d, "session.json"))) {
            Log.e(TAG, "session rename failed: " + s.recordingId);
        }
    }

    static synchronized List<Session> all(Context ctx) {
        List<Session> out = new ArrayList<>();
        File[] dirs = root(ctx).listFiles(File::isDirectory);
        if (dirs == null) return out;
        for (File d : dirs) {
            Session s = load(ctx, d.getName());
            if (s != null) out.add(s);
        }
        return out;
    }

    interface Mutation {
        void apply(Session s);
    }

    /** 읽고-고치고-쓰기를 한 번에. 세션이 없으면 아무것도 하지 않는다. */
    static synchronized Session update(Context ctx, String recordingId, Mutation m) {
        Session s = load(ctx, recordingId);
        if (s == null) return null;
        m.apply(s);
        save(ctx, s);
        cleanupIfDone(ctx, s);
        return s;
    }

    /** 종료 선언이 서버에 닿았고 모든 세그먼트가 정리됐으면 디렉터리를 지운다. */
    private static void cleanupIfDone(Context ctx, Session s) {
        if (!STATE_STOPPED.equals(s.state) || !s.completeSent || !s.allSettled()) return;
        File d = dir(ctx, s.recordingId);
        File[] files = d.listFiles();
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
        //noinspection ResultOfMethodCallIgnored
        d.delete();
    }

    static synchronized void delete(Context ctx, String recordingId) {
        File d = dir(ctx, recordingId);
        File[] files = d.listFiles();
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
        //noinspection ResultOfMethodCallIgnored
        d.delete();
    }

    /** 업로드를 기다리는 파일 수(모든 세션 합). */
    static synchronized int pendingUploads(Context ctx) {
        int n = 0;
        for (Session s : all(ctx)) {
            for (Segment seg : s.segments) if (!seg.uploaded && !seg.failed) n++;
            if (STATE_STOPPED.equals(s.state) && !s.completeSent) n++;
        }
        return n;
    }
}
