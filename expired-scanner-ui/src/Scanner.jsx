import { useEffect, useRef, useState } from 'react';
import axios from 'axios';

export default function Scanner() {
  const [startUrl, setStartUrl] = useState('https://example.com');
  const [scanId, setScanId] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState([]);
  const [domains, setDomains] = useState([]);
  const [stats, setStats] = useState({
    visited: 0,
    inQueue: 0,
    checkedDomains: 0,
    maxPages: 1000,
    crawlRate: 0,
    etaSec: null,
    concurrency: 5,
  });
  const [statusLine, setStatusLine] = useState('Idle');
  const [existingScan, setExistingScan] = useState(null);
  const [isCheckingScan, setIsCheckingScan] = useState(false);
  const [isAggressive, setIsAggressive] = useState(true);
  const evtRef = useRef(null);

  useEffect(() => {
    const checkScanStatus = async () => {
      if (!startUrl || !startUrl.startsWith('http')) {
        setExistingScan(null);
        return;
      }
      setIsCheckingScan(true);
      try {
        const { data } = await axios.get(`http://localhost:4000/scan/status?startUrl=${encodeURIComponent(startUrl)}`);
        setExistingScan(data.exists && data.status === 'paused' ? data : null);
      } catch (error) {
        setExistingScan(null);
        console.error("Failed to check scan status", error);
      } finally {
        setIsCheckingScan(false);
      }
    };
    const handler = setTimeout(() => checkScanStatus(), 500);
    return () => clearTimeout(handler);
  }, [startUrl]);

  const startScan = async (mode = 'new') => {
    setProgress([]);
    setDomains([]);
    setIsScanning(true);
    setStatusLine('Connecting…');
    setExistingScan(null);

    const { data } = await axios.post('http://localhost:4000/scan', {
      startUrl,
      maxPages: stats.maxPages,
      concurrency: stats.concurrency,
      mode,
      isAggressive,
    });

    setScanId(data.id);

    const es = new EventSource(`http://localhost:4000/events/${data.id}`);
    evtRef.current = es;

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      setProgress((p) => [...p, msg]);
      switch (msg.type) {
        case 'connected':
          setStatusLine('Connected to scan stream.');
          break;
        case 'start':
          setStatusLine(`Starting crawl: ${msg.startUrl} (batchSize ${msg.batchSize}, mode=${msg.mode})`);
          break;
        case 'page':
          setStatusLine(`Page event: ${msg.stage || ''} ${msg.url || ''}`);
          break;
        case 'domain':
          setStatusLine(`Domain event: ${msg.stage || ''} ${msg.domain || ''}`);
          break;
        case 'stats':
          setStats((prev) => ({
            ...prev,
            visited: msg.visited ?? prev.visited,
            inQueue: msg.inQueue ?? prev.inQueue,
            checkedDomains: msg.checkedDomains ?? prev.checkedDomains,
            crawlRate: msg.crawlRate ?? prev.crawlRate,
            etaSec: msg.etaSec ?? prev.etaSec,
          }));
          break;
        case 'error':
          setStatusLine(`Error: ${msg.error}`);
          break;
        case 'paused':
          setStatusLine(`Scan paused. Total Pages Scanned: ${msg.totalPages}. You can resume later.`);
          if (evtRef.current) {
            evtRef.current.close();
            evtRef.current = null;
          }
          setIsScanning(false);
          axios.get(`http://localhost:4000/scan/status?startUrl=${encodeURIComponent(startUrl)}`)
            .then(({data}) => setExistingScan(data.exists && data.status === 'paused' ? data : null));
          break;
        case 'done':
          setStatusLine(`Scan Complete! Total Pages: ${msg.totalPages}, Domains Checked: ${msg.domains}`);
          if (evtRef.current) {
            evtRef.current.close();
            evtRef.current = null;
          }
          setIsScanning(false);
          setExistingScan(null);
          break;
        default:
          break;
      }
    };

    es.onerror = () => {
      if (evtRef.current) {
        evtRef.current.close();
        evtRef.current = null;
      }
      setIsScanning(false);
      setStatusLine('Stream error. Disconnected.');
    };
  };

  useEffect(() => {
    const map = new Map();
    for (const m of progress) {
      if (m.type === 'domain' && m.stage === 'check-done') {
        map.set(m.domain, m.result);
      }
    }
    setDomains(Array.from(map.entries()).map(([domain, result]) => ({ domain, result })));
  }, [progress]);

  useEffect(() => {
    return () => {
      if (evtRef.current) {
        evtRef.current.close();
        evtRef.current = null;
      }
    };
  }, []);

  const filtered = domains.filter((d) => d.result?.status === 'no-dns');

  return (
    <div>
      <h1>Expired Outbound Link Scanner</h1>
      <p>Find external links to domains that don’t resolve (likely expired).</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={startUrl}
          onChange={(e) => setStartUrl(e.target.value)}
          style={{ flex: 1, minWidth: 280, padding: 8 }}
          placeholder="https://example.com"
          disabled={isScanning}
        />
        <label style={{ fontSize: 12 }}>
          batchSize&nbsp;
          <input
            type="number"
            min={100}
            step={100}
            value={stats.maxPages}
            onChange={(e) => setStats((s) => ({ ...s, maxPages: Number(e.target.value) || 1000 }))}
            style={{ width: 100, padding: 6 }}
            title="Pages per batch"
            disabled={isScanning}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          concurrency&nbsp;
          <input
            type="number"
            min={1}
            max={10}
            value={stats.concurrency}
            onChange={(e) => setStats((s) => ({ ...s, concurrency: Number(e.target.value) || 5 }))}
            style={{ width: 100, padding: 6 }}
            title="Concurrency"
            disabled={isScanning}
          />
        </label>
        {!existingScan ? (
            <button onClick={() => startScan('new')} disabled={isScanning || isCheckingScan || !startUrl.trim()}>
                {isCheckingScan ? 'Checking…' : (isScanning ? 'Scanning…' : 'Start Scan')}
            </button>
        ) : (
            <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => startScan('resume')} disabled={isScanning} style={{background: '#2563eb', color: 'white'}}>
                    {`Resume (${existingScan.visitedCount} done)`}
                </button>
                <button onClick={() => startScan('new')} disabled={isScanning} style={{ background: '#be123c', color: 'white'}}>
                    Start Fresh
                </button>
            </div>
        )}
      </div>
      <div style={{ marginTop: '12px' }}>
        <label style={{ fontSize: 14, cursor: 'pointer' }}>
            <input 
                type="checkbox" 
                checked={isAggressive} 
                onChange={(e) => setIsAggressive(e.target.checked)}
                disabled={isScanning}
                style={{ verticalAlign: 'middle', marginRight: '6px' }}
            />
            Aggressive Crawl (faster, but may be blocked by some sites)
        </label>
      </div>
      {existingScan && !isScanning && (
          <p style={{ fontSize: 12, color: '#999', margin: '8px 0'}}>
              Found a paused scan for this site. Queue has {existingScan.queueCount} URLs remaining.
          </p>
      )}
      {scanId && (
        <p style={{ marginTop: 8, fontSize: 12, color: '#555' }}>
          Scan ID: <code>{scanId}</code>
        </p>
      )}
      <div
        style={{
          marginTop: 12,
          padding: '8px 10px',
          background: '#eef2ff',
          border: '1px solid #c7d2fe',
          color: '#1e1b4b',
          borderRadius: 6,
          fontSize: 14,
        }}
      >
        {statusLine}
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', fontSize: 14, flexWrap: 'wrap' }}>
          <div>Total Pages Visited: {stats.visited}</div>
          <div>URLs in Queue: {stats.inQueue}</div>
          <div>Domains Checked: {stats.checkedDomains}</div>
          <div>Rate: {stats.crawlRate?.toFixed(2) ?? 0} p/s</div>
        </div>
      </div>
      <h3 style={{ marginTop: 24 }}>Expired Domains Found (No DNS)</h3>
      <table width="100%" cellPadding="6" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Domain</th>
            <th align="left">Reason</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length ? (
            filtered.map(({ domain }) => (
              <tr key={domain}>
                <td>
                  <a
                    href={`http://${domain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#2563eb', textDecoration: 'underline' }}
                  >
                    {domain}
                  </a>
                </td>
                <td>No DNS (NXDOMAIN/ENOTFOUND)</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2} style={{ color: '#777' }}>
                {isScanning ? 'Scanning…' : 'No expired domains found in this session yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}