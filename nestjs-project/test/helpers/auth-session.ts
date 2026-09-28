import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../../src/auth/auth.service';

interface TokenPairResponseBody {
  access_token: string;
  refresh_token: string;
}

interface RegisterResponseBody {
  id: string;
  email: string;
}

export interface AuthSession {
  userId: string;
  accessToken: string;
}

/** Registers, confirms (capturing the e-mail token) and logs a user in through the real auth endpoints. */
export async function createAuthSession(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<AuthSession> {
  const mailService = app.get(AuthService)['mailService'];
  let confirmationToken = '';
  const spy = jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  const registerRes = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  spy.mockRestore();
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const loginRes = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return {
    userId: (registerRes.body as RegisterResponseBody).id,
    accessToken: (loginRes.body as TokenPairResponseBody).access_token,
  };
}
