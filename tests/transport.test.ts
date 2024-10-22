import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { Volume } from 'memfs';
import { homedir, tmpdir } from 'os';
import { dirname, join, normalize } from 'path';
import type fsPromises from 'fs/promises';
import { transport } from '../src/transport.js';

vi.mock('child_process');

const rootDir = normalize(join(dirname(__filename), '..'));
const stdLayout = {
  [tmpdir()]: null,
  [join(homedir(), '.frodo', 'Connections.json')]: JSON.stringify({
    'https://sandbox1.io/am': {},
    'https://sandbox2.io/am': {},
  }),
  [join(rootDir, 'locales')]: null,
};

let originalEditor: string | undefined;
let vol: ReturnType<(typeof Volume)['fromJSON']>;
let volFs: typeof fsPromises;

beforeEach(() => {
  originalEditor = process.env.EDITOR;
  process.env.EDITOR = 'vi';

  vol = Volume.fromJSON(stdLayout);
  volFs = vol.promises as unknown as typeof fsPromises;
});

afterEach(() => {
  if (originalEditor == null) {
    delete process.env.EDITOR;
  } else {
    process.env.EDITOR = originalEditor;
  }
  vi.resetAllMocks();
});

function pickOperation(name: 'Export Existing' | 'Import Existing' | 'Export New' | 'Open') {
  return ((command, options) => {
    expect(command).toBe('fzf');
    expect(options?.input).toBeTruthy();
    expect(options?.encoding).toBe('utf8');
    return (options!.input as string).split('\n').find((op) => op.includes(name));
  }) as typeof execSync;
}

