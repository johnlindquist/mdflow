import { next, rewrite } from '@vercel/functions';

// Pages negotiate HTML/Markdown; the source-facts resource is read-only JSON.
// Other static assets and nonexistent routes retain their own HTTP semantics.
export const config = {
    matcher: ['/', '/index.html', '/about', '/about/', '/contact', '/contact/', '/privacy', '/privacy/', '/docs', '/docs/', '/evolve-deep-dive', '/evolve-deep-dive/', '/the-trust-boundary', '/the-trust-boundary/', '/facts.json'],
};

function quality(accept: string, type: string): number {
    const wildcard = `${type.split('/')[0]}/*`;
    let specificity = -1;
    let quality = 0;
    for (const range of accept.toLowerCase().split(',')) {
        const [media, ...parameters] = range.trim().split(';');
        const candidate = media.trim();
        const match = candidate === type ? 2 : candidate === wildcard ? 1 : candidate === '*/*' ? 0 : -1;
        if (match < 0) continue;
        const q = parameters.map((value) => value.trim()).find((value) => value.startsWith('q='));
        const value = q === undefined ? 1 : Number(q.slice(2));
        const weight = Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
        if (match > specificity) {
            specificity = match;
            quality = weight;
        } else if (match === specificity) {
            quality = Math.max(quality, weight);
        }
    }
    return quality;
}

function problem(request: Request, status: number, title: string, detail: string): Response {
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({
        type: 'about:blank', title, status, detail,
        instance: new URL(request.url).pathname,
        resolution: 'Use GET with an advertised representation. See https://mdflow.dev/docs/ and https://mdflow.dev/openapi.json.',
    }), {
        status,
        headers: {
            'Content-Type': 'application/problem+json; charset=utf-8',
            Vary: 'Accept, Accept-Encoding',
            'Cache-Control': 'no-store',
            ...(status === 405 ? { Allow: 'GET, HEAD' } : {}),
        },
    });
}

export default function middleware(request: Request): Response {
    const headers = { Vary: 'Accept, Accept-Encoding' };
    const accept = request.headers.get('Accept') ?? '*/*';
    if (new URL(request.url).pathname === '/facts.json') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return problem(request, 405, 'Method Not Allowed', 'Source facts are read-only. Use GET or HEAD; no state was changed.');
        }
        if (quality(accept, 'application/json') === 0) {
            return problem(request, 406, 'Not Acceptable', 'Source facts are available as application/json.');
        }
        return next({ headers });
    }
    const html = quality(accept, 'text/html');
    const markdown = quality(accept, 'text/markdown');
    if (html === 0 && markdown === 0) {
        return problem(request, 406, 'Not Acceptable', 'Request text/html or text/markdown.');
    }
    // HTML wins a wildcard tie; explicitly requested Markdown wins a tie.
    const explicitMarkdown = accept.toLowerCase().split(',').some((range) => range.split(';')[0].trim() === 'text/markdown');
    if (markdown > 0 && (markdown > html || (markdown === html && explicitMarkdown))) {
        const url = new URL(request.url);
        const slug = url.pathname.replace(/^\//, '').replace(/\/$/, '');
        url.pathname = slug === '' || slug === 'index.html' ? '/index.md' : `/${slug}.md`;
        return rewrite(url, { headers: { ...headers, 'Content-Type': 'text/markdown; charset=utf-8' } });
    }
    return next({ headers });
}
