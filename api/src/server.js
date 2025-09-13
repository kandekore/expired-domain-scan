import express from 'express';
import cors from 'cors';
import { EventEmitter } from 'node:events';
import { URL } from 'node:url';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { createCrawler } from './worker.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017';
const client = new MongoClient(mongoUrl);
let resultsCollection;
let scansCollection;

async function connectToMongo() {
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    const db = client.db('expired_domain_scanner');
    resultsCollection = db.collection('results');
    scansCollection = db.collection('scans');
  } catch (err) {
    console.error('Failed to connect to MongoDB', err);
    process.exit(1);
  }
}

const scans = new Map();

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
  const { startUrl, maxPages = 1000, concurrency = 5, mode = 'new', isAggressive = true } = req.body;
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
    } catch (e) {}
  };
  createCrawler({ startUrl, maxPages, concurrency, mode, isAggressive, events: { emit: (_, payload) => forward(payload) }, scansCollection, resultsCollection })
    .start()
    .catch((err) => {
      forward({ type: 'error', error: err?.message || String(err) });
      const rec = scans.get(id);
      if (rec) rec.done = true;
    });
  res.json({ id });
});

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
    const send = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
    send({ type: 'connected', id });
    const onProgress = (msg) => send(msg);
    rec.events.on('progress', onProgress);
    req.on('close', () => rec.events.off('progress', onProgress));
});

app.get('/results', async (req, res) => {
    const { website, tld, reason } = req.query;
    const query = {};
    if (website) query.website = { $regex: website, $options: 'i' };
    if (tld) query.tld = { $regex: tld, $options: 'i' };
    
    // --- UPDATED: Handle the reason filter ---
    if (reason) {
        if (reason === 'has-expiry-date') {
            query.expiryDate = { $ne: null };
        } else {
            query.expiryDateReason = reason;
        }
    }

    const results = await resultsCollection.find(query).sort({ foundAt: -1 }).toArray();
    res.json(results);
});

// --- NEW ENDPOINT: To get all unique reasons for the dropdown ---
app.get('/results/reasons', async (req, res) => {
    try {
        const reasons = await resultsCollection.distinct('expiryDateReason');
        // Filter out any null or empty values that might be in the database
        const validReasons = reasons.filter(reason => reason);
        res.json(validReasons);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch reasons' });
    }
});

app.get('/summary', async (req, res) => {
    try {
        const summary = await resultsCollection.aggregate([
            { $group: { _id: "$website", count: { $sum: 1 } } },
            { $project: { website: "$_id", count: 1, _id: 0 } },
            { $sort: { website: 1 } }
        ]).toArray();
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch summary' });
    }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
    console.log('API listening on', port)
    connectToMongo();
});