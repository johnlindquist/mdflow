import { describe, expect, test } from 'bun:test';
import middleware, { config } from './middleware';

describe('page representation negotiation', () => {
    test.each([
        ['text/markdown', '/index.md'],
        ['text/markdown, text/html;q=0.5', '/index.md'],
        ['text/html;q=0.5, text/markdown;q=0.9', '/index.md'],
        ['text/markdown;q=0.5, text/*;q=0.1', '/index.md'],
        ['TEXT/MARKDOWN', '/index.md'],
    ])('serves Markdown for %s', (accept, path) => {
        const response = middleware(new Request('https://mdflow.dev/', { headers: { Accept: accept } }));
        expect(response.headers.get('x-middleware-rewrite')).toBe(`https://mdflow.dev${path}`);
        expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
        expect(response.headers.get('Vary')).toContain('Accept');
    });

    test.each(['*/*', 'text/html', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'text/markdown;q=0, */*;q=1', 'text/html;q=1, text/markdown;q=0.5'])('keeps HTML for %s', (accept) => {
        const response = middleware(new Request('https://mdflow.dev/', { headers: { Accept: accept } }));
        expect(response.headers.get('x-middleware-next')).toBe('1');
        expect(response.headers.get('x-middleware-rewrite')).toBeNull();
        expect(response.headers.get('Vary')).toContain('Accept');
    });

    test('rewrites article representation without losing query parameters', () => {
        const response = middleware(new Request('https://mdflow.dev/docs/?from=agent', { headers: { Accept: 'text/markdown' } }));
        expect(response.headers.get('x-middleware-rewrite')).toBe('https://mdflow.dev/docs.md?from=agent');
    });

    test('the field note is negotiated at its public URL as well as directly readable as Markdown', () => {
        for (const path of ['/the-trust-boundary', '/the-trust-boundary/']) {
            expect(config.matcher).toContain(path);
            const r = middleware(new Request('https://mdflow.dev' + path, { headers: { Accept: 'text/markdown' } }));
            expect(r.headers.get('x-middleware-rewrite')).toBe('https://mdflow.dev/the-trust-boundary.md');
        }
    });

    test.each(['application/json', 'text/html;q=0,text/markdown;q=0,*/*;q=1'])('rejects unsupported representations: %s', async (accept) => {
        const response = middleware(new Request('https://mdflow.dev/', { headers: { Accept: accept } }));
        expect(response.status).toBe(406);
        expect(await response.text()).toContain('text/html or text/markdown');
    });

    test('HEAD rejection contains no response body', async () => {
        const response = middleware(new Request('https://mdflow.dev/', { method: 'HEAD', headers: { Accept: 'application/json' } }));
        expect(response.status).toBe(406);
        expect(await response.text()).toBe('');
    });
});

describe('public source facts contract', () => {
    test.each(['GET', 'HEAD'])('allows %s with JSON or wildcard Accept', (method) => {
        for (const accept of ['application/json', 'application/*', '*/*']) {
            const response = middleware(new Request('https://mdflow.dev/facts.json', { method, headers: { Accept: accept } }));
            expect(response.headers.get('x-middleware-next')).toBe('1');
            expect(response.headers.get('Vary')).toContain('Accept');
        }
    });

    test.each(['POST', 'PUT', 'DELETE'])('rejects %s without a write interface', async (method) => {
        const response = middleware(new Request('https://mdflow.dev/facts.json', { method }));
        expect(response.status).toBe(405);
        expect(response.headers.get('Allow')).toBe('GET, HEAD');
        expect(response.headers.get('Content-Type')).toContain('application/problem+json');
        expect(await response.json()).toMatchObject({ type: 'about:blank', status: 405, instance: '/facts.json' });
    });

    test.each(['text/*', 'application/json;q=0,*/*;q=1'])('rejects unaccepted JSON: %s', async (accept) => {
        const response = middleware(new Request('https://mdflow.dev/facts.json', { headers: { Accept: accept } }));
        expect(response.status).toBe(406);
        expect(await response.json()).toMatchObject({ status: 406, title: 'Not Acceptable' });
    });
});
