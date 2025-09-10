import express from 'express';
import cors from 'cors';
import { EventEmitter } from 'node:events';
import { URL } from 'node:url';
import { createCrawler } from './worker.js';

const app = express();
app.use(cors());
app.use(express.json());

// Keep a registry of scan emitters by id
const scans = new Map(); // id -> { events: EventEmitter, done: boolean }

app.post('/scan', async (req, res) => {
  const { startUrl, maxPages = 500, concurrency = 5 } = req.body || {};
  if (!startUrl) return res.status(400).json({ error: 'startUrl is required' });

  try {
    new URL(startUrl); // validate
  } catch {
    return res.status(400).json({ error: 'Invalid startUrl' });
  }

  const id = Math.random().toString(36).slice(2);
  const events = new EventEmitter();
  scans.set(id, { events, done: false });

  // Bridge all crawler events through our per-scan emitter
  const forward = (msg) => {
    try {
      events.emit('progress', msg);
      if (msg?.type === 'done') {
        const rec = scans.get(id);
        if (rec) rec.done = true;
      }
    } catch (e) {
      // ignore
    }
  };

  // Kick off the crawl (don’t await)
  createCrawler({ startUrl, maxPages, concurrency, events: { emit: (_, payload) => forward(payload) } })
    .start()
    .catch((err) => {
      events.emit('progress', { type: 'error', error: err?.message || String(err) });
      const rec = scans.get(id);
      if (rec) rec.done = true;
    });

  res.json({ id });
});

// Server-Sent Events for a specific scan id
app.get('/events/:id', (req, res) => {
  const { id } = req.params;
  const rec = scans.get(id);
  if (!rec) {
    res.status(404).end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (msg) => {
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
  };

  // Immediately send a hello so the client knows we’re connected
  send({ type: 'connected', id });

  const onProgress = (msg) => send(msg);
  rec.events.on('progress', onProgress);

  req.on('close', () => {
    rec.events.off('progress', onProgress);
  });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log('API listening on', port));
