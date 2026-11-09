import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly transport: Transporter | null;
  private readonly mode: 'smtp' | 'log' | 'memory';
  /** Populated only in `memory` mode (tests). */
  readonly outbox: MailMessage[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.mode = config.MAIL_TRANSPORT ?? (config.SMTP_URL ? 'smtp' : 'log');
    this.transport = this.mode === 'smtp' && config.SMTP_URL ? createTransport(config.SMTP_URL) : null;
  }

  async send(msg: MailMessage): Promise<void> {
    if (this.mode === 'memory') {
      this.outbox.push(msg);
      return;
    }
    if (this.mode === 'log' || !this.transport) {
      // Dev only: never enabled in production config (SMTP_URL required there).
      this.logger.log(`[mail:log] to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
      return;
    }
    await this.transport.sendMail({ from: this.config.MAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text });
  }
}
