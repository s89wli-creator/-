import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { DbService } from '../common/db.service';
import { Public } from '../common/decorators';
import { AppError } from '../common/errors';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Public()
  @SkipThrottle()
  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.db.pool.query('SELECT 1');
    } catch {
      throw new AppError(503, 'UNAVAILABLE', 'Database unavailable');
    }
    return { status: 'ok' };
  }
}
