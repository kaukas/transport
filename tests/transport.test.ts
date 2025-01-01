import { it, expect, afterEach, afterAll, vi } from 'vitest';
import mockFs from 'mock-fs';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { ChildProcess, execSync, ExecSyncOptions, spawn } from 'child_process';
import { setupServer } from 'msw/node';
import { DefaultBodyType, http, HttpResponse, StrictRequest } from 'msw';
import { homedir, tmpdir } from 'os';
import { dirname, join, normalize } from 'path';
import { transport } from '../src/transport.cjs';
import EventEmitter from 'events';
import { Readable, Writable } from 'stream';

vi.mock('child_process');

const server = setupServer();
server.listen({ onUnhandledRequest: 'error' });
afterAll(() => server.close());

const jstr = JSON.stringify;
const jparse = JSON.parse;

const rootDir = normalize(join(dirname(__filename), '..'));
/**
 * Generated with
 *
 *     jose.JWK.createKey('RSA', 2048, { use: 'sig' }).then((key) => key.toPEM(true));
 */
const sb1Key = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAnrBsIpFewzctjv8/aDpbmRGDNQJko16lzCzFHPQqkLulo8qQ
y0VTwlZAGtVqEyjaqxKVGqvlDGL9OJrWKuzxOD2EvnegWtyCl6o2k8vsEs6Bq+j1
XyeSZA11ZIe7N0KyPwzqzlfj6PeFrGU7cxu6ziLh16SNJOzYp8hZ6YyZwP7xgGLs
NeTMCJ4UuyXLGs7YRII3FMl6PO7kuHUdhrvoC+VAxEX6lxujm5DzRizlh0ZIX5yb
P5KwW6X0jnEksC+ZQLNIxzwFjwjm1OVcXHOF1HiaiuMm0D0MjKQNNrL5edvkKlgt
rBNxP/5pNW6PJH6aiOm7rCQTTzRV24hKq72CWQIDAQABAoIBAEzYMgUrUDBIcA9n
G1VlrSWajWcGGaXjF3af13QF6PbdZ4DBfwxwLfdVvQVBg3RzvDBLd1jLFMfCx8y5
biyrQMRzRezWERju326CRpubjF4vEiwlS20gxIse2VItSEOiUJ6nqqzxcrRF6L1q
6Db9nqBj0+mRDahr6R6WrrOiGnKSPq+KBB8KrjV9lO2HitYYD3Xwp9xBRSAfESk3
HnEaZs7V7O/x7o9u3nWrkaHKMatySeldg6/X910a5gZHNpPUcYw2sRJWZhn0eizY
tpC2Xs4ZcvHaL/82U5G3DYs4EEkFXSnB0fLvd2/6A06OvRlNh1G6raRxeDPfCBMg
ZRAO8uECgYEA2TTQvH+TURAfEpfVVS/b7jsVLB5wPFzzt7+ltaOVKqYXbkaD9H2d
Qnt8Se1Gha6UM9bOrUC8GhGlmUSZPgKRTs681H9BCtsk1kiNAuNVPwSXfPW1N0CB
y8tiKFHRPIcfURe57VBg5mL+tGXisdP9wqtFCde0AxGzwvskBk77PXsCgYEAuwgQ
guLKb60XephGhQmUEkGyf1bQvpsXXbEMQzsqrVGyPIj+49JmU2hnuGeVGad9cW56
1fI5lg330CWpuKRdpocQGHF6nu9N7dGxswhXIi+ktG7OSKtdZoGK82VBiliWc1Rz
DKEfdDeGrnthLdm+FFawo2G00UcwMvbH1shd1TsCgYEAsTF898m7jG3ya2CiEJSy
fm6EnzFVrmjGCii2Lq/8iIZmpvevvkybdhj3E/gViAkbrg6XHI+q5DlxNs/Xk9bU
Y84UDeaiURDlxEn7f1elu3srei2YYDKnsHGC6hGU+CPjUGxiqU7hPhGUZ+aWQSwH
4D+IWrc1iytt0qq+gMb9/vECgYA24RDnNuCrkCCZimD23G6kRL65eqHZq+xZQ4AT
oiLNpHEmLhSMiMoZo0L76vjnBCxcwkwsxtx62TJj0wlP8nrASFVCttmCFTnKlIMN
w1692zj68KB61j2bvFsnPAjVLVVIFfmENSrjkP9l5zIGoCOUGDPQXPUPi1HrQlo0
/an6zQKBgQCvkCydAIy8TaDX/ybSq8nTtm8fKsryZTLuad5CPFgLHS4S7zm+kpDf
zXjsH5mujVZqASximLKPTng61/8OziHk/vwzl98wvof9jEa+jU3hV9A3+YmjGZhw
kGUQnwlA8Mmv4UcwzgucHFDGW4NOSKmhi38oHm/LL61RT8DY3IePcQ==
-----END RSA PRIVATE KEY-----`;
const sb2Key = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA6x8Tb0JCLyTvZR7zg0UPlyUSGnIcBQfrRkfSWGmJZSGKqhil
KDQi72rMBdqiCZt1K3mzrjLaL0iZ5HePG06MZ3kGtzE39NfYisXUyqxfW/hA06SP
hUUv2YuGWXmIR9sCMz1+i2+/Y6AR4g3r0rm3scpLiHSzVeKxFghhXqoMr3iIF9wg
0v6cuYpYLvQTmSZ7N14YfktuxZrIrf4ancnmbX77JNkxtSZT3YUan0c5DNMaj63f
JmWGVnN/aGL2mqUlxAcKI/ch8HyNv/8WK3HDfn5cq4ALXY5On7RIuXfeDvr2uD3G
Cq0/Gg6MUoX8GRnDEKKvWf3PbCUJjuCakF9CXwIDAQABAoIBAAMOgF4t6lZakJIr
+NZ4C1/Xp4iYeyzFkZV0UZO8q4CZEwhrEZqYMuwR410gHoMpdjh+eIuHNbbvprCF
rWKZftHJjQDMrwGL3NDRCZco7oRvkcgul38QCzM00SZQoijs+/ZWklKVvVM6PYFG
1Q4ERBMXoiu/+KThMZQrv7hPVaLiU+FjzBlfoXjI2cZdry+hLsNMoCLIdbpSx744
Vvv+r5Cq+W0sUKyeRoS0g7lQoZJi/y9M9ObaYSKtuSM6GdWUNDPENMh6Yt29Fcye
A+hXcXA9jo3Z1a9GN7ue+wTaOSAJR6eA3nzrTa9iJ4wLA9togAijGo3J8C+/jRp4
TtxFsiECgYEA+Qds6orzu1+htxzFN1YdEzLf1X1ttdD/FFnp/2xdZnkyeKoP6tnQ
RFbY6keCiIc3NGGqfwoHhva3znxYBnBo4GMJfRKfCzyPtP77r59LXD7slfDUFrCS
pApUfm0hNzJJVqmhbApkZjZvxEkszPh3TWHYXe1sr/z8ae9i02w8VrUCgYEA8bP8
lhRxYwd7sO5KCYnWNWTTw8gy5v4SEcY7aANAKZ0AKX8SCUfSHQ2S0gvxflaQnCzE
0ST/DXqEdb6ZpIr5oe6wdzp1IXtzmIr8CBfDUIH5f/8P2eaz2hsrUPVuGFySeCjl
EVnjG2MRR/on7+bWTuGHQYgP7aaGHTaA+9lz7UMCgYBxWzfw659Ww4lRWP9M2R4T
By1seNPf12rFUMh7RFCfvLuEwaTNOqja8s16l2KL00EFzw9VFLOoc9XnYCKRi8mx
mmNPU5KiAsdHlGns343mR55aAm4Ihge6NBmSEwrznShVEpIwI+rfvBfUOZrzEob7
6nYbC2BWG8qqThWmN7afoQKBgAxY+YphOPmqJDOBuN6L4BmSMQ9LZu5OBHZL/jTu
FZUKpDt6dl1rAdziGKIKYifmHDUeRF+62BzEKYgqWIcDYoVXQESXA+zV9a3RS9bN
//hY63oSeajUFFQMF0Zng1xTPlhNHoaoZOW9ReC7ctbaoBAfjV1Xqhil7SwI4MX8
8eMpAoGBAIUdpWVeuGbfAGxXGYvx/10+IO13c32Ne9klIdRKl2EycLk5ydzskVEL
g/bUADKzZ0Zz2PDNP0M027fjrLYWwPBBMKKC3WF21tW0nOd7K+//Dc5s3MP2iirz
mjQiqHcqXFa/vOMxrbXuXoQMO6MNmbgSX9MtDVOu/jEQnYi55gNP
-----END RSA PRIVATE KEY-----`;

