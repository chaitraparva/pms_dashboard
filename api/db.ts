// Vercel serverless function: POST /api/db. All of the app's data goes through here (see server/handler.ts).
export { default } from '../server/handler';
export const config = { maxDuration: 30 };
