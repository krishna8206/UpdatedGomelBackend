// Simple in-memory Server-Sent Events (SSE) broadcaster
// Usage:
// - import { addClient, removeClient, broadcast, sseHandler } from './utils/events.js'
// - app.get('/api/events', sseHandler)
// - broadcast('event_name', payload)

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
  });
}

export function broadcast(event, data) {
  const payload = JSON.stringify({ event, data, ts: Date.now() });
  for (const res of clients) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${payload}\n\n`);
    } catch (_) {
      // drop broken connection
      clients.delete(res);
    }
  }
}

export function sseHandler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`event: connected\n`);
  res.write(`data: {"ok":true}\n\n`);
  addClient(res);
}
