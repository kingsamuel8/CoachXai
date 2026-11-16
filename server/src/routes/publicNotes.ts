import { Router, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import pool from '../services/db';

/**
 * GET /api/public/lesson-notes/:token — 코치가 보낸 링크로 고객이 레슨 노트를 연다.
 *
 * 로그인이 필요 없는 유일한 레슨 경로라 내보내는 것을 최소로 묶는다:
 * 코치 이름, 고객 이름, 날짜, 그리고 코치가 확인한 **고객용 노트**뿐이다.
 * 필기 전문·코치 메모·전화번호·미디어는 절대 나가지 않는다.
 */
const router = Router();

const publicNoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asStringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

router.get('/:token', publicNoteLimiter, async (req: Request, res: Response) => {
  const { token } = req.params;
  if (!TOKEN_PATTERN.test(token)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT l.client_name, l.date, l.live_lesson_detail, c.name AS coach_name
         FROM lessons l
         LEFT JOIN coaches c ON c.id = l.coach_id
        WHERE l.share_token = $1`,
      [token]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const row = result.rows[0];
    const detail = (row.live_lesson_detail ?? {}) as Record<string, unknown>;
    const note = (detail.clientNote ?? null) as Record<string, unknown> | null;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      coachName: asString(row.coach_name),
      studentName: asString(row.client_name),
      date: asString(row.date),
      note: note
        ? {
            language: asString(note.language),
            headline: asString(note.headline),
            keyPoints: asStringList(note.keyPoints),
            drills: asStringList(note.drills),
            nextFocus: asString(note.nextFocus),
            message: asString(note.message),
          }
        : null,
      // 고객용 노트가 없는 옛 기록은 코치 요약을 대신 보여 준다.
      fallbackSummary: note ? '' : asString(detail.coachSummary) || asString(detail.summary),
    });
  } catch (err) {
    console.error('[publicNotes] GET /:token error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
