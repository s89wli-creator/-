import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// OWASP recommended argon2id parameters (m=19 MiB, t=2, p=1).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, algorithm: 2 /* Argon2id */ } as const;

@Injectable()
export class PasswordService {
  /** Precomputed so that unknown-email logins cost the same as real ones (no timing oracle). */
  private dummyHash: Promise<string> = hash('rakan-dummy-password-for-timing', OPTIONS);

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(passwordHash: string | null, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash ?? (await this.dummyHash), password);
    } catch {
      return false;
    }
  }

  async burn(password: string): Promise<void> {
    await this.verify(null, password);
  }
}
