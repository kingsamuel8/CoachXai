import { Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AuthRole } from './auth';

/**
 * AI 게이트웨이(/api/ai/invoke, /api/ai/invoke-stream) 출입 규칙.
 *
 * 게이트웨이는 서버의 Gemini 키로 Pro 모델까지 부른다. 예전에는 로그인이
 * 선택(optionalAuth)이고 횟수 제한도 없어서, 서버 주소만 알면 누구나 그 키로
 * 요금을 쓸 수 있었다. 이제는:
 *
 *  - 로그인 토큰이 있어야 한다(authMiddleware 가 먼저 401 로 거른다).
 *  - 허용된 역할만 쓴다. 기본은 코치와 운영자(admin — 프롬프트 관리 화면).
 *    학생 앱 AI(학생 AI 채팅 등)를 다시 열려면 AI_ALLOWED_ROLES=coach,admin,client.
 *  - 사용자마다 분당 호출 수를 제한한다(AI_RATE_LIMIT_PER_MIN, 기본 60).
 *    50분 레슨 녹음은 10초 조각 받아쓰기 + 정밀 전사(동시 3개) + 교정·요약으로
 *    분당 수십 건까지 오르므로 그보다 넉넉하게 잡는다.
 */

const ALL_ROLES: readonly AuthRole[] = ['coach', 'client', 'admin', 'branch_admin'];
const DEFAULT_ROLES: readonly AuthRole[] = ['coach', 'admin'];

export function parseAllowedRoles(raw: string | undefined): Set<AuthRole> {
  const picked = (raw ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is AuthRole => (ALL_ROLES as readonly string[]).includes(r));
  return new Set(picked.length > 0 ? picked : DEFAULT_ROLES);
}

export function requireAiRole(req: Request, res: Response, next: NextFunction): void {
  const allowed = parseAllowedRoles(process.env.AI_ALLOWED_ROLES);
  if (!req.user || !allowed.has(req.user.role)) {
    res.status(403).json({ ok: false, error: 'AI is available to signed-in coaches only' });
    return;
  }
  next();
}

const perMinute = Number(process.env.AI_RATE_LIMIT_PER_MIN);

export const aiUserLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number.isFinite(perMinute) && perMinute > 0 ? perMinute : 60,
  standardHeaders: true,
  legacyHeaders: false,
  // authMiddleware 뒤에 붙으므로 req.user 가 항상 있다. IP 가 아니라 계정 단위로 센다.
  keyGenerator: (req: Request) => `${req.user?.role}:${req.user?.id}`,
  message: { ok: false, error: 'Too many AI requests — try again in a minute' },
});
