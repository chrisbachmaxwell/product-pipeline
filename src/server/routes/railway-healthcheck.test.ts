import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { describe, expect, it } from 'vitest';
import healthRoutes from './health.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = path.resolve(sourceRoot, '..');

interface RailwayConfig {
  $schema?: string;
  deploy?: {
    healthcheckPath?: string;
    healthcheckTimeout?: number;
  };
}

async function requestHealth(pathname: string): Promise<{
  statusCode: number;
  body: unknown;
}> {
  const app = express();
  app.use(healthRoutes);
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('address unavailable');

    return await new Promise((resolve, reject) => {
      const request = http.get({
        hostname: '127.0.0.1',
        port: address.port,
        path: pathname,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve({
              statusCode: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on('error', reject);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe('Railway deployment healthcheck', () => {
  it('uses the current schema and gates deployment activation on the live health route', async () => {
    const config = JSON.parse(
      await fs.readFile(path.join(repositoryRoot, 'railway.json'), 'utf8'),
    ) as RailwayConfig;

    expect(config.$schema).toBe('https://railway.com/railway.schema.json');
    expect(config.deploy?.healthcheckPath).toBe('/health');
    expect(config.deploy?.healthcheckTimeout).toBe(300);

    const response = await requestHealth(config.deploy?.healthcheckPath ?? '');
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      migration: {
        effectiveMode: 'shadow-read-only',
        externalWritesAllowed: false,
        historicalBackfillAllowed: false,
      },
    });
  });
});
