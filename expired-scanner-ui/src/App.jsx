import { useState } from 'react';
import Scanner from './Scanner';
import Results from './Results';
import Summary from './Summary';

export default function App() {
    const [page, setPage] = useState('scanner');
    // State to hold the website clicked from the summary page
    const [selectedWebsite, setSelectedWebsite] = useState(null);

    // This function is called from the Summary page
    const handleWebsiteSelect = (website) => {
        setSelectedWebsite(website);
        setPage('results'); // Switch to the results page
    };
    
    // This function is for the main navigation buttons
    const navigate = (pageName) => {
        setSelectedWebsite(null); // Clear any selected website when using main navigation
        setPage(pageName);
    }

    return (
        <div style={{ maxWidth: 1000, margin: '2rem auto', fontFamily: 'system-ui' }}>
            <nav style={{ display: 'flex', gap: 16, borderBottom: '1px solid #ccc', paddingBottom: 8, marginBottom: 16 }}>
                <button onClick={() => navigate('scanner')} disabled={page === 'scanner'}>
                    Scanner
                </button>
                <button onClick={() => navigate('results')} disabled={page === 'results'}>
                    Results
                </button>
                <button onClick={() => navigate('summary')} disabled={page === 'summary'}>
                    Summary
                </button>
            </nav>

            {page === 'scanner' && <Scanner />}
            {/* Pass the selected website down to the Results component */}
            {page === 'results' && <Results initialWebsite={selectedWebsite} />}
            {/* Pass the handler function down to the Summary component */}
            {page === 'summary' && <Summary onWebsiteSelect={handleWebsiteSelect} />}
        </div>
    );
}