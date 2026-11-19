package com.coachxai.lessonrecorder;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.io.File;

/**
 * JS 계약: services/recording/lessonRecorder.ts
 *
 * 권한은 Capacitor 기본 requestPermissions() 가 별칭(microphone,
 * notifications)별 상태를 돌려준다.
 */
@CapacitorPlugin(
        name = "LessonRecorder",
        permissions = {
                @Permission(alias = "microphone", strings = {Manifest.permission.RECORD_AUDIO}),
                @Permission(alias = "notifications", strings = {"android.permission.POST_NOTIFICATIONS"})
        }
)
public class LessonRecorderPlugin extends Plugin {
    private static volatile LessonRecorderPlugin instance;

    @Override
    public void load() {
        instance = this;
        Context ctx = getContext().getApplicationContext();
        // 지난 실행에서 못 올린 세그먼트·종료 선언을 다시 등록한다.
        new Thread(() -> UploadWorker.resumeAll(ctx), "lesson-recorder-resume").start();
    }

    static void notifyStatusChanged() {
        LessonRecorderPlugin p = instance;
        if (p != null) p.notifyListeners("stateChange", p.buildStatus());
    }

    static void notifyError(String recordingId, String message) {
        LessonRecorderPlugin p = instance;
        if (p == null) return;
        JSObject status = p.buildStatus();
        status.put("error", message);
        if (recordingId != null) status.put("recordingId", recordingId);
        p.notifyListeners("stateChange", status);
    }

    private JSObject buildStatus() {
        JSObject o = new JSObject();
        RecorderService svc = RecorderService.active();
        if (svc != null) {
            o.put("state", "recording");
            o.put("recordingId", svc.recordingId());
            o.put("elapsedMs", svc.elapsedMs());
            o.put("segmentCount", svc.closedSegments());
        } else {
            o.put("state", "idle");
        }
        o.put("pendingUploads", SessionStore.pendingUploads(getContext()));
        return o;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        boolean available;
        try {
            // 서비스는 코치 앱 매니페스트에만 선언돼 있다(학생 앱은 false).
            getContext().getPackageManager().getServiceInfo(
                    new ComponentName(getContext(), RecorderService.class), 0);
            available = true;
        } catch (PackageManager.NameNotFoundException e) {
            available = false;
        }
        JSObject r = new JSObject();
        r.put("available", available);
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("마이크 권한이 필요해요", "permission_denied");
            return;
        }
        if (RecorderService.active() != null) {
            call.reject("이미 녹음 중이에요", "already_recording");
            return;
        }
        String rid = call.getString("recordingId");
        String base = call.getString("uploadBaseUrl");
        String token = call.getString("uploadToken");
        if (rid == null || base == null || token == null || !base.startsWith("http")) {
            call.reject("recordingId, uploadBaseUrl, uploadToken 이 필요해요", "invalid_arguments");
            return;
        }
        Context ctx = getContext();
        long startedAt = System.currentTimeMillis();
        SessionStore.Session s = new SessionStore.Session();
        s.recordingId = rid;
        s.uploadBaseUrl = base.replaceAll("/+$", "");
        s.uploadToken = token;
        s.startedAt = startedAt;
        SessionStore.save(ctx, s);

        Intent intent = new Intent(ctx, RecorderService.class)
                .setAction(RecorderService.ACTION_START)
                .putExtra(RecorderService.EXTRA_RID, rid)
                .putExtra(RecorderService.EXTRA_SEGMENT_SEC, call.getInt("segmentSec", 60))
                .putExtra(RecorderService.EXTRA_TITLE, call.getString("notificationTitle"))
                .putExtra(RecorderService.EXTRA_TEXT, call.getString("notificationText"));
        try {
            ContextCompat.startForegroundService(ctx, intent);
        } catch (RuntimeException e) {
            SessionStore.delete(ctx, rid);
            call.reject("녹음을 시작하지 못했어요", "start_failed", e);
            return;
        }
        JSObject r = new JSObject();
        r.put("startedAt", startedAt);
        call.resolve(r);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        RecorderService svc = RecorderService.active();
        if (svc == null) {
            call.reject("녹음 중이 아니에요", "not_recording");
            return;
        }
        new Thread(() -> {
            SessionStore.Session s = svc.stopAndFinish();
            if (s == null) {
                call.reject("녹음 기록을 찾지 못했어요", "no_session");
                return;
            }
            call.resolve(stopResult(s));
        }, "lesson-recorder-stop").start();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(buildStatus());
    }

    @PluginMethod
    public void listUnfinished(PluginCall call) {
        RecorderService svc = RecorderService.active();
        String activeId = svc != null ? svc.recordingId() : null;
        JSArray arr = new JSArray();
        for (SessionStore.Session s : SessionStore.all(getContext())) {
            if (!SessionStore.STATE_RECORDING.equals(s.state)) continue;
            if (s.recordingId.equals(activeId)) continue;
            JSObject o = new JSObject();
            o.put("recordingId", s.recordingId);
            o.put("startedAt", s.startedAt);
            o.put("segmentCount", s.segmentCount());
            o.put("durationMs", s.durationMs());
            arr.put(o);
        }
        JSObject r = new JSObject();
        r.put("sessions", arr);
        call.resolve(r);
    }

    @PluginMethod
    public void finishUnfinished(PluginCall call) {
        String rid = call.getString("recordingId");
        Context ctx = getContext();
        SessionStore.Session s = rid == null ? null : SessionStore.load(ctx, rid);
        if (s == null) {
            call.reject("녹음 기록을 찾지 못했어요", "no_session");
            return;
        }
        // 앱이 죽을 때 쓰던 세그먼트는 닫히지 않아(moov 없음) 재생할 수 없다.
        // 기록된 세그먼트만 남기고 지운다 — 잃는 것은 최대 한 세그먼트(60초).
        File partial = SessionStore.segmentFile(ctx, rid, s.segmentCount());
        //noinspection ResultOfMethodCallIgnored
        partial.delete();
        s = SessionStore.update(ctx, rid, x -> x.state = SessionStore.STATE_STOPPED);
        UploadWorker.resumeAll(ctx);
        call.resolve(stopResult(s));
    }

    @PluginMethod
    public void discardUnfinished(PluginCall call) {
        String rid = call.getString("recordingId");
        if (rid != null) SessionStore.delete(getContext(), rid);
        call.resolve();
        notifyStatusChanged();
    }

    private static JSObject stopResult(SessionStore.Session s) {
        JSObject r = new JSObject();
        r.put("recordingId", s.recordingId);
        r.put("segmentCount", s.segmentCount());
        r.put("durationMs", s.durationMs());
        return r;
    }
}
