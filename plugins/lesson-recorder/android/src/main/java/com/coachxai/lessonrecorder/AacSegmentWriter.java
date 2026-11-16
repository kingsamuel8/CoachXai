package com.coachxai.lessonrecorder;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * PCM16 모노 → AAC-LC → .m4a 한 파일.
 *
 * 세그먼트마다 인코더와 먹서를 새로 연다. 녹음(AudioRecord)은 그대로 둔 채
 * 파일만 갈아 끼우므로 세그먼트 경계에서 소리가 한 샘플도 빠지지 않는다 —
 * MediaRecorder 를 멈췄다 다시 켜는 방식은 경계마다 수백 ms 가 비고, 그
 * 자리에 걸친 말이 잘린다.
 *
 * 각 파일은 독립적으로 재생 가능한 완전한 m4a 다(moov 포함).
 */
final class AacSegmentWriter {
    private static final long DEQUEUE_TIMEOUT_US = 10_000;
    /** EOS 이후 출력 대기 최대 횟수(× DEQUEUE_TIMEOUT_US ≈ 2초). */
    private static final int EOS_MAX_WAITS = 200;

    private final int sampleRate;
    private final int bitRate;
    private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

    private MediaCodec codec;
    private MediaMuxer muxer;
    private File file;
    private int track = -1;
    private boolean muxerStarted;
    private long samples;

    AacSegmentWriter(int sampleRate, int bitRate) {
        this.sampleRate = sampleRate;
        this.bitRate = bitRate;
    }

    void open(File f) throws IOException {
        file = f;
        MediaFormat fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1);
        fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        fmt.setInteger(MediaFormat.KEY_BIT_RATE, bitRate);
        fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024);
        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        codec.start();
        muxer = new MediaMuxer(f.getPath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        track = -1;
        muxerStarted = false;
        samples = 0;
    }

    /** 이 세그먼트에 쓴 오디오 길이(ms). */
    long durationMs() {
        return samples * 1000L / sampleRate;
    }

    private long ptsUs() {
        return samples * 1_000_000L / sampleRate;
    }

    void write(byte[] pcm, int len) {
        int off = 0;
        while (off < len) {
            int idx = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US);
            if (idx >= 0) {
                ByteBuffer in = codec.getInputBuffer(idx);
                if (in == null) continue;
                in.clear();
                int n = Math.min(in.remaining(), len - off);
                n -= n % 2; // 16비트 샘플 경계
                in.put(pcm, off, n);
                codec.queueInputBuffer(idx, 0, n, ptsUs(), 0);
                samples += n / 2;
                off += n;
            }
            drain(false);
        }
    }

    /**
     * 세그먼트를 닫는다. 재생 가능한 파일이 만들어졌으면 true —
     * 오디오가 하나도 없었으면 파일을 지우고 false.
     */
    boolean close() {
        boolean ok = false;
        try {
            int idx = -1;
            for (int i = 0; i < EOS_MAX_WAITS && idx < 0; i++) {
                idx = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US);
                if (idx < 0) drain(false);
            }
            if (idx >= 0) {
                codec.queueInputBuffer(idx, 0, 0, ptsUs(), MediaCodec.BUFFER_FLAG_END_OF_STREAM);
            }
            drain(true);
        } catch (RuntimeException ignored) {
            // 인코더가 이미 망가졌다 — 아래에서 정리만 한다.
        }
        try {
            codec.stop();
        } catch (RuntimeException ignored) {
        }
        codec.release();
        try {
            if (muxerStarted) {
                muxer.stop();
                ok = samples > 0;
            }
        } catch (RuntimeException ignored) {
            ok = false;
        }
        muxer.release();
        if (!ok) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
        codec = null;
        muxer = null;
        return ok;
    }

    private void drain(boolean endOfStream) {
        int waits = 0;
        while (true) {
            int o = codec.dequeueOutputBuffer(info, endOfStream ? DEQUEUE_TIMEOUT_US : 0);
            if (o == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!endOfStream || ++waits > EOS_MAX_WAITS) return;
            } else if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                track = muxer.addTrack(codec.getOutputFormat());
                muxer.start();
                muxerStarted = true;
            } else if (o >= 0) {
                ByteBuffer out = codec.getOutputBuffer(o);
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0;
                if (out != null && info.size > 0 && muxerStarted) {
                    out.position(info.offset);
                    out.limit(info.offset + info.size);
                    muxer.writeSampleData(track, out, info);
                }
                codec.releaseOutputBuffer(o, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
            }
        }
    }
}
