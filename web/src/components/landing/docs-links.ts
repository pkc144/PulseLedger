export const repositoryUrl = 'https://github.com/pkc144/PulseLedger';
export const docsBaseUrl = import.meta.env.VITE_DOCS_BASE_URL || `${repositoryUrl}/blob/main/docs`;

export const docsLinks = [
  { href: `${docsBaseUrl}/API.md`, label: 'API reference' },
  { href: `${docsBaseUrl}/ARCHITECTURE.md`, label: 'Architecture' },
  { href: `${docsBaseUrl}/adr/README.md`, label: 'Decision records' },
  { href: `${docsBaseUrl}/TESTING.md`, label: 'Testing & proof' },
  { href: `${docsBaseUrl}/TRADEOFFS.md`, label: 'Trade-offs & limits' },
  { href: repositoryUrl, label: 'Source on GitHub' },
];