const accessConfig = { _id: 'access-config' };
const stdLayout = {
  [tmpdir()]: null,
  [join(homedir(), '.config', 'transport', 'connections.json')]: jstr({
    'https://sandbox1.io': {
      clientId: 'service-account',
      scope: 'fr:am:*',
      serviceAccountId: 'id1',
      serviceAccountKey: sb1Key,
    },
    'https://sandbox2.io': {
      clientId: 'service-account',
      scope: 'fr:am:*',
      serviceAccountId: 'id2',
      serviceAccountKey: sb2Key,
    },
  }),
};

afterEach(() => {
  vi.resetAllMocks();
  mockFs.restore();
});

function mockObjectSelection(output: string[]): ChildProcess {
  const mockProcess = new EventEmitter();
  const expectLines = JSON.parse(JSON.stringify(output)) as string[];
  const outputLines = [];
  mockProcess.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const line = chunk.toString();
      const idx = expectLines.indexOf(line.split(' ').slice(1).join(' '));
      if (idx > -1) {
        expectLines.splice(idx, 1);
        outputLines.push(line);
      }
      callback();
    },
  });
  mockProcess.stdin.on('finish', () => expect(expectLines).toEqual([]));

  mockProcess.stdout = new Readable({
    read() {
      for (const line of outputLines) {
        this.push(line);
      }
      this.push(null);
      setTimeout(() => mockProcess.emit('close', 0));
    },
  });
  mockProcess.stderr = new Readable({
    read() {
      this.push(null);
    },
  });
  return mockProcess;
}

