import pino from 'pino';
import { env } from '../env.js';

export const logger = pino({
  level: env().NODE_ENV === 'test' ? 'silent' : env().NODE_ENV === 'production' ? 'info' : 'debug',
  // Anything that could carry a credential or message body is stripped before
  // it reaches a log sink.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.body',
    ],
    censor: '[redacted]',
  },
  transport:
    env().NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});
