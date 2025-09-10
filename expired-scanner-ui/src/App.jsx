import { useEffect, useRef, useState } from 'react';
import axios from 'axios';

export default function App() {
  const [startUrl, setStartUrl] = useState('https://example.com');
  const [scanId, setScanId] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState([]);
  const [domains, setDomains] = useState([]);
  const [stats, setStats] = useState({
    visited: 0,
    inQueue: 0,
    checkedDomains: 0,
    maxPages: 300,
    crawlRate: 0,
    etaSec: null,
    concurrency: 5,
  });
  const [statusLine, setStatusLine] = useState('Idle');

  const evtRef = useRef(null);

  const startScan = async () => {
    setProgress([]);
    setDomains([]);
    setIsScanning(true);
    setStatusLine('Connecting…');

    const { data } = await axios.post('http://localhost:4000/scan', {
      startUrl,
      maxPages: stats.maxPages,
      concurrency: stats.concurrency,
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
          setStatusLine(`Starting crawl: ${msg.startUrl} (max ${msg.maxPages}, c=${msg.concurrency})`);
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
            maxPages: msg.maxPages ?? prev.maxPages,
            crawlRate: msg.crawlRate ?? prev.crawlRate,
            etaSec: msg.etaSec ?? prev.etaSec,
            concurrency: msg.concurrency ?? prev.concurrency,
          }));
          break;
        case 'error':
          setStatusLine(`Error: ${msg.error}`);
          break;
        case 'done':
          setStatusLine(`Done. Pages: ${msg.totalPages}, Domains: ${msg.domains}`);
          if (evtRef.current) {
            evtRef.current.close();
            evtRef.current = null;
          }
          setIsScanning(false);
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

  // Build the domains list from streamed progress
  useEffect(() => {
    const map = new Map();
    for (const m of progress) {
      if (m.type === 'domain' && m.stage === 'check-done') {
        map.set(m.domain, m.result);
      }
    }
    setDomains(Array.from(map.entries()).map(([domain, result]) => ({ domain, result })));
  }, [progress]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (evtRef.current) {
        evtRef.current.close();
        evtRef.current = null;
      }
    };
  }, []);

  const filtered = domains.filter((d) => d.result?.status === 'no-dns' || d.result?.parked);
  const pct = Math.min(100, Math.round((stats.visited / stats.maxPages) * 100));
  const etaText =
    stats.etaSec == null
      ? '—'
      : stats.etaSec > 90
      ? `${Math.round(stats.etaSec / 60)}m`
      : `${Math.round(stats.etaSec)}s`;

  return (
    <div style={{ maxWidth: 1000, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Expired Outbound Link Scanner</h1>
      <p>Find external links to domains that don’t resolve (likely expired) or look parked.</p>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={startUrl}
          onChange={(e) => setStartUrl(e.target.value)}
          style={{ flex: 1, minWidth: 280, padding: 8 }}
          placeholder="https://example.com"
        />
        <label style={{ fontSize: 12 }}>
          maxPages&nbsp;
          <input
            type="number"
            min={5}
            step={5}
            value={stats.maxPages}
            onChange={(e) => setStats((s) => ({ ...s, maxPages: Number(e.target.value) || 100 }))}
            style={{ width: 100, padding: 6 }}
            title="Max pages"
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
          />
        </label>
        <button onClick={startScan} disabled={isScanning || !startUrl.trim()}>
          {isScanning ? 'Scanning…' : 'Start Scan'}
        </button>
      </div>

      {scanId && (
        <p style={{ marginTop: 8, fontSize: 12, color: '#555' }}>
          Scan ID: <code>{scanId}</code>
        </p>
      )}

      {/* Status line */}
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

      {/* Stats + Progress */}
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', fontSize: 14, flexWrap: 'wrap' }}>
          <div>Pages: {stats.visited}/{stats.maxPages}</div>
          <div>Queue: {stats.inQueue}</div>
          <div>Domains checked: {stats.checkedDomains}</div>
          <div>Rate: {stats.crawlRate?.toFixed(2) ?? 0} p/s</div>
          <div>ETA: {etaText}</div>
        </div>
        <div style={{ height: 10, background: '#eee', borderRadius: 6, overflow: 'hidden', marginTop: 6 }}>
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: '#4f46e5',
              transition: 'width .4s',
            }}
          />
        </div>
      </div>

      {/* Results */}
      <h3 style={{ marginTop: 24 }}>Likely Expired / Parked Domains</h3>
      <table width="100%" cellPadding="6" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Domain</th>
            <th align="left">Reason</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length ? (
            filtered.map(({ domain, result }) => (
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
                <td>
                  {result.status === 'no-dns' && 'No DNS (NXDOMAIN/ENOTFOUND)'}
                  {result.parked && (result.status === 'no-dns' ? ' + ' : '')}
                  {result.parked && 'Parked page heuristics'}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2} style={{ color: '#777' }}>
                {isScanning ? 'Scanning…' : 'No likely expired/parked domains found yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
