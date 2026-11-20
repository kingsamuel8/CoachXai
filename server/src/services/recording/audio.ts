/**
 * 녹음 세그먼트(60초 m4a 조각들)를 한 파일로 잇는다.
 *
 * 앱 녹음기가 만든 조각은 각각 완전한 m4a 라서, ffmpeg concat 디먹서로
 * 재인코딩 없이(-c copy) 이어 붙일 수 있다. 배포 서버에는 ffmpeg 가 없을 수
 * 있어 ffmpeg-static 바이너리를 쓰고, FFMPEG_PATH 로 바꿀 수 있게 한다.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile } from 'fs/promises';
import path from 'path';

const run = promisify(execFile);

export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static') as string | null;
    if (p) return p;
  } catch {
    // 패키지가 없으면 PATH 의 ffmpeg
  }
  return 'ffmpeg';
}

/** concat 디먹서 목록 파일 내용. 경로의 작은따옴표는 ffmpeg 규칙대로 이스케이프. */
export function concatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

/** 조각들을 순서대로 이어 outPath 에 쓴다. */
export async function joinSegments(files: string[], outPath: string): Promise<void> {
  if (files.length === 0) throw new Error('no segments to join');
  const listPath = path.join(path.dirname(outPath), 'concat.txt');
  await writeFile(listPath, concatList(files));
  await run(ffmpegPath(), [
    '-v', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', outPath,
  ], { maxBuffer: 10 * 1024 * 1024 });
}

/** 오디오 길이(초). ffmpeg -i 의 Duration 줄을 읽는다(ffprobe 없이). */
export async function probeDurationSec(file: string): Promise<number> {
  try {
    await run(ffmpegPath(), ['-hide_banner', '-i', file]);
  } catch (e) {
    // ffmpeg -i 는 출력 파일이 없어 항상 실패 코드로 끝나고, 정보는 stderr 에 있다.
    const stderr = String((e as { stderr?: string }).stderr ?? '');
    const m = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return 0;
}
