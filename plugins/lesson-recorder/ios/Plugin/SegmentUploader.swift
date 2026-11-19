import Foundation

/// 세그먼트·공백·종료 선언 업로드 — 백그라운드 URLSession.
///
/// 백그라운드 세션의 작업은 앱이 정지되거나 화면이 꺼져도 OS 가 이어서
/// 보낸다. 서버는 같은 업로드의 재전송을 그대로 받아 주므로(멱등), 앱이
/// 재실행될 때 디스크에 남은 것을 다시 등록해도 문제가 없다.
final class SegmentUploader: NSObject, URLSessionTaskDelegate {
    static let shared = SegmentUploader()
    static let sessionIdentifier = "com.coachxai.lessonrecorder.upload"
    /// 이만큼 재시도해도 안 되면 포기.
    private static let maxAttempts = 40

    var onChange: (() -> Void)?

    private var attempts: [String: Int] = [:]
    private let attemptsLock = NSLock()

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.timeoutIntervalForRequest = 60
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    // MARK: - 등록

    func enqueueSegment(_ rid: String, _ seq: Int) {
        guard let s = SessionStore.load(rid),
              let seg = s.segments.first(where: { $0.seq == seq }), !seg.uploaded, !seg.failed else { return }
        let file = SessionStore.segmentURL(rid, seq)
        guard FileManager.default.fileExists(atPath: file.path),
              var req = request(s, path: "/segments/\(seq)", method: "PUT") else { return }
        req.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        req.setValue(String(seg.durationMs), forHTTPHeaderField: "x-segment-duration-ms")
        let task = session.uploadTask(with: req, fromFile: file)
        task.taskDescription = "\(rid)|segment|\(seq)"
        task.resume()
    }

    func enqueueGap(_ rid: String, startMs: Int64) {
        guard let s = SessionStore.load(rid),
              let gap = s.gaps.first(where: { $0.startMs == startMs }), !gap.sent else { return }
        let body: [String: Any] = ["startMs": gap.startMs, "endMs": gap.endMs, "reason": gap.reason]
        postJSON(s, path: "/gaps", body: body, file: "gap-\(startMs).json", desc: "\(rid)|gap|\(startMs)")
    }

    func enqueueComplete(_ rid: String) {
        guard let s = SessionStore.load(rid), s.state == RecordingSession.stateStopped, !s.completeSent else { return }
        let body: [String: Any] = ["segmentCount": s.segmentCount, "durationMs": s.durationMs]
        postJSON(s, path: "/complete", body: body, file: "complete.json", desc: "\(rid)|complete|0")
    }

    /// 디스크에 남은 업로드 중 진행 중이 아닌 것을 다시 등록한다 — 앱 시작 시.
    func resumeAll() {
        session.getAllTasks { tasks in
            let inFlight = Set(tasks.compactMap { $0.taskDescription })
            for s in SessionStore.all() {
                for seg in s.segments where !seg.uploaded && !seg.failed {
                    if !inFlight.contains("\(s.recordingId)|segment|\(seg.seq)") {
                        self.enqueueSegment(s.recordingId, seg.seq)
                    }
                }
                for gap in s.gaps where !gap.sent {
                    if !inFlight.contains("\(s.recordingId)|gap|\(gap.startMs)") {
                        self.enqueueGap(s.recordingId, startMs: gap.startMs)
                    }
                }
                if s.state == RecordingSession.stateStopped && !s.completeSent
                    && !inFlight.contains("\(s.recordingId)|complete|0") {
                    self.enqueueComplete(s.recordingId)
                }
            }
        }
    }

    private func request(_ s: RecordingSession, path: String, method: String) -> URLRequest? {
        guard let url = URL(string: s.uploadBaseUrl + path) else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(s.uploadToken)", forHTTPHeaderField: "Authorization")
        return req
    }

    /// 백그라운드 세션은 파일 업로드만 받으므로 JSON 도 파일로 써서 보낸다.
    private func postJSON(_ s: RecordingSession, path: String, body: [String: Any], file: String, desc: String) {
        guard var req = request(s, path: path, method: "POST"),
              let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        let url = SessionStore.dir(s.recordingId).appendingPathComponent(file)
        do { try data.write(to: url, options: .atomic) } catch { return }
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let task = session.uploadTask(with: req, fromFile: url)
        task.taskDescription = desc
        task.resume()
    }

    // MARK: - 결과

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let desc = task.taskDescription else { return }
        let parts = desc.split(separator: "|").map(String.init)
        guard parts.count == 3 else { return }
        let (rid, kind, key) = (parts[0], parts[1], parts[2])
        let code = (task.response as? HTTPURLResponse)?.statusCode ?? 0

        if error == nil && (200..<300).contains(code) {
            settle(rid, kind, key, failed: false)
            attemptsLock.lock(); attempts[desc] = nil; attemptsLock.unlock()
            return
        }
        let retryable = error != nil || code == 408 || code == 429 || code >= 500
        attemptsLock.lock()
        let n = (attempts[desc] ?? 0) + 1
        attempts[desc] = n
        attemptsLock.unlock()
        if retryable && n < Self.maxAttempts {
            let delay = min(pow(2.0, Double(n)), 300)
            DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.retry(rid, kind, key)
            }
        } else {
            // 토큰 만료·녹음 없음 등 다시 보내도 소용없는 거절.
            NSLog("[LessonRecorder] upload \(desc) gave up: HTTP \(code) \(String(describing: error))")
            settle(rid, kind, key, failed: true)
        }
    }

    private func retry(_ rid: String, _ kind: String, _ key: String) {
        switch kind {
        case "segment": if let seq = Int(key) { enqueueSegment(rid, seq) }
        case "gap": if let ms = Int64(key) { enqueueGap(rid, startMs: ms) }
        default: enqueueComplete(rid)
        }
    }

    private func settle(_ rid: String, _ kind: String, _ key: String, failed: Bool) {
        switch kind {
        case "segment":
            guard let seq = Int(key) else { return }
            if !failed { try? FileManager.default.removeItem(at: SessionStore.segmentURL(rid, seq)) }
            SessionStore.update(rid) { s in
                if let i = s.segments.firstIndex(where: { $0.seq == seq }) {
                    if failed { s.segments[i].failed = true } else { s.segments[i].uploaded = true }
                }
            }
        case "gap":
            guard let ms = Int64(key) else { return }
            SessionStore.update(rid) { s in
                if let i = s.gaps.firstIndex(where: { $0.startMs == ms }) { s.gaps[i].sent = true }
            }
        default:
            // 종료 선언을 끝내 못 보냈어도 기기 기록은 정리한다 — 서버 정리
            // 러너가 3일 뒤 원본을 지운다.
            SessionStore.update(rid) { s in s.completeSent = true }
        }
        onChange?()
    }
}
