import { useState, useEffect } from 'react';
import axios from 'axios';

// The component now accepts the onWebsiteSelect function as a prop
export default function Summary({ onWebsiteSelect }) {
    const [summary, setSummary] = useState([]);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const fetchSummary = async () => {
            setIsLoading(true);
            try {
                const { data } = await axios.get('http://localhost:4000/summary');
                setSummary(data);
            } catch (error) {
                console.error("Failed to fetch summary", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSummary();
    }, []);

    return (
        <div>
            <h2>Scans Summary</h2>
            <p>This page shows a count of all expired domains found for each website you have scanned. Click a website to see its results.</p>
            <table width="100%" cellPadding="6" style={{ borderCollapse: 'collapse', marginTop: '16px' }}>
                <thead>
                    <tr>
                        <th align="left">Website Scanned</th>
                        <th align="left">Expired Domains Found</th>
                    </tr>
                </thead>
                <tbody>
                    {isLoading ? (
                        <tr><td colSpan="2">Loading...</td></tr>
                    ) : summary.length ? (
                        summary.map((item) => (
                            <tr key={item.website}>
                                <td>
                                    {/* Make the website name a clickable button-like link */}
                                    <a
                                        href="#"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            onWebsiteSelect(item.website);
                                        }}
                                        style={{ color: '#2563eb', textDecoration: 'underline', cursor: 'pointer' }}
                                    >
                                        {item.website}
                                    </a>
                                </td>
                                <td>{item.count}</td>
                            </tr>
                        ))
                    ) : (
                        <tr>
                            <td colSpan={2} style={{ color: '#777' }}>
                                No scan results found in the database.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}