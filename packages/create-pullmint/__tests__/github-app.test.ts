import { buildAppManifest, buildManifestUrl, isValidPem } from '../src/github-app';

describe('buildAppManifest', () => {
  it('sets webhook URL by appending /webhook', () => {
    const manifest = buildAppManifest('https://pullmint.example.com');
    expect(manifest.hook_attributes.url).toBe('https://pullmint.example.com/webhook');
  });

  it('strips trailing slash from webhookUrl before appending /webhook', () => {
    const manifest = buildAppManifest('https://pullmint.example.com/');
    expect(manifest.hook_attributes.url).toBe('https://pullmint.example.com/webhook');
  });

  it('includes required permissions', () => {
    const manifest = buildAppManifest('https://pullmint.example.com');
    expect(manifest.default_permissions.pull_requests).toBe('write');
    expect(manifest.default_permissions.contents).toBe('read');
    expect(manifest.default_permissions.deployments).toBe('read');
  });

  it('includes required events', () => {
    const manifest = buildAppManifest('https://pullmint.example.com');
    expect(manifest.default_events).toContain('pull_request');
    expect(manifest.default_events).toContain('deployment_status');
  });
});

describe('buildManifestUrl', () => {
  it('returns a GitHub App creation URL with encoded manifest', () => {
    const url = buildManifestUrl('https://pullmint.example.com');
    expect(url).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?manifest=/);

    const manifestParam = decodeURIComponent(url.split('?manifest=')[1]);
    const parsed = JSON.parse(manifestParam) as { name: string };
    expect(parsed.name).toBe('pullmint');
  });

  it('uses org-scoped URL when orgOrUser is provided', () => {
    const url = buildManifestUrl('https://pullmint.example.com', 'pullmint', 'my-org');
    expect(url).toMatch(/^https:\/\/github\.com\/organizations\/my-org\/settings\/apps\/new/);
  });
});

describe('isValidPem', () => {
  it('returns true for RSA private key header', () => {
    expect(isValidPem('-----BEGIN RSA PRIVATE KEY-----\ndata\n-----END RSA PRIVATE KEY-----')).toBe(
      true
    );
  });

  it('returns true for PKCS#8 private key header', () => {
    expect(isValidPem('-----BEGIN PRIVATE KEY-----\ndata\n-----END PRIVATE KEY-----')).toBe(true);
  });

  it('returns false for arbitrary strings', () => {
    expect(isValidPem('not-a-pem')).toBe(false);
    expect(isValidPem('')).toBe(false);
  });
});
