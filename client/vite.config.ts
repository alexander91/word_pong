import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Ports are assigned in memdecks_data/ports.json so several games can run at once.
    port: 5178,
    strictPort: true,
  },
});
