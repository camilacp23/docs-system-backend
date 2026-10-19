/** Password hashing with bcrypt (NFR-02). */
import bcrypt from 'bcryptjs';
import { security } from './config.js';
export const hashPassword = (plain: string) => bcrypt.hash(plain, security.bcryptCost);
// Used when the e-mail does not exist, so a failed login costs the same time either way (no user enumeration).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', security.bcryptCost);
export const verifyPassword = (plain: string, hash: string | null | undefined) => bcrypt.compare(plain, hash ?? DUMMY_HASH);
