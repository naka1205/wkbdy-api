import { createServer } from './server.js';

async function main() {
  const { app, env } = await createServer();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    await app.close();
    clearTimeout(deadline);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
  try {
    await app.listen({ host: env.host, port: env.port });
    app.log.info(
      { host: env.host, port: env.port, admin: `http://${env.host}:${env.port}/` },
      'wkbdy-api listening',
    );
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
