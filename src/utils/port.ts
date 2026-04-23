import { createServer } from 'node:net';

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
    // Stryker disable next-line BlockStatement: removing Promise body means resolve/reject never called → Timeout
    return new Promise((resolve, reject) => {
        const server = createServer();

        // Stryker disable next-line BlockStatement: removing error handler body means reject never called on error → Timeout
        server.on('error', (err: NodeJS.ErrnoException) => {
            reject(new Error(`Failed to get available port: ${err.message}`));
        });

        // Use 127.0.0.1 to explicitly bind to IPv4 and avoid IPv6 issues
        // Stryker disable next-line BlockStatement: removing listen callback body means resolve never called → Timeout
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();

            if(!address || typeof address === 'string') {
                server.close();
                reject(new Error('Failed to get port: server address is invalid'));
                return;
            }

            const port = address.port;

            server.close((err) => {
                if(err) {
                    reject(new Error(`Failed to close server: ${err.message}`));
                    return;
                }
                resolve(port);
            });
        });
    });
}
