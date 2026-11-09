import { PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from './errors';

/**
 * Validates and strips unknown keys. Converts failures to AppError here (rather than relying on
 * `instanceof ZodError` in the filter, which breaks if two copies of zod are loaded).
 */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}
  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Invalid input',
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      );
    }
    return result.data;
  }
}
