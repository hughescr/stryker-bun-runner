import { createServer } from 'net';

/**
 * Gets an available port by asking the OS to assign one.
 *
 * Creates a temporary TCP server on port 0, which causes the OS
 * to assign an available port. The port number is retrieved and
 * the server is closed before returning.
 *
 * @returns Promise that resolves to an available port number
 * @throws Error if unable to create server or get port
 */
export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.on('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(`Failed to get available port: ${err.message}`));
    });

    // Use 127.0.0.1 to explicitly bind to IPv4 and avoid IPv6 issues
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to get port: server address is invalid'));
        return;
      }

      const port = address.port;

      server.close((err) => {
        if (err) {
          reject(new Error(`Failed to close server: ${err.message}`));
          return;
        }
        resolve(port);
      });
    });
  });
}