function pickOperation(name: 'Export' | 'Import' | 'Export New' | 'Open') {
  return ((command: string, options: ExecSyncOptions) => {
    expect(command).toBe('fzf');
    expect(options?.input).toBeTruthy();
    expect(options?.encoding).toBe('utf8');
    return (options!.input as string).split('\n').find((op) => op.includes(name));
  }) as typeof execSync;
}

function pickTenant(substring: string) {
  return ((command: string, options: ExecSyncOptions) => {
    expect(command).toBe('fzf');
    expect(options?.input).toBeTruthy();
    expect(options?.encoding).toBe('utf8');
    const tenant = (options!.input as string).split('\n').find((op) => op.includes(substring));
    if (!tenant) {
      throw new Error(`No tenant found for ${substring}`);
    }
    return tenant + '\n';
  }) as typeof execSync;
}

const tokenHandlers = [1, 2].map((boxId) =>
  http.post(`https://sandbox${boxId}.io/am/oauth2/access_token`, async ({ request }) => {
    const form = await request.formData();
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
      return new HttpResponse('Bad grant type', { status: 400, statusText: 'Bad Request' });
    }
    if (form.get('client_id') !== 'service-account') {
      return new HttpResponse('Bad service account', { status: 400, statusText: 'Bad Request' });
    }
    if (!((form.get('scope') as string) || '').includes('fr:am:*')) {
      return new HttpResponse('Bad scope', { status: 400, statusText: 'Bad Request' });
    }
    const payload = jparse(Buffer.from((form.get('assertion') as string).split('.')[1], 'base64').toString());
    if (payload.sub !== `id${boxId}`) {
      return new HttpResponse('Bad service account ID', { status: 400, statusText: 'Bad Request' });
    }
    return HttpResponse.json({ access_token: `token${boxId}` });
  }),
);

function verifyBoxToken(boxId: number, request: StrictRequest<DefaultBodyType>) {
  const expectToken = `Bearer token${boxId}`;
  const token = request.headers.get('Authorization');
  if (token !== expectToken) {
    throw new HttpResponse(`Expected token ${jstr(expectToken)}, got ${jstr(token)}`, {
      status: 401,
      statusText: 'Unauthorized',
    });
  }
  return true;
}

