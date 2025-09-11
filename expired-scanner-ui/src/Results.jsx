import { useState, useEffect } from 'react';
import axios from 'axios';

export default function Results() {
    const [results, setResults] = useState([]);
    const [website, setWebsite] = useState('');
    const [tld, setTld] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        fetchResults();
    }, []);

    const fetchResults = async () => {
        setIsLoading(true);
        const params = {};
        if (website) params.website = website;
        if (tld) params.tld = tld;
        try {
            const { data } = await axios.get('http://localhost:4000/results', { params });
            setResults(data);
        } catch (error) {
            console.error("Failed to fetch results", error);
        } finally {
            setIsLoading(false);
        }
    };
    
    const handleSearch = (e) => {
        e.preventDefault();
        fetchResults();
    }

    return (
        <div>
            <h2>Stored Expired Domain Results</h2>
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
                <input
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="Filter by website (e.g., example.com)"
                    style={{ flex: 1, padding: 8 }}
                />
                <input
                    value={tld}
                    onChange={(e) => setTld(e.target.value)}
                    placeholder="Filter by TLD (e.g., com)"
                    style={{ width: 150, padding: 8 }}
                />
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
                                {/* --- UPDATED LOGIC: Show date or reason --- */}
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