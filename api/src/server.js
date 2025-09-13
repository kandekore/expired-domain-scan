import express from 'express';
import cors from 'cors';
import { EventEmitter } from 'node:events';
import { URL } from 'node:url';
import { MongoClient, ObjectId } from 'mongodb';
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

const activeCrawlers = new Map();
const activeScanEmitters = new Map();

const scheduleResume = async (scanId, delayMinutes) => {
    console.log(`Scheduling resume for scan ${scanId} in ${delayMinutes} minutes.`);
    setTimeout(async () => {
        const scan = await scansCollection.findOne({ _id: new ObjectId(scanId) });

        if (scan && scan.status === 'paused' && scan.autoResume && scan.autoResume.enabled && scan.autoResume.remaining > 0) {
            console.log(`Auto-resuming scan ${scanId}...`);
            const newRemaining = scan.autoResume.remaining === 'infinite' ? 'infinite' : scan.autoResume.remaining - 1;
            
            await scansCollection.updateOne(
                { _id: new ObjectId(scanId) },
                { $set: { "autoResume.remaining": newRemaining, status: 'running' } }
            );

            const crawler = createCrawler({
                startUrl: scan.startUrl,
                maxPages: scan.autoResume.batchSize,
                concurrency: scan.concurrency,
                mode: 'resume',
                isAggressive: scan.autoResume.isAggressive,
                events: { emit: () => {} },
                scansCollection,
                resultsCollection
              });
              
              activeCrawlers.set(scanId.toString(), crawler);

              crawler.start()
              .then(async () => {
                  activeCrawlers.delete(scanId.toString());
                  const updatedScan = await scansCollection.findOne({ _id: new ObjectId(scanId) });
                  if (updatedScan && updatedScan.status === 'paused' && updatedScan.autoResume.enabled && updatedScan.autoResume.remaining > 0) {
                      scheduleResume(scanId, updatedScan.autoResume.delayMinutes);
                  }
              });
        }
    }, delayMinutes * 60 * 1000);
};

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
  const { startUrl, maxPages, concurrency, mode, isAggressive, autoResume } = req.body;
  if (!startUrl) return res.status(400).json({ error: 'startUrl is required' });

  const website = new URL(startUrl).hostname;
  let scan;

  if (mode === 'resume') {
    scan = await scansCollection.findOne({ website });
    if (scan) {
        await scansCollection.updateOne({ _id: scan._id }, { $set: { status: 'running' } });
    }
  } else {
    await scansCollection.deleteOne({ website });
    const newScanData = {
        website, startUrl, status: 'running', queue: [startUrl], visited: [],
        checkedDomains: 0, createdAt: new Date(), concurrency,
        autoResume: {
            enabled: autoResume.enabled,
            delayMinutes: autoResume.delayMinutes,
            remaining: autoResume.repeat,
            batchSize: maxPages,
            isAggressive,
        }
    };
    const result = await scansCollection.insertOne(newScanData);
    scan = { ...newScanData, _id: result.insertedId };
  }

  if (!scan) return res.status(404).json({ error: 'Scan not found for resume' });

  const scanId = scan._id.toString();
  const events = new EventEmitter();
  activeScanEmitters.set(scanId, { events });

  const forward = (msg) => {
      try { events.emit('progress', msg) } catch (e) {}
  };

  const crawler = createCrawler({
    startUrl: scan.startUrl, maxPages, concurrency, mode: 'resume', isAggressive,
    events: { emit: (_, payload) => forward(payload) },
    scansCollection, resultsCollection
  });
  
  activeCrawlers.set(scanId, crawler);

  crawler.start().then(async () => {
      activeCrawlers.delete(scanId);
      const finalScanState = await scansCollection.findOne({ _id: new ObjectId(scanId) });
      if (finalScanState && finalScanState.status === 'paused' && finalScanState.autoResume.enabled && finalScanState.autoResume.remaining > 0) {
          scheduleResume(scanId, finalScanState.autoResume.delayMinutes);
      }
  });

  res.json({ id: scanId });
});

app.post('/scan/:id/interrupt', async (req, res) => {
    const { id } = req.params;
    const crawler = activeCrawlers.get(id);
    if (crawler) {
        console.log(`Interrupting scan ${id}`);
        crawler.stop();
        activeCrawlers.delete(id);
        await scansCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: 'paused', "autoResume.enabled": false } }
        );
        res.status(200).json({ message: 'Scan interrupted.' });
    } else {
        res.status(404).json({ error: 'No active scan found with that ID.' });
    }
});

app.get('/events/:id', (req, res) => {
    const { id } = req.params;
    const rec = activeScanEmitters.get(id);
    if (!rec) { return res.status(404).end(); }
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
    if (tld) query.tld = { $regex: `^${tld}$`, $options: 'i' };
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

app.get('/results/reasons', async (req, res) => {
    try {
        const reasons = await resultsCollection.distinct('expiryDateReason');
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
    console.log('API listening on', port);
    connectToMongo();
});