import AVFoundation
import Capacitor
import Foundation

/// JS 계약: services/recording/lessonRecorder.ts
@objc(LessonRecorderPlugin)
public class LessonRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LessonRecorderPlugin"
    public let jsName = "LessonRecorder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listUnfinished", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishUnfinished", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardUnfinished", returnType: CAPPluginReturnPromise),
    ]

    private let recorder = RecorderEngine.shared

    override public func load() {
        recorder.onStatus = { [weak self] in self?.emit(error: nil) }
        recorder.onError = { [weak self] message in self?.emit(error: message) }
        SegmentUploader.shared.onChange = { [weak self] in self?.emit(error: nil) }
        // 지난 실행에서 못 올린 세그먼트·공백·종료 선언을 다시 등록한다.
        SegmentUploader.shared.resumeAll()
    }

    private func status() -> [String: Any] {
        var o: [String: Any] = [
            "state": recorder.state.rawValue,
            "pendingUploads": SessionStore.pendingUploads(),
        ]
        if let rid = recorder.recordingId, recorder.state != .idle {
            o["recordingId"] = rid
            o["elapsedMs"] = recorder.elapsedMs
            o["segmentCount"] = recorder.closedSegments
        }
        return o
    }

    private func emit(error: String?) {
        var payload = status()
        if let error { payload["error"] = error }
        notifyListeners("stateChange", data: payload)
    }

    private static func stopResult(_ s: RecordingSession) -> [String: Any] {
        ["recordingId": s.recordingId, "segmentCount": s.segmentCount, "durationMs": s.durationMs]
    }

    // MARK: - 메서드

    @objc func isAvailable(_ call: CAPPluginCall) {
        // 화면 꺼짐 녹음의 전제 — 이 모드가 있는 앱(코치 앱)에서만 쓴다.
        let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
        call.resolve(["available": modes.contains("audio")])
    }

    private static func permissionString() -> String {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(["microphone": Self.permissionString()])
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            call.resolve(["microphone": granted ? "granted" : "denied"])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard AVAudioSession.sharedInstance().recordPermission == .granted else {
            call.reject("마이크 권한이 필요해요", "permission_denied")
            return
        }
        guard let rid = call.getString("recordingId"),
              let base = call.getString("uploadBaseUrl"), base.hasPrefix("http"),
              let token = call.getString("uploadToken") else {
            call.reject("recordingId, uploadBaseUrl, uploadToken 이 필요해요", "invalid_arguments")
            return
        }
        let startedAt = Int64(Date().timeIntervalSince1970 * 1000)
        var trimmed = base
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        SessionStore.save(RecordingSession(recordingId: rid, uploadBaseUrl: trimmed,
                                           uploadToken: token, startedAt: startedAt))
        DispatchQueue.main.async {
            do {
                try self.recorder.start(recordingId: rid, segmentSec: call.getInt("segmentSec") ?? 60)
                call.resolve(["startedAt": startedAt])
            } catch {
                SessionStore.delete(rid)
                call.reject(error.localizedDescription, "start_failed", error)
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let s = self.recorder.stop() else {
                call.reject("녹음 중이 아니에요", "not_recording")
                return
            }
            call.resolve(Self.stopResult(s))
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(status())
    }

    @objc func listUnfinished(_ call: CAPPluginCall) {
        let activeId = recorder.state == .idle ? nil : recorder.recordingId
        let sessions = SessionStore.all()
            .filter { $0.state == RecordingSession.stateRecording && $0.recordingId != activeId }
            .map { s -> [String: Any] in
                ["recordingId": s.recordingId, "startedAt": s.startedAt,
                 "segmentCount": s.segmentCount, "durationMs": s.durationMs]
            }
        call.resolve(["sessions": sessions])
    }

    @objc func finishUnfinished(_ call: CAPPluginCall) {
        guard let rid = call.getString("recordingId"), let current = SessionStore.load(rid) else {
            call.reject("녹음 기록을 찾지 못했어요", "no_session")
            return
        }
        // 앱이 죽을 때 쓰던 세그먼트는 마무리되지 않아 재생할 수 없다 — 잃는 것은 최대 60초.
        try? FileManager.default.removeItem(at: SessionStore.segmentURL(rid, current.segmentCount))
        guard let s = SessionStore.update(rid, { $0.state = RecordingSession.stateStopped }) else {
            call.reject("녹음 기록을 찾지 못했어요", "no_session")
            return
        }
        SegmentUploader.shared.resumeAll()
        call.resolve(Self.stopResult(s))
    }

    @objc func discardUnfinished(_ call: CAPPluginCall) {
        if let rid = call.getString("recordingId") { SessionStore.delete(rid) }
        call.resolve()
        emit(error: nil)
    }
}