function getAccessConfig(boxId: number) {
  return http.get(`https://sandbox${boxId}.io/openidm/config/access`, ({ request }) => {
    verifyBoxToken(boxId, request);
    return HttpResponse.json({ _id: 'access-config' });
  });
}

function putAccessConfig(boxId: number) {
  return http.put(`https://sandbox${boxId}.io/openidm/config/access`, async ({ request }) => {
    verifyBoxToken(boxId, request);
    return HttpResponse.json(await request.json());
  });
}

it(
  'exports a static configuration object from a tenant',
  server.boundary(async () => {
    server.use(...tokenHandlers, getAccessConfig(1));
    mockFs({ ...stdLayout });

    const mockedExecSync = vi
      .mocked(execSync)
      .mockImplementationOnce(pickTenant('sandbox1'))
      .mockImplementationOnce(pickOperation('Export'));
    const mockedSpawn = vi.mocked(spawn).mockImplementationOnce(() => mockObjectSelection(['access-config\n']));
    await transport(rootDir, mockedExecSync, mockedSpawn, []);
    await vi.waitFor(() => {
      expect(jparse(readFileSync(`${rootDir}/access-config/access.json`, 'utf8'))).toEqual({ _id: 'access-config' });
    });
  }),
);

it(
  'imports a static configuration object into a tenant',
  server.boundary(async () => {
    let uploadedAccessConfig: any;
    server.use(
      ...tokenHandlers,
      http.put('https://sandbox1.io/openidm/config/access', async ({ request }) => {
        verifyBoxToken(1, request);
        uploadedAccessConfig = await request.json();
        return HttpResponse.json(uploadedAccessConfig);
      }),
    );
    mockFs({ ...stdLayout, [`${rootDir}/access-config/access.json`]: jstr(accessConfig) });

    const mockedExecSync = vi
      .mocked(execSync)
      .mockImplementationOnce(pickTenant('sandbox1'))
      .mockImplementationOnce(pickOperation('Import'));
    const mockedSpawn = vi.mocked(spawn).mockImplementationOnce(() => mockObjectSelection(['access-config\n']));
    await transport(rootDir, mockedExecSync, mockedSpawn, []);
    expect(uploadedAccessConfig).toEqual(accessConfig);
  }),
);

it(
  'accepts tenant as a command line argument',
  server.boundary(async () => {
    server.use(...tokenHandlers, getAccessConfig(2));
    mockFs({ ...stdLayout });
    const mockedExecSync = vi
      .mocked(execSync)
      // 'sandbox2' selected by command line argument.
      .mockImplementationOnce(pickOperation('Export'));
    const mockedSpawn = vi.mocked(spawn).mockImplementationOnce(() => mockObjectSelection(['access-config\n']));
    await transport(rootDir, mockedExecSync, mockedSpawn, ['sandbox2']);
    await vi.waitFor(() => {
      expect(jparse(readFileSync(`${rootDir}/access-config/access.json`, 'utf8'))).toEqual({ _id: 'access-config' });
    });
  }),
);

it('fails if tenant not recognised', async () => {
  mockFs({ ...stdLayout });
  await expect(transport(rootDir, null, null, ['sandbox666'])).rejects.toThrow('No tenants match sandbox666');
});

it('fails if multiple tenants matched', async () => {
  mockFs({ ...stdLayout });
  await expect(transport(rootDir, null, null, ['sand'])).rejects.toThrow(
    'Multiple tenants match sand: https://sandbox1.io, https://sandbox2.io',
  );
});

it(
  'accepts operation as a command line argument',
  server.boundary(async () => {
    server.use(...tokenHandlers, putAccessConfig(2));
    mockFs({ ...stdLayout, [`${rootDir}/access-config/access.json`]: jstr(accessConfig) });
    // 'sandbox2', 'import' selected by command line argument.
    const mockedSpawn = vi.mocked(spawn).mockImplementationOnce(() => mockObjectSelection(['access-config\n']));
    await transport(rootDir, null, mockedSpawn, ['sandbox2', 'import']);
  }),
);

