import { useState, useEffect } from 'react';
import axios from 'axios';

export default function Results({ initialWebsite = null }) {
    const [results, setResults] = useState([]);
    const [website, setWebsite] = useState(initialWebsite || '');
    const [tld, setTld] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    
    // --- NEW STATE for the dropdown ---
    const [reasons, setReasons] = useState([]);
    const [selectedReason, setSelectedReason] = useState('');

    // --- NEW useEffect: Fetch the unique reasons when the component loads ---
    useEffect(() => {
        const fetchReasons = async () => {
            try {
                const { data } = await axios.get('http://localhost:4000/results/reasons');
                setReasons(data);
            } catch (error) {
                console.error("Failed to fetch reasons", error);
            }
        };
        fetchReasons();
    }, []);

    useEffect(() => {
        setWebsite(initialWebsite || '');
    }, [initialWebsite]);

    // --- UPDATED useEffect: Now correctly re-runs when TLD or reason changes ---
    useEffect(() => {
        fetchResults();
    }, [website, tld, selectedReason]); // Add dependencies here

    const fetchResults = async () => {
        setIsLoading(true);
        const params = {};
        if (website) params.website = website;
        if (tld) params.tld = tld;
        if (selectedReason) params.reason = selectedReason; // Add reason to the request
        
        try {
            const { data } = await axios.get('http://localhost:4000/results', { params });
            setResults(data);
        } catch (error) {
            console.error("Failed to fetch results", error);
        } finally {
            setIsLoading(false);
        }
    };
    
    // --- UPDATED handleSearch: Clear other filters when one is used manually ---
    const handleSearch = (e) => {
        e.preventDefault();
        // This is now just for the text inputs, the dropdown triggers its own search
        fetchResults();
    }
    
    return (
        <div>
            <h2>Stored Expired Domain Results</h2>
            {/* --- FORM UPDATED with new Dropdown --- */}
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="Filter by website..."
                    style={{ flex: 1, minWidth: '200px', padding: 8 }}
                />
                <input
                    value={tld}
                    onChange={(e) => setTld(e.target.value)}
                    placeholder="Filter by TLD..."
                    style={{ width: 150, padding: 8 }}
                />
                
                <select 
                    value={selectedReason} 
                    onChange={(e) => setSelectedReason(e.target.value)}
                    style={{ width: 220, padding: 8 }}
                >
                    <option value="">Filter by Expiry Reason...</option>
                    <option value="has-expiry-date">Has Valid Expiry Date</option>
                    {reasons.map(reason => (
                        <option key={reason} value={reason}>{reason}</option>
                    ))}
                </select>

                <button type="submit" disabled={isLoading}>{isLoading ? 'Searching...' : 'Search'}</button>
            </form>

            <table width="100%" cellPadding="6" style={{ borderCollapse: 'collapse' }}>
                <thead>
                    <tr>
                        <th align="left">Website Scanned</th>
                        <th align="left">Expired Domain Found</th>
                        <th align="left">Status</th>
                        <th align="left">Expiry Date / Reason</th>
                        <th align="left">Date Found</th>
                    </tr>
                </thead>
                <tbody>
                    {isLoading ? (
                        <tr><td colSpan="5">Loading...</td></tr>
                    ) : results.length ? (
                        results.map((result) => (
                            <tr key={result._id}>
                                <td>{result.website}</td>
                                <td>
                                    <a
                                        href={`http://${result.domain}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{ color: '#2563eb', textDecoration: 'underline' }}
                                    >
                                        {result.domain}
                                    </a>
                                </td>
                                <td>{result.status}</td>
                                <td>{result.expiryDate || result.expiryDateReason || 'N/A'}</td>
                                <td>{new Date(result.foundAt).toLocaleString()}</td>
                            </tr>
                        ))
                    ) : (
                        <tr>
                            <td colSpan="5" style={{ color: '#777' }}>
                                No results found for the current filters.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}