function pickTenant(substring: string) {
  return ((command, options) => {
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

function pickObjects(...substrings: string[]) {
  return ((command, options) => {
    expect(command).toBe(`fzf --with-nth 2.. --multi --header='You can select multiple objects with Tab'`);
    expect(options?.input).toBeTruthy();
    expect(options?.encoding).toBe('utf8');
    const matchingOptions = (options!.input as string)
      .split('\n')
      .filter((opt) => substrings.some((substr) => opt.includes(substr)));
    if (!matchingOptions.length) {
      throw new Error(`No matching options found for [${substrings.join(', ')}]`);
    }
    return matchingOptions.join('\n') + '\n';
  }) as typeof execSync;
}

function editBashCommand(vol: ReturnType<(typeof Volume)['fromJSON']>, callback?: (_command: string) => string) {
  return ((command, _options) => {
    const tempfiles = vol.toJSON([tmpdir()]);
    const tempfilePath = Object.keys(tempfiles)[0];
    if (callback) {
      vol.writeFileSync(tempfilePath, callback(vol.readFileSync(tempfilePath).toString()));
    }
    expect(command).toBe(`vi ${tempfilePath}`);
    return '';
  }) as typeof execSync;
}

function yieldBashCommand(vol: ReturnType<(typeof Volume)['fromJSON']>, callback?: (_command: string) => void) {
  return ((command, _options) => {
    const tempfiles = vol.toJSON([tmpdir()]);
    const tempfilePath = Object.keys(tempfiles)[0];
    callback && callback(vol.readFileSync(tempfilePath).toString());
    expect(command).toBe(`bash ${tempfilePath}`);
    return '';
  }) as typeof execSync;
}

it('constructs a command to export a static configuration object from a tenant', async () => {
  let bashCmd: string;
  vi.mocked(execSync)
    .mockImplementationOnce(pickTenant('sandbox1'))
    .mockImplementationOnce(pickOperation('Export Existing'))
    .mockImplementationOnce(pickObjects('access-config'))
    .mockImplementationOnce(editBashCommand(vol))
    .mockImplementationOnce(yieldBashCommand(vol, (cmd) => (bashCmd = cmd)));
  await transport(rootDir, volFs, []);
  expect(bashCmd!).toBe(`#!/bin/bash

# Adjust the commands below as needed and save this file. Once closed this file will get executed as a bash script.
# If you want nothing executed then remove all commands, save, and close this file.

# Print each command before execution
set -x

npx pull "sandbox1.io" access-config
`);
});

it('constructs a command to import a static configuration object', async () => {
  let bashCmd: string;
  vi.mocked(execSync)
    .mockImplementationOnce(pickTenant('sandbox1'))
    .mockImplementationOnce(pickOperation('Import Existing'))
    .mockImplementationOnce(pickObjects('access-config'))
    .mockImplementationOnce(editBashCommand(vol))
    .mockImplementationOnce(yieldBashCommand(vol, (cmd) => (bashCmd = cmd)));
  await transport(rootDir, volFs, []);
  expect(bashCmd!).toMatch('npx push "sandbox1.io" access-config');
});

it('allows modifying the command before execution', async () => {
  let bashCmd: string;
  vi.mocked(execSync)
    .mockImplementationOnce(pickTenant('sandbox1'))
    .mockImplementationOnce(pickOperation('Export Existing'))
    .mockImplementationOnce(pickObjects('access-config'))
    .mockImplementationOnce(editBashCommand(vol, (cmd) => cmd.replace('npx', 'npx --dry-run')))
    .mockImplementationOnce(yieldBashCommand(vol, (cmd) => (bashCmd = cmd)));
  await transport(rootDir, volFs, []);
  expect(bashCmd!).toMatch('npx --dry-run pull "sandbox1.io" access-config');
});

it('defaults to nano editor', async () => {
  delete process.env.EDITOR;
  vi.mocked(execSync)
    .mockImplementationOnce(pickTenant('sandbox1'))
    .mockImplementationOnce(pickOperation('Export Existing'))
    .mockImplementationOnce(pickObjects('access-config'))
    .mockImplementationOnce((command, _options) => {
      expect(command.split(' ')[0]).toBe(`nano`);
      return '';
    })
    .mockImplementationOnce(yieldBashCommand(vol));
  await transport(rootDir, volFs, []);
});

it('accepts tenant as a command line argument', async () => {
  let bashCmd: string;
  vi.mocked(execSync)
    // 'sandbox2' selected by command line argument.
    .mockImplementationOnce(pickOperation('Export Existing'))
    .mockImplementationOnce(pickObjects('access-config'))
    .mockImplementationOnce(editBashCommand(vol))
    .mockImplementationOnce(yieldBashCommand(vol, (cmd) => (bashCmd = cmd)));
  await transport(rootDir, volFs, ['sandbox2']);
  expect(bashCmd!).toMatch('npx pull "sandbox2.io" access-config');
});

it('fails if tenant not recognised', async () => {
  await expect(transport(rootDir, volFs, ['sandbox666'])).rejects.toThrow('No tenants match sandbox666');
});

it('fails if multiple tenants matched', async () => {
  await expect(transport(rootDir, vol.promises as unknown as typeof fsPromises, ['sand'])).rejects.toThrow(
    'Multiple tenants match sand: sandbox1.io, sandbox2.io',
  );
});

it('accepts operation as a command line argument', async () => {
  let bashCmd: string;
  vi.mocked(execSync)
    // 'import' selected by command line argument.
    .mockImplementationOnce(pickObjects('access-config'))
    .mockImplementationOnce(editBashCommand(vol))
    .mockImplementationOnce(yieldBashCommand(vol, (cmd) => (bashCmd = cmd)));
  await transport(rootDir, vol.promises as unknown as typeof fsPromises, ['sandbox1', 'import']);
  expect(bashCmd!).toMatch('npx push "sandbox1.io" access-config');
});

it('fails if operation not recognised', async () => {
  await expect(transport(rootDir, volFs, ['sandbox1', 'transmute'])).rejects.toThrow('Unsupported operation transmute');
});

it('accepts filenames as command line arguments, and performs operations without verification', async () => {
  const vol = Volume.fromJSON({
    ...stdLayout,
    [`${rootDir}/locales/en.json`]: JSON.stringify({ _id: 'uilocale/en' }),
    [`${rootDir}/locales/de.json`]: JSON.stringify({ _id: 'uilocale/de' }),
  });
  let bashCmd: string;
  vi.mocked(execSync).mockImplementationOnce(yieldBashCommand(vol, (cmd) => (bashCmd = cmd)));
  await transport(rootDir, vol.promises as unknown as typeof fsPromises, [
    'sandbox1',
    'export',
    'locales/en.json',
    `${rootDir}/access-config/access.json`,
  ]);
  expect(bashCmd!).toMatch(`npx pull "sandbox1.io" access-config
npx pull "sandbox1.io" locales --name en`);
});

it('processes access-config', async () => {
  let bashCmd: string;

  vi.mocked(execSync)
    .mockImplementationOnce(pickTenant('sandbox1'))
    .mockImplementationOnce(pickOperation('Export Existing'))
    .mockImplementationOnce(pickObjects('access-config'))
    .mockImplementationOnce(editBashCommand(vol))
    .mockImplementationOnce(yieldBashCommand(vol, (cmd) => (bashCmd = cmd)));
  await transport(rootDir, volFs, []);
  expect(bashCmd!).toMatch('npx pull "sandbox1.io" access-config');

  vi.mocked(execSync)
    .mockImplementationOnce(pickTenant('sandbox1'))
    .mockImplementationOnce(pickOperation('Import Existing'))
    .mockImplementationOnce(pickObjects('access-config'))
    .mockImplementationOnce(editBashCommand(vol))
    .mockImplementationOnce(yieldBashCommand(vol, (cmd) => (bashCmd = cmd)));
  await transport(rootDir, volFs, []);
  expect(bashCmd!).toMatch('npx push "sandbox1.io" access-config');
});

it('processes locales', async () => {
  const vol = Volume.fromJSON({
    ...stdLayout,
    [`${rootDir}/locales/en.json`]: JSON.stringify({ _id: 'uilocale/en' }),
    [`${rootDir}/locales/de.json`]: JSON.stringify({ _id: 'uilocale/de' }),
  });
  let bashCmd: string;

  vi.mocked(execSync)
    .mockImplementationOnce(pickTenant('sandbox1'))
    .mockImplementationOnce(pickOperation('Export Existing'))
    .mockImplementationOnce(pickObjects('locale en', 'locale de'))
    .mockImplementationOnce(editBashCommand(vol))
    .mockImplementationOnce(yieldBashCommand(vol, (cmd) => (bashCmd = cmd)));
  await transport(rootDir, vol.promises as unknown as typeof fsPromises, []);
  expect(bashCmd!).toMatch(`npx pull "sandbox1.io" locales --name de
npx pull "sandbox1.io" locales --name en`);

  vi.mocked(execSync)
    .mockImplementationOnce(pickTenant('sandbox1'))
    .mockImplementationOnce(pickOperation('Import Existing'))
    .mockImplementationOnce(pickObjects('locale en', 'locale de'))
    .mockImplementationOnce(editBashCommand(vol))
    .mockImplementationOnce(yieldBashCommand(vol, (cmd) => (bashCmd = cmd)));
  await transport(rootDir, vol.promises as unknown as typeof fsPromises, []);
  expect(bashCmd!).toMatch(`npx push "sandbox1.io" locales --name de
npx push "sandbox1.io" locales --name en`);
});
