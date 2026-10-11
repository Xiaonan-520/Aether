/**
 * Test helper: an extension entry that boots an HTTP server answering /health
 * with 200 {status:"healthy"} but NOTHING else — used to exercise the upgrade
 * rollback path (health passes, manifest handshake must fail).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export async function run(port: number): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'healthy' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { kind: 'TERMINAL', message: 'never-healthy helper' } }))
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
}
