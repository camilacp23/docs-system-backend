import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: env('DATABASE_URL'),
    // Used only by `npm run db:drift` / `prisma migrate dev` in development
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
