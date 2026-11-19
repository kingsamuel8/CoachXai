#!/usr/bin/env python3
"""
받아쓰기 엔진 비교(PoC) — 엔진별로 받아쓰고 정답과 채점한다.
(docs/VOICE_RECORDING_PLAN.md §6)

    python3 scripts/stt-poc/run_stt.py evals/stt/synthetic            # 전 엔진
    python3 scripts/stt-poc/run_stt.py evals/stt/synthetic --engines openai:gpt-transcribe

케이스 디렉터리에는 golden.json(정답)과 그 안의 audio 파일, 선택적으로
silence.m4a(말소리 없는 파일)가 있어야 한다. 결과는 <케이스>/results/ 에
엔진별 원문과 report.md 로 남는다.

채점 (기획서 §6)
  - 무음 창작: silence.m4a 에서 글자가 나오면 탈락. 화자 구분 엔진은 타임스탬프로
    본문 녹음의 무음 구간에 걸친 글자도 센다.
  - CER: 공백·문장부호를 뺀 글자 단위 편집 거리 / 정답 글자 수.
  - 골프 용어: 정답에 나온 용어 횟수 중 받아쓰기에도 나온 비율(공백 무시).
  - 화자: 화자 라벨이 있는 엔진만. 정답 줄의 가운데 시각에 걸린 구간의 라벨을
    다수결로 코치/학생에 대응시킨 뒤 맞힌 줄의 비율.

엔진 키는 네트워크 비밀로 프록시가 넣는다. 요청 헤더의 'proxy-injected' 는 자리표시자다.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys
import time
import unicodedata
from collections import Counter

# ─── 정규화 · 지표 ──────────────────────────────────────────────────────────

_NUM_KO = {"1": "일", "2": "이", "3": "삼", "4": "사", "5": "오", "6": "육", "7": "칠", "8": "팔", "9": "구", "0": "영"}


def normalize(text: str) -> str:
    """공백·문장부호 제거, 한 자리 숫자는 한글로(7번 ↔ 칠번을 같은 것으로 본다)."""
    t = unicodedata.normalize("NFC", text)
    t = "".join(_NUM_KO.get(c, c) for c in t)
    return re.sub(r"[^\w]", "", t).replace("_", "").lower()


def edit_ops(ref: str, hyp: str) -> tuple[int, int, int]:
    """(치환, 삭제, 삽입) — 글자 단위 Levenshtein."""
    n, m = len(ref), len(hyp)
    prev = [(j, 0, 0, j) for j in range(m + 1)]  # (cost, sub, del, ins)
    for i in range(1, n + 1):
        cur = [(i, 0, i, 0)] + [None] * m
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                cur[j] = prev[j - 1]
                continue
            s, d, ins = prev[j - 1], prev[j], cur[j - 1]
            best = min(
                (s[0] + 1, s[1] + 1, s[2], s[3]),
                (d[0] + 1, d[1], d[2] + 1, d[3]),
                (ins[0] + 1, ins[1], ins[2], ins[3] + 1),
            )
            cur[j] = best
        prev = cur
    _, sub, dele, ins = prev[m]
    return sub, dele, ins


def cer(ref: str, hyp: str) -> dict:
    r, h = normalize(ref), normalize(hyp)
    sub, dele, ins = edit_ops(r, h)
    return {"cer": (sub + dele + ins) / max(1, len(r)), "sub": sub, "del": dele, "ins": ins, "refChars": len(r)}


def term_recall(ref: str, hyp: str, terms: list[str]) -> dict:
    r, h = normalize(ref), normalize(hyp)
    hit = total = 0
    missed = []
    # 긴 용어부터 세고 지워서 "그립 압력" 안의 "그립"을 두 번 세지 않는다.
    for term in sorted(terms, key=len, reverse=True):
        t = normalize(term)
        rc, hc = r.count(t), h.count(t)
        if rc == 0:
            continue
        total += rc
        hit += min(rc, hc)
        if hc < rc:
            missed.append(term)
        r, h = r.replace(t, "\0"), h.replace(t, "\0")
    return {"recall": hit / total if total else 1.0, "hit": hit, "total": total, "missed": missed}


def speaker_accuracy(golden: dict, segments: list[dict]) -> dict | None:
    if not segments or not any(s.get("speaker") for s in segments):
        return None

    def at(ms: float):
        for s in segments:
            if s["startMs"] <= ms <= s["endMs"]:
                return s.get("speaker")
        return None

    votes: dict[str, Counter] = {}
    for line in golden["lines"]:
        lab = at((line["startMs"] + line["endMs"]) / 2)
        if lab is not None:
            votes.setdefault(lab, Counter())[line["speaker"]] += 1
    mapping = {lab: c.most_common(1)[0][0] for lab, c in votes.items()}
    ok = sum(
        1 for line in golden["lines"]
        if mapping.get(at((line["startMs"] + line["endMs"]) / 2)) == line["speaker"]
    )
    return {"accuracy": ok / len(golden["lines"]), "labels": len(votes), "mapping": mapping}


def text_in_silences(golden: dict, segments: list[dict]) -> int:
    """화자 구분 엔진: 무음 구간에 절반 이상 걸친 구간의 글자 수."""
    n = 0
    for s in segments:
        dur = max(1, s["endMs"] - s["startMs"])
        for w in golden.get("silences", []):
            overlap = min(s["endMs"], w["endMs"]) - max(s["startMs"], w["startMs"])
            if overlap / dur >= 0.5:
                n += len(normalize(s["text"]))
    return n


# ─── 엔진 ───────────────────────────────────────────────────────────────────


def _curl_json(args: list[str]) -> dict:
    r = subprocess.run(["curl", "-sS", "--max-time", "900", "-w", "\n%{http_code}", *args],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    body, _, code = r.stdout.rpartition("\n")
    if not code.startswith("2"):
        raise RuntimeError(f"HTTP {code}: {body[:400]}")
    return json.loads(body)


def openai_engine(model: str, use_prompt: bool):
    def run(audio: pathlib.Path, terms: list[str]) -> dict:
        args = ["-H", "Authorization: Bearer proxy-injected",
                "-F", f"file=@{audio}",
                "--form-string", f"model={model}",
                "--form-string", "language=ko"]
        if model.endswith("-diarize"):
            # 30초 넘는 오디오는 chunking_strategy 가 필요하고, prompt 는 받지 않는다.
            args += ["--form-string", "response_format=diarized_json",
                     "--form-string", "chunking_strategy=auto"]
        else:
            args += ["--form-string", "response_format=json"]
            if use_prompt:
                args += ["--form-string",
                         "prompt=골프 레슨 녹음. 코치와 학생의 대화. 용어: " + ", ".join(terms)]
        d = _curl_json(args + ["https://api.openai.com/v1/audio/transcriptions"])
        segs = [
            {"startMs": s["start"] * 1000, "endMs": s["end"] * 1000,
             "speaker": s.get("speaker"), "text": s.get("text", "")}
            for s in d.get("segments", [])
        ]
        return {"text": d.get("text") or " ".join(s["text"] for s in segs), "segments": segs}

    return run


def _dur_ms(v) -> float:
    # Speech v2 Duration 은 "12.340s" 문자열로 온다.
    return float(str(v or "0s").rstrip("s") or 0) * 1000


def elevenlabs_engine(model: str, use_keyterms: bool, num_speakers: int | None = None):
    """ElevenLabs Speech-to-Text (Scribe). 키는 xi-api-key 헤더로 프록시가 넣는다."""

    def run(audio: pathlib.Path, terms: list[str]) -> dict:
        args = ["-H", "xi-api-key: proxy-injected",
                "-F", f"file=@{audio}",
                "--form-string", f"model_id={model}",
                "--form-string", "language_code=kor",
                "--form-string", "diarize=true",
                "--form-string", "tag_audio_events=false",
                "--form-string", "timestamps_granularity=word"]
        if num_speakers:
            args += ["--form-string", f"num_speakers={num_speakers}"]
        if use_keyterms:
            for t in terms[:100]:
                args += ["--form-string", f"keyterms={t}"]
        d = _curl_json(args + ["https://api.elevenlabs.io/v1/speech-to-text"])
        segs: list[dict] = []
        for w in d.get("words", []):
            if w.get("type") != "word":
                continue
            start, end = float(w.get("start", 0)) * 1000, float(w.get("end", 0)) * 1000
            spk = w.get("speaker_id")
            if segs and segs[-1]["speaker"] == spk and 0 <= start - segs[-1]["endMs"] < 1500:
                segs[-1]["endMs"] = end
                segs[-1]["text"] += " " + w.get("text", "")
            else:
                segs.append({"startMs": start, "endMs": end, "speaker": spk, "text": w.get("text", "")})
        return {"text": d.get("text", ""), "segments": segs}

    return run


CHIRP3_MAX_CHUNK_SEC = 18 * 60  # BatchRecognize 는 파일당 20분까지 — 여유를 둔다


def google_chirp3_engine(diarize: bool, use_phrases: bool):
    """
    Google Speech-to-Text v2 BatchRecognize(chirp_3, location us).
    필요 환경 변수: GOOGLE_STT_KEY_FILE(서비스 계정 JSON 경로), GOOGLE_STT_BUCKET.

    제약(2026-11-19 확인)
      - 버킷의 m4a(AAC)는 code 13 으로 실패 → FLAC 로 바꿔 올린다.
      - 파일당 20분까지 → 18분 조각으로 잘라 한 요청에 같이 보내고 시간을 이어 붙인다.
        화자 번호는 조각마다 따로 매겨지므로 "조각번호:화자" 로 구분한다
        (조각을 넘어 같은 사람인지는 알 수 없다 — 이 엔진의 실사용상 약점).
      - inline phrase set(용어 힌트)을 넣으면 code 13 → use_phrases=False 로 쓴다.
    """
    import os
    import tempfile

    def run(audio: pathlib.Path, terms: list[str]) -> dict:
        key_file = os.environ["GOOGLE_STT_KEY_FILE"]
        bucket = os.environ["GOOGLE_STT_BUCKET"]
        project = json.load(open(key_file))["project_id"]
        token = subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("gcp_token.py")), key_file],
                               capture_output=True, text=True, check=True).stdout.strip()
        auth = ["-H", f"Authorization: Bearer {token}"]
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                    "-of", "csv=p=0", str(audio)], capture_output=True, text=True,
                                   check=True).stdout.strip())
        n_chunks = max(1, int(-(-dur // CHIRP3_MAX_CHUNK_SEC)))
        chunk_sec = dur / n_chunks
        stamp = int(time.time())
        uris: list[tuple[str, str, float]] = []  # (uri, object, offset_sec)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                for i in range(n_chunks):
                    off = i * chunk_sec
                    flac = pathlib.Path(tmp) / f"c{i}.flac"
                    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{off:.3f}", "-t", f"{chunk_sec:.3f}",
                                    "-i", str(audio), "-ac", "1", "-ar", "16000", "-c:a", "flac", str(flac)],
                                   check=True)
                    obj = f"stt-poc/{stamp}-{audio.stem}-c{i}.flac"
                    _curl_json([*auth, "-H", "Content-Type: audio/flac", "--data-binary", f"@{flac}",
                                f"https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?uploadType=media&name={obj}"])
                    uris.append((f"gs://{bucket}/{obj}", obj, off))

            features: dict = {"enableWordTimeOffsets": True, "enableAutomaticPunctuation": True}
            if diarize:
                features["diarizationConfig"] = {"minSpeakerCount": 1, "maxSpeakerCount": 3}
            config: dict = {"autoDecodingConfig": {}, "languageCodes": ["ko-KR"], "model": "chirp_3",
                            "features": features}
            if use_phrases:
                config["adaptation"] = {"phraseSets": [{"inlinePhraseSet": {
                    "phrases": [{"value": t, "boost": 10} for t in terms]}}]}
            # inlineResponseConfig 는 요청당 파일 하나만 받는다 — 조각마다 따로 보내 동시에 기다린다.
            base = "https://us-speech.googleapis.com/v2"
            ops = []
            for u, _, _ in uris:
                body = json.dumps({"config": config, "files": [{"uri": u}],
                                   "recognitionOutputConfig": {"inlineResponseConfig": {}}})
                ops.append(_curl_json([*auth, "-H", "Content-Type: application/json", "--data-binary", body,
                                       f"{base}/projects/{project}/locations/us/recognizers/_:batchRecognize"]))
            for _ in range(360):  # 최대 30분
                if all(o.get("done") for o in ops):
                    break
                time.sleep(5)
                ops = [o if o.get("done") else _curl_json([*auth, f"{base}/{o['name']}"]) for o in ops]
            per_chunk = []
            for (u, _, off), op in zip(uris, ops):
                if not op.get("done"):
                    raise RuntimeError("timed out waiting for BatchRecognize")
                if "error" in op:
                    raise RuntimeError(json.dumps(op["error"], ensure_ascii=False)[:400])
                file_res = op["response"]["results"][u]
                if "error" in file_res:
                    raise RuntimeError(json.dumps(file_res["error"], ensure_ascii=False)[:400])
                per_chunk.append((off, file_res.get("inlineResult", {}).get("transcript", {}).get("results", [])))
        finally:
            for _, obj, _ in uris:
                subprocess.run(["curl", "-sS", "-o", "/dev/null", "-X", "DELETE", *auth,
                                f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{obj.replace('/', '%2F')}"])

        # chirp_3 결과는 시간순이 아니고 일부 구간이 겹쳐 두 번 들어온다(65분 레슨에서 약 7%,
        # 2026-11-19 확인). 단어를 절대 시각으로 모아 정렬하고, 같은 단어가 0.5초 안에
        # 다시 나오면 중복으로 버린다. 받아쓰기 원문도 이 단어열로 다시 만든다.
        words = []
        for ci, (off, results) in enumerate(per_chunk):
            off_ms = off * 1000
            for r in results:
                alt = (r.get("alternatives") or [{}])[0]
                for w in alt.get("words", []):
                    lab = w.get("speakerLabel")
                    words.append({
                        "startMs": off_ms + _dur_ms(w.get("startOffset")),
                        "endMs": off_ms + _dur_ms(w.get("endOffset")),
                        "speaker": (f"{ci}:{lab}" if n_chunks > 1 else lab) if (diarize and lab) else None,
                        "word": w.get("word", ""),
                    })
        words.sort(key=lambda w: (w["startMs"], w["endMs"]))
        deduped = []
        for w in words:
            if any(p["word"] == w["word"] and abs(p["startMs"] - w["startMs"]) < 500 for p in deduped[-8:]):
                continue
            deduped.append(w)
        segs = []
        for w in deduped:
            if segs and segs[-1]["speaker"] == w["speaker"] and 0 <= w["startMs"] - segs[-1]["endMs"] < 1500:
                segs[-1]["endMs"] = max(segs[-1]["endMs"], w["endMs"])
                segs[-1]["text"] += " " + w["word"]
            else:
                segs.append({"startMs": w["startMs"], "endMs": w["endMs"], "speaker": w["speaker"], "text": w["word"]})
        texts = [s["text"] for s in segs]
        dup_ratio = 1 - len(deduped) / len(words) if words else 0.0
        return {"text": " ".join(texts), "segments": segs, "chunks": n_chunks, "duplicateWordRatio": dup_ratio}

    return run


ENGINES = {
    # chirp_3 BatchRecognize 는 inline phrase set(용어 힌트)을 넣으면 code 13 으로 실패한다
    # (2026-11-19 확인). 용어 힌트 없이 비교한다.
    "google:chirp_3": google_chirp3_engine(diarize=True, use_phrases=False),
    "elevenlabs:scribe_v2": elevenlabs_engine("scribe_v2", use_keyterms=True),
    "elevenlabs:scribe_v2-2spk": elevenlabs_engine("scribe_v2", use_keyterms=True, num_speakers=2),
    "openai:gpt-transcribe": openai_engine("gpt-transcribe", use_prompt=True),
    "openai:gpt-4o-transcribe": openai_engine("gpt-4o-transcribe", use_prompt=True),
    "openai:gpt-4o-transcribe-diarize": openai_engine("gpt-4o-transcribe-diarize", use_prompt=False),
}

# 기본으로 돌리는 엔진. OpenAI 는 비교에서 제외하기로 했다(2026-11-19) — 어댑터는
# 남겨 두되 --engines 로 이름을 직접 적어야만 돈다.
DEFAULT_ENGINES = [name for name in ENGINES if not name.startswith("openai:")]

# ─── 실행 ───────────────────────────────────────────────────────────────────


def evaluate(case: pathlib.Path, name: str, engine) -> dict:
    golden = json.loads((case / "golden.json").read_text())
    ref = " ".join(l["text"] for l in golden["lines"])
    out = case / "results"
    out.mkdir(exist_ok=True)
    row: dict = {"engine": name}

    t0 = time.time()
    try:
        res = engine(case / golden["audio"], golden["terms"])
    except Exception as e:  # noqa: BLE001 — 엔진 하나의 실패가 비교 전체를 멈추면 안 된다
        row["error"] = str(e)
        return row
    row["seconds"] = round(time.time() - t0, 1)
    (out / f"{name.replace(':', '_')}.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))

    row["cer"] = cer(ref, res["text"])
    row["terms"] = term_recall(ref, res["text"], golden["terms"])
    row["speaker"] = speaker_accuracy(golden, res.get("segments", []))
    row["silenceTextInLesson"] = text_in_silences(golden, res.get("segments", []))
    # 녹음 길이 대비 받아쓰기 길이 — 앞부분만 받아쓰고 끝나는 문제를 잡는다.
    row["coverage"] = len(normalize(res["text"])) / max(1, len(normalize(ref)))

    silence = case / "silence.m4a"
    if silence.exists():
        try:
            s = engine(silence, golden["terms"])
            row["silenceOnlyText"] = s["text"].strip()
        except Exception as e:  # noqa: BLE001
            row["silenceOnlyText"] = f"(error: {e})"
    return row


def report(rows: list[dict]) -> str:
    lines = ["| 엔진 | 무음 창작 | CER | 골프 용어 | 화자 | 길이 비율 | 시간(s) |",
             "|---|---|---|---|---|---|---|"]
    for r in rows:
        if "error" in r:
            lines.append(f"| {r['engine']} | 오류: {r['error'][:80]} | | | | | |")
            continue
        made_up = r.get("silenceOnlyText", "")
        fail = bool(made_up) and not made_up.startswith("(error") or r["silenceTextInLesson"] > 0
        sil = "**탈락**" if fail else "통과"
        spk = f"{r['speaker']['accuracy']:.0%}" if r["speaker"] else "—"
        lines.append(
            f"| {r['engine']} | {sil} | {r['cer']['cer']:.1%} | "
            f"{r['terms']['recall']:.0%} ({r['terms']['hit']}/{r['terms']['total']}) | {spk} | "
            f"{r['coverage']:.0%} | {r['seconds']} |"
        )
    lines.append("")
    for r in rows:
        if "error" in r:
            continue
        lines.append(f"- **{r['engine']}** — 놓친 용어: {', '.join(r['terms']['missed']) or '없음'}; "
                     f"무음 파일 출력: {r.get('silenceOnlyText') or '(없음)'!r}; "
                     f"삽입 {r['cer']['ins']} / 삭제 {r['cer']['del']} / 치환 {r['cer']['sub']} 글자")
    return "\n".join(lines) + "\n"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("case", type=pathlib.Path)
    p.add_argument("--engines", default=",".join(DEFAULT_ENGINES),
                   help="쉼표로 구분. 기본값은 DEFAULT_ENGINES — OpenAI 는 명시해야만 돈다.")
    a = p.parse_args()
    rows = []
    for name in a.engines.split(","):
        print(f"→ {name}", file=sys.stderr)
        rows.append(evaluate(a.case, name, ENGINES[name]))
    md = report(rows)
    (a.case / "results" / "report.md").write_text(md)
    (a.case / "results" / "report.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print(md)


if __name__ == "__main__":
    main()
