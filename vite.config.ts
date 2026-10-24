import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** In `npm run dev`, answers /api/db with the same server code Vercel runs (needs DATABASE_URL etc. in a .env file). */
function apiInDev(): Plugin {
  return {
    name: 'pms-api-dev',
    configureServer(server) {
      Object.assign(process.env, loadEnv('development', process.cwd(), ''));
      server.middlewares.use('/api/db', async (req, res) => {
        const mod = await server.ssrLoadModule('/server/handler.ts');
        await mod.default(req, res);
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), apiInDev()],
  build: { sourcemap: false, chunkSizeWarningLimit: 900 }
});