it(
  'fails if operation not recognised',
  server.boundary(async () => {
    server.use(...tokenHandlers);
    mockFs({ ...stdLayout });
    await expect(transport(rootDir, null, null, ['sandbox1', 'transmute'])).rejects.toThrow(
      'Unsupported operation transmute',
    );
  }),
);

// it('accepts filenames as command line arguments', async () => {
//   const vol = Volume.fromJSON({
//     ...stdLayout,
//     [`${rootDir}/locales/en.json`]: jstr({ _id: 'uilocale/en' }),
//     [`${rootDir}/locales/de.json`]: jstr({ _id: 'uilocale/de' }),
//   });
//   let bashCmd: string;
//   vi.mocked(execSync).mockImplementationOnce(yieldBashCommand(vol, (cmd) => (bashCmd = cmd)));
//   await transport(rootDir, vol.promises as unknown as typeof fsPromises, [
//     'sandbox1',
//     'export',
//     'locales/en.json',
//     `${rootDir}/access-config/access.json`,
//   ]);
//   expect(bashCmd!).toMatch(`npx pull "sandbox1.io" access-config
// npx pull "sandbox1.io" locales --name en`);
// });

it(
  'exports access-config',
  server.boundary(async () => {
    server.use(...tokenHandlers, getAccessConfig(1));
    mockFs({ ...stdLayout });
    const mockedSpawn = vi.mocked(spawn).mockImplementationOnce(() => mockObjectSelection(['access-config\n']));
    await transport(rootDir, null, mockedSpawn, ['sandbox1', 'export']);
    await vi.waitFor(() => {
      expect(jparse(readFileSync(`${rootDir}/access-config/access.json`, 'utf8'))).toEqual({ _id: 'access-config' });
    });
  }),
);

it(
  'imports access-config',
  server.boundary(async () => {
    server.use(...tokenHandlers, putAccessConfig(1));
    mockFs({ ...stdLayout, [`${rootDir}/access-config/access.json`]: jstr(accessConfig) });
    const mockedSpawn = vi.mocked(spawn).mockImplementationOnce(() => mockObjectSelection(['access-config\n']));
    await transport(rootDir, null, mockedSpawn, ['sandbox1', 'import']);
  }),
);

it(
  'exports locales',
  server.boundary(async () => {
    server.use(
      ...tokenHandlers,
      http.get(`https://sandbox1.io/openidm/config`, ({ request }) => {
        verifyBoxToken(1, request);
        return HttpResponse.json({ result: [{ _id: 'uilocale/en' }] });
      }),
      http.get(`https://sandbox1.io/openidm/config/uilocale/en`, ({ request }) => {
        verifyBoxToken(1, request);
        return HttpResponse.json({ content: 'foo' });
      }),
    );
    mockFs({ ...stdLayout, [`${rootDir}/locales/en.json`]: jstr({ _id: 'uilocale/en' }) });
    const mockedSpawn = vi.mocked(spawn).mockImplementationOnce(() => mockObjectSelection(['locale en\n']));
    await transport(rootDir, null, mockedSpawn, ['sandbox1', 'export']);
    await vi.waitFor(() => {
      expect(jparse(readFileSync(`${rootDir}/locales/en.json`, 'utf8'))).toEqual({ content: 'foo' });
    });
  }),
);

it(
  'imports locales',
  server.boundary(async () => {
    let uploadedAccessConfig: any;
    server.use(
      ...tokenHandlers,
      http.put(`https://sandbox1.io/openidm/config/uilocale/en`, async ({ request }) => {
        verifyBoxToken(1, request);
        uploadedAccessConfig = await request.json();
        return HttpResponse.json(uploadedAccessConfig);
      }),
    );
    mockFs({ ...stdLayout, [`${rootDir}/locales/en.json`]: jstr({ _id: 'uilocale/en' }) });
    const mockedSpawn = vi.mocked(spawn).mockImplementationOnce(() => mockObjectSelection(['locale en\n']));
    await transport(rootDir, null, mockedSpawn, ['sandbox1', 'import']);
    expect(uploadedAccessConfig).toEqual({ _id: 'uilocale/en' });
  }),
);
