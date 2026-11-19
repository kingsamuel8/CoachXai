#!/usr/bin/env python3
"""
합성 레슨 음성 만들기 — 받아쓰기 엔진 비교(PoC) 파이프라인 점검용.

evals/stt/synthetic/script.json 의 대본을 OpenAI TTS 로 코치/학생 두 목소리로
읽히고, 대본의 pause 구간에는 말소리 없이 실내 잡음·타구음만 넣는다.
앱 녹음기와 같은 형식(AAC 16kHz 모노 32kbps .m4a)으로 저장하고, 각 줄이
몇 ms 에 놓였는지를 정답 타임라인(golden.json)으로 남긴다.

함께 만드는 silence.m4a(30초, 말소리 없음)는 "무음에서 말을 지어내는가"
탈락 검사용이다.

    python3 scripts/stt-poc/synth_lesson.py

필요: ffmpeg, numpy, curl. OpenAI 키는 환경의 네트워크 비밀로 주입된다.
"""
import json
import pathlib
import subprocess
import sys
import tempfile

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "evals" / "stt" / "synthetic"
SR = 16_000
VOICES = {"coach": "onyx", "student": "nova"}
INSTRUCTIONS = {
    "coach": "실내 골프 연습장에서 레슨하는 한국인 남성 골프 코치. 자연스럽고 친근한 말투, 보통 속도.",
    "student": "골프를 배우는 한국인 성인 학생. 자연스러운 대화체, 보통 속도.",
}
LINE_GAP_SEC = 0.7
SPEECH_GAIN = 0.45  # 휴대폰이 몇 미터 떨어진 정도
rng = np.random.default_rng(7)


def tts(text: str, speaker: str, path: pathlib.Path) -> None:
    body = json.dumps({
        "model": "gpt-4o-mini-tts",
        "voice": VOICES[speaker],
        "input": text,
        "instructions": INSTRUCTIONS[speaker],
        "response_format": "wav",
    })
    r = subprocess.run(
        ["curl", "-sS", "--fail-with-body", "--max-time", "120", "-o", str(path),
         "-H", "Authorization: Bearer proxy-injected",
         "-H", "Content-Type: application/json",
         "--data-binary", "@-", "https://api.openai.com/v1/audio/speech"],
        input=body.encode(), capture_output=True,
    )
    if r.returncode != 0:
        sys.exit(f"TTS failed: {r.stderr.decode()} {path.read_text(errors='ignore')[:300] if path.exists() else ''}")


def load(path: pathlib.Path) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def room_noise(n: int, level: float = 0.004) -> np.ndarray:
    # 저역이 강한 실내 잡음(공조기 소리 비슷하게): 백색 잡음을 한 번 적분해 갈색 쪽으로.
    w = rng.standard_normal(n).astype(np.float32)
    b = np.cumsum(w)
    b -= np.convolve(b, np.ones(400) / 400, mode="same")  # 직류 성분 제거
    b /= np.max(np.abs(b)) + 1e-9
    return (b * level + w * level * 0.3).astype(np.float32)


def impact(n_total: int, at: int) -> np.ndarray:
    # 타구음 "탁": 80ms 감쇠 잡음 + 짧은 저음 울림.
    out = np.zeros(n_total, dtype=np.float32)
    L = int(0.08 * SR)
    t = np.arange(L) / SR
    burst = rng.standard_normal(L).astype(np.float32) * np.exp(-t * 60)
    thump = np.sin(2 * np.pi * 180 * t) * np.exp(-t * 40)
    seg = (burst * 0.5 + thump * 0.3).astype(np.float32)
    end = min(n_total, at + L)
    out[at:end] += seg[: end - at]
    return out


def pause_audio(sec: float, kind: str) -> np.ndarray:
    n = int(sec * SR)
    a = np.zeros(n, dtype=np.float32)
    if kind == "impacts":
        for frac in (0.25, 0.7):
            a += impact(n, int(n * frac))
    return a


def encode(samples: np.ndarray, path: pathlib.Path) -> None:
    pcm = np.clip(samples, -1, 1).astype(np.float32).tobytes()
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
         "-c:a", "aac", "-b:a", "32k", "-ar", str(SR), "-ac", "1", str(path)],
        input=pcm, check=True,
    )


def main() -> None:
    script = json.loads((OUT / "script.json").read_text())
    timeline, chunks, silences = [], [], []
    cursor = int(0.5 * SR)
    chunks.append(np.zeros(cursor, dtype=np.float32))
    with tempfile.TemporaryDirectory() as tmp:
        for i, line in enumerate(script["lines"]):
            if "pause_sec" in line:
                a = pause_audio(line["pause_sec"], line.get("noise", "room"))
                silences.append({"startMs": cursor * 1000 // SR,
                                 "endMs": (cursor + len(a)) * 1000 // SR,
                                 "kind": line.get("noise", "room")})
            else:
                wav = pathlib.Path(tmp) / f"{i:02d}.wav"
                tts(line["text"], line["speaker"], wav)
                a = load(wav) * SPEECH_GAIN
                timeline.append({"idx": len(timeline), "speaker": line["speaker"], "text": line["text"],
                                 "startMs": cursor * 1000 // SR,
                                 "endMs": (cursor + len(a)) * 1000 // SR})
                print(f"  [{line['speaker']}] {line['text'][:30]}…", file=sys.stderr)
            chunks.append(a)
            cursor += len(a)
            gap = np.zeros(int(LINE_GAP_SEC * SR), dtype=np.float32)
            chunks.append(gap)
            cursor += len(gap)

    audio = np.concatenate(chunks)
    audio += room_noise(len(audio))
    encode(audio, OUT / "lesson.m4a")

    # 말소리 없는 30초: 실내 잡음 + 타구음 6번.
    n = 30 * SR
    quiet = room_noise(n)
    for frac in (0.1, 0.25, 0.4, 0.55, 0.7, 0.85):
        quiet += impact(n, int(n * frac))
    encode(quiet, OUT / "silence.m4a")

    golden = {
        "id": script["id"],
        "audio": "lesson.m4a",
        "durationMs": len(audio) * 1000 // SR,
        "terms": script["terms"],
        "lines": timeline,
        "silences": silences,
    }
    (OUT / "golden.json").write_text(json.dumps(golden, ensure_ascii=False, indent=2) + "\n")
    print(f"lesson.m4a {golden['durationMs']/1000:.1f}s, {len(timeline)} lines, {len(silences)} silent windows",
          file=sys.stderr)


if __name__ == "__main__":
    main()
