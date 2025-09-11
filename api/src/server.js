import express from 'express';
import cors from 'cors';
import { EventEmitter } from 'node:events';
import { URL } from 'node:url';
import { MongoClient } from 'mongodb';
import { createCrawler } from './worker.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- MongoDB Connection ---
const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017';
const client = new MongoClient(mongoUrl);
let resultsCollection;
let scansCollection; // New collection for scan states

async function connectToMongo() {
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    const db = client.db('expired_domain_scanner');
    resultsCollection = db.collection('results');
    scansCollection = db.collection('scans'); // Initialize scans collection
  } catch (err) {
    console.error('Failed to connect to MongoDB', err);
    process.exit(1);
  }
}
// --- End MongoDB Connection ---


const scans = new Map(); // Emitters are still kept in memory for live updates

// --- New Endpoint to Check Scan Status ---
app.get('/scan/status', async (req, res) => {
    const { startUrl } = req.query;
    if (!startUrl) return res.status(400).json({ error: 'startUrl is required' });

    try {
        const url = new URL(startUrl);
        const website = url.hostname;
        const scan = await scansCollection.findOne({ website });
        if (scan) {
            res.json({
                exists: true,
                status: scan.status,
                visitedCount: scan.visited?.length || 0,
                queueCount: scan.queue?.length || 0,
            });
        } else {
            res.json({ exists: false });
        }
    } catch {
        return res.status(400).json({ error: 'Invalid startUrl' });
    }
});


app.post('/scan', async (req, res) => {
  const { startUrl, maxPages = 1000, concurrency = 5, mode = 'new' } = req.body || {}; // mode can be 'new' or 'resume'
  if (!startUrl) return res.status(400).json({ error: 'startUrl is required' });

  let url;
  try {
    url = new URL(startUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid startUrl' });
  }

  const website = url.hostname;
  const id = Math.random().toString(36).slice(2);
  const events = new EventEmitter();
  scans.set(id, { events, done: false });

  const forward = (msg) => {
    try {
      events.emit('progress', msg);
      if (msg?.type === 'done' || msg?.type === 'paused') {
        const rec = scans.get(id);
        if (rec) rec.done = true;
      }
    } catch (e) { /* ignore */ }
  };

  // Kick off the crawl
  createCrawler({
    startUrl,
    maxPages,
    concurrency,
    mode,
    events: { emit: (_, payload) => forward(payload) },
    scansCollection,
    resultsCollection
  })
    .start()
    .catch((err) => {
      forward({ type: 'error', error: err?.message || String(err) });
      const rec = scans.get(id);
      if (rec) rec.done = true;
    });

  res.json({ id });
});

// Server-Sent Events (SSE) endpoint
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

    send({ type: 'connected', id });

    const onProgress = (msg) => send(msg);
    rec.events.on('progress', onProgress);

    req.on('close', () => {
        rec.events.off('progress', onProgress);
    });
});

// Endpoint for fetching stored results
app.get('/results', async (req, res) => {
    const { website, tld } = req.query;
    const query = {};
    if (website) {
        query.website = { $regex: website, $options: 'i' };
    }
    if (tld) {
        query.tld = tld;
    }
    const results = await resultsCollection.find(query).sort({ foundAt: -1 }).toArray();
    res.json(results);
});


const port = process.env.PORT || 4000;
app.listen(port, () => {
    console.log('API listening on', port)
    connectToMongo();
});