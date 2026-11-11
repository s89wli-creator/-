import { Controller, Delete, Get, Headers, HttpCode, Param, ParseIntPipe, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext, RequestMeta, TenantAuthContext } from '../common/auth-context';
import { Auth, Meta, PlatformAdminOnly, RequirePermission, type RakanRequest } from '../common/decorators';
import { VoiceService } from './voice.service';

/** Voice for Ask Rakan: hear replies in the spokesperson voice, speak questions. */
@Controller('ai')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @RequirePermission('ai.use')
  @Get('voice/status')
  status(@Auth() auth: TenantAuthContext) {
    return this.voice.status(auth);
  }

  @RequirePermission('ai.use')
  @HttpCode(200)
  @Post('assistant/messages/:id/speech')
  async speech(@Auth() auth: TenantAuthContext, @Param('id', ParseIntPipe) id: number, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const audio = await this.voice.speak(auth, id);
    res.setHeader('Cache-Control', 'private, no-store');
    // Disclosure travels with the audio: this is a synthetic (AI-generated) voice.
    res.setHeader('X-Rakan-Synthetic-Voice', '1');
    return new StreamableFile(audio, { type: 'audio/mpeg', length: audio.length });
  }

  /** Body: the recording (application/octet-stream, max ~1 MB). Headers: x-audio-type, x-audio-seconds. */
  @RequirePermission('ai.use')
  @HttpCode(200)
  @Post('assistant/transcribe')
  transcribe(@Auth() auth: TenantAuthContext, @Req() req: RakanRequest, @Headers('x-audio-type') type?: string, @Headers('x-audio-seconds') seconds?: string) {
    return this.voice.transcribe(auth, req.body as Buffer | undefined, type, Number(seconds));
  }
}

/** Platform console: set up, replace or delete the spokesperson voice. */
@PlatformAdminOnly()
@Controller('platform')
export class PlatformVoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Get('voice')
  get() {
    return this.voice.platformGet();
  }

  /** Body: the voice recording (application/octet-stream, up to 12 MB). Query: name, consent=accepted. Header: x-audio-type. */
  @HttpCode(200)
  @Post('voice')
  set(
    @Auth() auth: AuthContext,
    @Req() req: RakanRequest,
    @Query('name') name: string | undefined,
    @Query('consent') consent: string | undefined,
    @Headers('x-audio-type') type: string | undefined,
    @Meta() meta: RequestMeta,
  ) {
    return this.voice.platformSet(auth, { sample: req.body as Buffer | undefined, mimeType: type, displayName: String(name ?? ''), consent: String(consent ?? '') }, meta);
  }

  @HttpCode(200)
  @Delete('voice')
  remove(@Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.voice.platformRemove(auth, meta);
  }
}
