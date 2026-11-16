import AVFoundation
import Foundation

/// 화면이 꺼져도 도는 레슨 녹음기.
///
/// - Info.plist 의 UIBackgroundModes=audio 와 활성 녹음 세션 덕분에 잠금
///   화면에서도 앱이 살아 있다.
/// - AVAudioEngine 입력을 16kHz 모노로 변환해 AAC(.m4a)로 쓰고, 60초마다
///   **파일만** 갈아 끼운다. 입력은 끊지 않으므로 경계에서 소리가 빠지지 않는다.
/// - 전화 수신 등 인터럽션이 끝나면 스스로 다시 녹음하고, 끊긴 구간을
///   공백(gap)으로 서버에 알린다.
final class RecorderEngine {
    static let shared = RecorderEngine()

    enum State: String { case idle, recording, interrupted }

    private static let sampleRate: Double = 16_000

    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "com.coachxai.lessonrecorder.write")
    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                          sampleRate: RecorderEngine.sampleRate,
                                          channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?
    private var file: AVAudioFile?
    private var observers: [NSObjectProtocol] = []

    // 아래 상태는 queue 위에서만 고친다.
    private(set) var recordingId: String?
    private var seq = 0
    private var segmentFrames: AVAudioFramePosition = 0
    private var totalFrames: AVAudioFramePosition = 0
    private var segmentLimitFrames: AVAudioFramePosition = 60 * 16_000
    private var interruptionStartMs: Int64?
    private var interruptionWall: Date?

    private(set) var state: State = .idle
    var onStatus: (() -> Void)?
    var onError: ((String) -> Void)?

    /// 알림은 항상 메인에서 보낸다. 쓰기 큐 안에서 바로 부르면, 받는 쪽의
    /// 상태 조회(elapsedMs → queue.sync)가 같은 큐를 기다리며 멈춘다.
    private func notifyStatus() {
        DispatchQueue.main.async { [weak self] in self?.onStatus?() }
    }

    private func notifyError(_ message: String) {
        DispatchQueue.main.async { [weak self] in self?.onError?(message) }
    }

    var elapsedMs: Int64 { queue.sync { totalFrames * 1000 / Int64(Self.sampleRate) } }
    var closedSegments: Int { queue.sync { seq } }

    // MARK: - 시작 / 종료

    func start(recordingId rid: String, segmentSec: Int) throws {
        guard state == .idle else { throw RecorderError.alreadyRecording }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default, options: [.allowBluetooth])
        try session.setActive(true)

        try queue.sync {
            recordingId = rid
            seq = 0
            totalFrames = 0
            segmentLimitFrames = AVAudioFramePosition(max(10, segmentSec)) * AVAudioFramePosition(Self.sampleRate)
            try openSegment()
        }
        do {
            try startEngine()
        } catch {
            queue.sync { _ = closeSegment() }
            try? session.setActive(false)
            throw error
        }
        state = .recording
        observe()
        notifyStatus()
    }

    /// 녹음을 멈추고 마지막 세그먼트를 닫는다. 닫힌 세션 기록을 돌려준다.
    func stop() -> RecordingSession? {
        guard let rid = recordingId, state != .idle else { return nil }
        removeObservers()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        queue.sync {
            // 인터럽션 도중 종료 — 그 공백도 기록한다.
            if let start = interruptionStartMs, let wall = interruptionWall {
                recordGap(rid, startMs: start, wall: wall, reason: "interrupted")
            }
            interruptionStartMs = nil
            _ = closeSegment()
            recordingId = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        state = .idle
        let s = SessionStore.update(rid) { $0.state = RecordingSession.stateStopped }
        SegmentUploader.shared.enqueueComplete(rid)
        notifyStatus()
        return s
    }

    // MARK: - 엔진

    private func startEngine() throws {
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, inFormat.channelCount > 0,
              let conv = AVAudioConverter(from: inFormat, to: outFormat) else {
            throw RecorderError.noInput
        }
        queue.sync { converter = conv }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
            self?.queue.async { self?.consume(buffer) }
        }
        engine.prepare()
        try engine.start()
    }

    /// queue 위에서 호출.
    private func consume(_ buffer: AVAudioPCMBuffer) {
        guard let converter, let file, buffer.frameLength > 0 else { return }
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var fed = false
        var convError: NSError?
        let status = converter.convert(to: out, error: &convError) { _, inputStatus in
            if fed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, out.frameLength > 0 else { return }
        do {
            try file.write(from: out)
        } catch {
            NSLog("[LessonRecorder] write failed: \(error)")
            notifyError("녹음 파일을 쓰지 못했어요")
            return
        }
        segmentFrames += AVAudioFramePosition(out.frameLength)
        totalFrames += AVAudioFramePosition(out.frameLength)
        if segmentFrames >= segmentLimitFrames {
            if closeSegment() { seq += 1 }
            do { try openSegment() } catch {
                NSLog("[LessonRecorder] open segment failed: \(error)")
                notifyError("다음 녹음 조각을 만들지 못했어요")
            }
            notifyStatus()
        }
    }

    /// queue 위에서 호출.
    private func openSegment() throws {
        guard let rid = recordingId else { return }
        let url = SessionStore.segmentURL(rid, seq)
        try? FileManager.default.removeItem(at: url)
        var settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: Self.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32_000,
        ]
        do {
            file = try AVAudioFile(forWriting: url, settings: settings,
                                   commonFormat: .pcmFormatFloat32, interleaved: false)
        } catch {
            // 일부 기기는 이 조합의 비트레이트를 거절한다 — 기본값으로 다시.
            settings[AVEncoderBitRateKey] = nil
            settings[AVEncoderAudioQualityKey] = AVAudioQuality.medium.rawValue
            file = try AVAudioFile(forWriting: url, settings: settings,
                                   commonFormat: .pcmFormatFloat32, interleaved: false)
        }
        segmentFrames = 0
    }

    /// queue 위에서 호출. 오디오가 담긴 세그먼트를 닫았으면 true.
    @discardableResult
    private func closeSegment() -> Bool {
        guard let rid = recordingId else { return false }
        let frames = segmentFrames
        file = nil // AVAudioFile 은 해제될 때 파일을 마무리(moov)한다.
        segmentFrames = 0
        let url = SessionStore.segmentURL(rid, seq)
        guard frames > 0 else {
            try? FileManager.default.removeItem(at: url)
            return false
        }
        let durationMs = frames * 1000 / AVAudioFramePosition(Self.sampleRate)
        let closedSeq = seq
        SessionStore.update(rid) { s in
            if !s.segments.contains(where: { $0.seq == closedSeq }) {
                s.segments.append(.init(seq: closedSeq, durationMs: durationMs))
            }
        }
        SegmentUploader.shared.enqueueSegment(rid, closedSeq)
        return true
    }

    /// queue 위에서 호출. startMs 는 오디오 타임라인 위치, endMs-startMs 는 실제로 끊겼던 시간.
    private func recordGap(_ rid: String, startMs: Int64, wall: Date, reason: String) {
        let lost = Int64(Date().timeIntervalSince(wall) * 1000)
        SessionStore.update(rid) { s in
            if !s.gaps.contains(where: { $0.startMs == startMs }) {
                s.gaps.append(.init(startMs: startMs, endMs: startMs + max(0, lost), reason: reason))
            }
        }
        SegmentUploader.shared.enqueueGap(rid, startMs: startMs)
    }

    // MARK: - 인터럽션 · 경로 변경

    private func observe() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification,
                                        object: nil, queue: .main) { [weak self] note in
            self?.handleInterruption(note)
        })
        // 이어폰 연결·해제 등으로 입력 형식이 바뀌면 엔진이 멈춘다 — 다시 건다.
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange,
                                        object: engine, queue: .main) { [weak self] _ in
            guard let self, self.state == .recording else { return }
            self.restartEngine(attempt: 0)
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification,
                                        object: nil, queue: .main) { [weak self] _ in
            guard let self, self.state != .idle else { return }
            try? AVAudioSession.sharedInstance().setCategory(.record, mode: .default, options: [.allowBluetooth])
            try? AVAudioSession.sharedInstance().setActive(true)
            self.restartEngine(attempt: 0)
        })
    }

    private func removeObservers() {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
    }

    private func handleInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            guard state == .recording else { return }
            state = .interrupted
            queue.sync {
                interruptionStartMs = totalFrames * 1000 / Int64(Self.sampleRate)
                interruptionWall = Date()
            }
            notifyStatus()
        case .ended:
            guard state == .interrupted else { return }
            // shouldResume 이 없어도 다시 건다 — 레슨 녹음은 사용자가 끝낼 때까지 계속돼야 한다.
            try? AVAudioSession.sharedInstance().setActive(true)
            restartEngine(attempt: 0)
        @unknown default:
            break
        }
    }

    private func restartEngine(attempt: Int) {
        engine.stop()
        do {
            try startEngine()
            if state == .interrupted, let rid = recordingId {
                queue.sync {
                    if let start = interruptionStartMs, let wall = interruptionWall {
                        recordGap(rid, startMs: start, wall: wall, reason: "interrupted")
                    }
                    interruptionStartMs = nil
                    interruptionWall = nil
                }
            }
            state = .recording
            notifyStatus()
        } catch {
            NSLog("[LessonRecorder] restart failed (\(attempt)): \(error)")
            guard attempt < 30 else {
                notifyError("녹음을 다시 시작하지 못했어요. 앱을 열어 확인해 주세요")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let self, self.state != .idle else { return }
                try? AVAudioSession.sharedInstance().setActive(true)
                self.restartEngine(attempt: attempt + 1)
            }
        }
    }
}

enum RecorderError: LocalizedError {
    case alreadyRecording
    case noInput

    var errorDescription: String? {
        switch self {
        case .alreadyRecording: return "이미 녹음 중이에요"
        case .noInput: return "마이크 입력을 찾지 못했어요"
        }
    }
}
