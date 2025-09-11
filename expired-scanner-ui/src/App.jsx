import { useState } from 'react';
import Scanner from './Scanner';
import Results from './Results';

export default function App() {
    const [page, setPage] = useState('scanner');

    return (
        <div style={{ maxWidth: 1000, margin: '2rem auto', fontFamily: 'system-ui' }}>
            <nav style={{ display: 'flex', gap: 16, borderBottom: '1px solid #ccc', paddingBottom: 8, marginBottom: 16 }}>
                <button onClick={() => setPage('scanner')} disabled={page === 'scanner'}>
                    Scanner
                </button>
                <button onClick={() => setPage('results')} disabled={page === 'results'}>
                    Results
                </button>
            </nav>

            {page === 'scanner' && <Scanner />}
            {page === 'results' && <Results />}
        </div>
    );
}