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
  const [autoResumeEnabled, setAutoResumeEnabled] = useState(false);
  const [autoResumeDelay, setAutoResumeDelay] = useState(5);
  const [autoResumeRepeat, setAutoResumeRepeat] = useState(5);
  const [autoResumeInfinite, setAutoResumeInfinite] = useState(false);
  const evtRef = useRef(null);

  const checkScanStatus = async () => {
    if (!startUrl || !startUrl.startsWith('http')) {
      setExistingScan(null);
      return;
    }
    setIsCheckingScan(true);
    try {
      const { data } = await axios.get(`http://localhost:4000/scan/status?startUrl=${encodeURIComponent(startUrl)}`);
      setExistingScan(data.exists ? data : null);
    } catch (error) {
      setExistingScan(null);
      console.error("Failed to check scan status", error);
    } finally {
      setIsCheckingScan(false);
    }
  };

  useEffect(() => {
    const handler = setTimeout(() => checkScanStatus(), 500);
    return () => clearTimeout(handler);
  }, [startUrl]);

  const startScan = async (mode = 'new') => {
    setProgress([]);
    setDomains([]);
    setIsScanning(true);
    setStatusLine('Connecting…');
    setExistingScan(null);

    try {
      const { data } = await axios.post('http://localhost:4000/scan', {
        startUrl,
        maxPages: stats.maxPages,
        concurrency: stats.concurrency,
        mode,
        isAggressive,
        autoResume: {
          enabled: autoResumeEnabled,
          delayMinutes: Number(autoResumeDelay),
          repeat: autoResumeInfinite ? 'infinite' : Number(autoResumeRepeat)
        }
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
            setStatusLine(`Scanning: ${msg.startUrl} (batchSize ${msg.batchSize}, mode=${msg.mode})`);
            break;
          case 'page':
            setStatusLine(`Page: ${msg.stage || ''} ${msg.url || ''}`);
            break;
          case 'domain':
            setStatusLine(`Domain: ${msg.stage || ''} ${msg.domain || ''}`);
            break;
          case 'stats':
            setStats((prev) => ({ ...prev, ...msg }));
            break;
          case 'error':
            setStatusLine(`Error: ${msg.error}`);
            setIsScanning(false);
            break;
          case 'paused':
            setStatusLine(`Scan paused. Total Pages: ${msg.totalPages}. ${autoResumeEnabled ? 'Auto-resume scheduled.' : 'You can resume later.'}`);
            if (evtRef.current) {
              evtRef.current.close();
              evtRef.current = null;
            }
            setIsScanning(false);
            checkScanStatus();
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
    } catch (error) {
      console.error("Failed to start scan", error);
      setStatusLine(`Error starting scan: ${error.response?.data?.error || error.message}`);
      setIsScanning(false);
    }
  };

  const interruptScan = async () => {
    if (!scanId) return;
    try {
      await axios.post(`http://localhost:4000/scan/${scanId}/interrupt`);
      setStatusLine('Scan interrupted by user.');
      setIsScanning(false);
      if (evtRef.current) {
        evtRef.current.close();
        evtRef.current = null;
      }
      checkScanStatus();
    } catch (error) {
      console.error("Failed to interrupt scan", error);
      setStatusLine('Failed to interrupt scan.');
    }
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

  useEffect(() => {
    if (autoResumeInfinite) {
      setAutoResumeRepeat(1);
    }
  }, [autoResumeInfinite]);

  const filtered = domains.filter((d) => d.result?.status === 'no-dns');

  return (
    <div>
      <h1>Expired Outbound Link Scanner</h1>
      <p>Find external links to domains that don’t resolve (likely expired).</p>
      
      <div style={{ padding: '16px', border: '1px solid #ddd', borderRadius: '8px' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={startUrl} onChange={(e) => setStartUrl(e.target.value)} style={{ flex: 1, minWidth: 280, padding: 8 }} placeholder="https://example.com" disabled={isScanning} />
            <label style={{ fontSize: 12 }}>batchSize&nbsp;<input type="number" min={100} step={100} value={stats.maxPages} onChange={(e) => setStats(s => ({...s, maxPages: Number(e.target.value) || 1000}))} style={{ width: 100, padding: 6 }} disabled={isScanning}/></label>
            <label style={{ fontSize: 12 }}>concurrency&nbsp;<input type="number" min={1} max={10} value={stats.concurrency} onChange={(e) => setStats(s => ({...s, concurrency: Number(e.target.value) || 5}))} style={{ width: 100, padding: 6 }} disabled={isScanning}/></label>
        </div>
        <div style={{ marginTop: '12px' }}>
            <label style={{ fontSize: 14, cursor: 'pointer' }}><input type="checkbox" checked={isAggressive} onChange={(e) => setIsAggressive(e.target.checked)} disabled={isScanning} style={{ verticalAlign: 'middle', marginRight: '6px' }}/>Aggressive Crawl</label>
        </div>
        
        <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #eee' }}>
            <label style={{ fontSize: 14, cursor: 'pointer', fontWeight: 'bold' }}><input type="checkbox" checked={autoResumeEnabled} onChange={(e) => setAutoResumeEnabled(e.target.checked)} disabled={isScanning} style={{ verticalAlign: 'middle', marginRight: '6px' }}/>Enable Auto-Resume</label>
            {autoResumeEnabled && (
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: '8px', paddingLeft: '20px', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: 12 }}>Delay (minutes)&nbsp;<input type="number" min="1" value={autoResumeDelay} onChange={(e) => setAutoResumeDelay(e.target.value)} style={{ width: 60, padding: 6 }} disabled={isScanning} /></label>
                    <label style={{ fontSize: 12 }}>Repeat (times)&nbsp;<input type="number" min="1" value={autoResumeRepeat} onChange={(e) => setAutoResumeRepeat(e.target.value)} style={{ width: 60, padding: 6 }} disabled={isScanning || autoResumeInfinite} /></label>
                    <label style={{ fontSize: 12 }}><input type="checkbox" checked={autoResumeInfinite} onChange={(e) => setAutoResumeInfinite(e.target.checked)} disabled={isScanning} />Until Finished</label>
                </div>
            )}
        </div>
      </div>
      
      <div style={{ marginTop: '16px', display: 'flex', gap: 8, alignItems: 'center' }}>
        {!isScanning && !existingScan && (<button onClick={() => startScan('new')} disabled={isCheckingScan || !startUrl.trim()}>{isCheckingScan ? 'Checking…' : 'Start New Scan'}</button>)}
        {!isScanning && existingScan && (
            <>
                <button onClick={() => startScan('resume')} style={{background: '#2563eb', color: 'white'}}>{`Resume (${existingScan.visitedCount} done)`}</button>
                <button onClick={() => startScan('new')} style={{ background: '#be123c', color: 'white'}}>Start Fresh</button>
            </>
        )}
        {isScanning && (<button onClick={interruptScan} style={{ background: '#d97706', color: 'white'}}>Interrupt Scan</button>)}
      </div>
      
      {existingScan && !isScanning && (
          <p style={{ fontSize: 12, color: '#999', margin: '8px 0'}}>
              Found a paused scan for this site. Queue has {existingScan.queueCount} URLs remaining.
          </p>
      )}

      {scanId && ( <p style={{ marginTop: 8, fontSize: 12, color: '#555' }}>Scan ID: <code>{scanId}</code></p>)}
      
      <div style={{ marginTop: 12, padding: '8px 10px', background: '#eef2ff', border: '1px solid #c7d2fe', color: '#1e1b4b', borderRadius: 6, fontSize: 14, }}>
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
      
      <h3 style={{ marginTop: 24 }}>Expired Domains Found (This Session)</h3>
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
                  <a href={`http://${domain}`} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', textDecoration: 'underline' }}>
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