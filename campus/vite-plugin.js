// Opus: import campus from './campus/vite-plugin.js'; add campus() to plugins.
// Existing Vite page/partial configuration is retained.
export default function campus() {
  return {
    name: 'luokixi-campus-api',
    config() {
      return { server: { proxy: {
        '/api/hub': { target: 'http://127.0.0.1:17861', changeOrigin: false },
        '/hub/': { target: 'http://127.0.0.1:17861', changeOrigin: false },
        '/manage/': { target: 'http://127.0.0.1:17861', changeOrigin: false },
        '/manage-assets/': { target: 'http://127.0.0.1:17861', changeOrigin: false },
        '/api': { target: 'http://127.0.0.1:17860', changeOrigin: true },
      } } };
    },
  };
}
