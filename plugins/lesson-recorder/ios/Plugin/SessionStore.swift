import Foundation

/// 녹음 세션의 디스크 기록 — Application Support/lesson-recordings/{recordingId}/session.json
///
/// 앱이 죽어도 남아야 하는 것(업로드 주소·토큰, 닫힌 세그먼트, 공백, 종료
/// 여부)을 여기 둔다. 녹음 큐·업로드 델리게이트가 동시에 고치므로 모든
/// 접근은 lock 으로 직렬화한다.
struct RecordingSession: Codable {
    struct Segment: Codable {
        var seq: Int
        var durationMs: Int64
        var uploaded = false
        var failed = false
    }

    struct Gap: Codable {
        var startMs: Int64
        var endMs: Int64
        var reason: String
        var sent = false
    }

    static let stateRecording = "recording"
    static let stateStopped = "stopped"

    var recordingId: String
    var uploadBaseUrl: String
    var uploadToken: String
    var startedAt: Int64
    var state = RecordingSession.stateRecording
    var completeSent = false
    var segments: [Segment] = []
    var gaps: [Gap] = []

    var segmentCount: Int { segments.count }
    var durationMs: Int64 { segments.reduce(0) { $0 + $1.durationMs } }
    var allSettled: Bool { segments.allSatisfy { $0.uploaded || $0.failed } && gaps.allSatisfy { $0.sent } }
}

enum SessionStore {
    private static let lock = NSLock()

    static var root: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var url = base.appendingPathComponent("lesson-recordings", isDirectory: true)
        if !FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            // 업로드 대기 버퍼일 뿐이다 — iCloud 백업에 싣지 않는다.
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
        }
        return url
    }

    static func dir(_ rid: String) -> URL {
        root.appendingPathComponent(rid, isDirectory: true)
    }

    static func segmentURL(_ rid: String, _ seq: Int) -> URL {
        dir(rid).appendingPathComponent(String(format: "seg-%04d.m4a", seq))
    }

    static func load(_ rid: String) -> RecordingSession? {
        lock.lock(); defer { lock.unlock() }
        return unlockedLoad(rid)
    }

    private static func unlockedLoad(_ rid: String) -> RecordingSession? {
        let url = dir(rid).appendingPathComponent("session.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(RecordingSession.self, from: data)
    }

    static func save(_ s: RecordingSession) {
        lock.lock(); defer { lock.unlock() }
        unlockedSave(s)
    }

    private static func unlockedSave(_ s: RecordingSession) {
        let d = dir(s.recordingId)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(s) else { return }
        // .atomic: 임시 파일에 쓰고 교체 — 저장 도중 죽어도 이전 기록이 남는다.
        try? data.write(to: d.appendingPathComponent("session.json"), options: .atomic)
    }

    /// 읽고-고치고-쓰기를 한 번에. 세션이 없으면 nil.
    @discardableResult
    static func update(_ rid: String, _ mutate: (inout RecordingSession) -> Void) -> RecordingSession? {
        lock.lock(); defer { lock.unlock() }
        guard var s = unlockedLoad(rid) else { return nil }
        mutate(&s)
        unlockedSave(s)
        if s.state == RecordingSession.stateStopped && s.completeSent && s.allSettled {
            try? FileManager.default.removeItem(at: dir(rid))
        }
        return s
    }

    static func all() -> [RecordingSession] {
        lock.lock(); defer { lock.unlock() }
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return dirs.compactMap { unlockedLoad($0.lastPathComponent) }
    }

    static func delete(_ rid: String) {
        lock.lock(); defer { lock.unlock() }
        try? FileManager.default.removeItem(at: dir(rid))
    }

    static func pendingUploads() -> Int {
        all().reduce(0) { n, s in
            n + s.segments.filter { !$0.uploaded && !$0.failed }.count
                + s.gaps.filter { !$0.sent }.count
                + (s.state == RecordingSession.stateStopped && !s.completeSent ? 1 : 0)
        }
    }
}
