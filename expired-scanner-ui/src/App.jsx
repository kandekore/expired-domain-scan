import { useState } from 'react';
import Scanner from './Scanner';
import Results from './Results';
import Summary from './Summary'; // Import the new component

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
                {/* Add the new Summary button */}
                <button onClick={() => setPage('summary')} disabled={page === 'summary'}>
                    Summary
                </button>
            </nav>

            {page === 'scanner' && <Scanner />}
            {page === 'results' && <Results />}
            {page === 'summary' && <Summary />}
        </div>
    );
}