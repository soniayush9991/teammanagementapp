import bcrypt from 'bcryptjs';
import { ApiError } from './errors.js';

const SALT_ROUNDS = 12;

/** Rejects the obvious weak cases before a password is ever hashed. */
export function assertPasswordStrength(password: string): void {
  if (password.length < 12) {
    throw ApiError.unprocessable('Password must be at least 12 characters long');
  }
  if (password.length > 200) {
    throw ApiError.unprocessable('Password must be at most 200 characters long');
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  if (classes < 3) {
    throw ApiError.unprocessable(
      'Password must mix at least three of: lowercase, uppercase, digits, symbols',
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordStrength(password);
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
